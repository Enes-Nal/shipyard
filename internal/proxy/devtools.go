package proxy

import (
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
)

// The Browser tab's Console drawer reads the page's console through a small
// script, devtools.js. In the Terminal app the page is a native webview, which
// runs the script itself (src-tauri/src/browser.rs includes this same
// file). Where the page is an iframe instead (a plain browser, or the native
// view failed), the app asks for the page with ?__berth_devtools=1 and
// names the frame berth-devtools:<pane>, and the proxy puts the script in:
// the flag comes off before the dev server sees the request, the script
// takes it off the page's address, and it posts what the page logs to the
// app, its parent. Only that request gets the script, so a link followed in
// the frame shows a page without it until the tab reloads.

// DevtoolsParam is the query parameter that asks for the console script.
const DevtoolsParam = "__berth_devtools"

//go:embed devtools.js
var devtoolsSource string

var (
	devtoolsJS   = stripComments(devtoolsSource)
	devtoolsTag  = []byte("<script data-berth-devtools>" + devtoolsJS + "</script>")
	devtoolsHash = func() string {
		sum := sha256.Sum256([]byte(devtoolsJS))
		return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	}()
)

// DevtoolsScript is the console script as a page gets it.
func DevtoolsScript() string { return devtoolsJS }

// devtoolsPage reports whether a request is a Browser tab frame's page that
// asked for the console script.
func devtoolsPage(r *http.Request) bool {
	if r.Method != http.MethodGet || !r.URL.Query().Has(DevtoolsParam) {
		return false
	}
	dest := r.Header.Get("Sec-Fetch-Dest")
	return dest == "" || dest == "iframe"
}

// devtoolsRequest readies a flagged page's request: the flag off, and the
// page whole and plain for the script to go in.
func devtoolsRequest(out *http.Request) {
	stripDevtoolsParam(out.URL)
	out.Header.Set("Accept-Encoding", "identity")
	out.Header.Del("If-None-Match")
	out.Header.Del("If-Modified-Since")
}

// devtoolsResponse puts the script into a flagged page, and lets the page be
// framed and run it, as a Preview frame's page is.
func devtoolsResponse(resp *http.Response) {
	resp.Header.Del("X-Frame-Options")
	for _, name := range []string{"Content-Security-Policy", "Content-Security-Policy-Report-Only"} {
		values := resp.Header.Values(name)
		if len(values) == 0 {
			continue
		}
		resp.Header.Del(name)
		for _, v := range values {
			if v = scriptPolicy(v, devtoolsHash); v != "" {
				resp.Header.Add(name, v)
			}
		}
	}
	if isHTML(resp) {
		injectScript(resp, devtoolsTag)
	}
}

func stripDevtoolsParam(u *url.URL) {
	if !strings.Contains(u.RawQuery, DevtoolsParam) {
		return
	}
	q := u.Query()
	q.Del(DevtoolsParam)
	u.RawQuery = q.Encode()
}
