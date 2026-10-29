package proxy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"html"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Artifacts on their own origin. An HTML artifact (a "page" an agent made
// with `berthd artifact add`) runs at
//
//	http://art-<id>.<box>.localhost:1377/
//
// one origin per artifact, answered by the proxy itself from the box's
// artifact store (over the laptop's own paired channel, Proxy.Artifact):
// nothing is forwarded to a dev server, no cookie is read or set, and none
// of the Preview machinery (preview.go) applies. The art- prefix is kept
// from location and worktree names on the box, so these hosts mean
// nothing else.
//
// Two documents:
//
//   - "/" is the shell, Terminal's own few lines: it frames the page and
//     forwards the app's theme messages to it. Its policy lets it frame
//     only this origin's /v/ pages, so a page that navigates itself
//     anywhere else (location = "https://…?data") is stopped by the
//     shell's frame-src. The app frames the shell.
//   - "/v/<n>" (or /v/latest) is the page, under a sandbox (an opaque
//     origin: no storage, no cookies, nothing of the app's), with no
//     network: connect-src, img-src, font-src and media-src allow only
//     data: and blob:, forms and frames are off, and scripts are inline
//     or from /_lib/ on its own origin. A small script goes first in its
//     <head>: the theme from the URL's fragment, and WebRTC removed.
//
// /_lib/ serves a few pinned libraries (Chart.js, d3, …) that the proxy
// fetches by their exact CDN URL and checks against a hash. A page that
// names one of those CDN URLs is pointed here instead, so a page reaches
// no CDN at all: a query string it adds goes nowhere but this proxy.

// ArtifactFunc fetches an artifact version's content from a box: GET
// /v1/artifacts/{id}/v/{version}.
type ArtifactFunc func(ctx context.Context, box, id, version string) (*http.Response, error)

// AppOrigins are the origins Terminal's app runs on, which alone may frame an
// artifact: the bundled app, and the dev server's ports (1420–1439).
var AppOrigins = func() []string {
	out := []string{"tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"}
	for p := 1420; p <= 1439; p++ {
		out = append(out, "http://localhost:"+strconv.Itoa(p))
	}
	return out
}()

const artPrefix = "art-"

var artIDRe = regexp.MustCompile(`^[0-9a-f]{10}$`)

// artTarget reads an artifact host, art-<id>.<box>.localhost[:port].
func (p *Proxy) artTarget(host string) (box, id string, ok bool) {
	labels, ok := localhostLabels(host)
	if !ok || len(labels) != 2 || !strings.HasPrefix(labels[0], artPrefix) {
		return "", "", false
	}
	id = strings.TrimPrefix(labels[0], artPrefix)
	labels = p.pairedLabels(labels)
	return labels[1], id, true
}

// IsArtifactHost says host is an artifact's own origin.
func IsArtifactHost(host string) bool {
	labels, ok := localhostLabels(host)
	return ok && len(labels) == 2 && strings.HasPrefix(labels[0], artPrefix)
}

// serveArtifact answers a request to an artifact's origin.
func (p *Proxy) serveArtifact(w http.ResponseWriter, r *http.Request, box, id string) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.Set("Allow", "GET, HEAD")
		artText(w, http.StatusMethodNotAllowed, "An artifact is only read.")
		return
	}
	if !artIDRe.MatchString(id) || p.Artifact == nil {
		artText(w, http.StatusNotFound, "No such artifact.")
		return
	}
	origin := "http://" + strings.ToLower(r.Host)
	path := r.URL.Path
	switch {
	case path == "/":
		v := r.URL.Query().Get("v")
		if v == "" {
			v = "latest"
		}
		if v != "latest" {
			if n, err := strconv.Atoi(v); err != nil || n < 1 {
				artText(w, http.StatusBadRequest, "A version is a number from 1, or latest.")
				return
			}
		}
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Content-Security-Policy", ShellPolicy(origin))
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", artPermissions)
		io.WriteString(w, shellDoc(v))
	case strings.HasPrefix(path, "/v/"):
		v := strings.TrimPrefix(path, "/v/")
		if v != "latest" {
			if n, err := strconv.Atoi(v); err != nil || n < 1 {
				artText(w, http.StatusNotFound, "No such version.")
				return
			}
		}
		p.artifactPage(w, r, box, id, v, origin)
	case strings.HasPrefix(path, "/_lib/"):
		p.artifactLib(w, r, strings.TrimPrefix(path, "/_lib/"))
	default:
		artText(w, http.StatusNotFound, "Not part of this artifact.")
	}
}

func (p *Proxy) artifactPage(w http.ResponseWriter, r *http.Request, box, id, v, origin string) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	resp, err := p.Artifact(ctx, box, id, v)
	if err != nil {
		artText(w, http.StatusBadGateway, "The box didn't answer: "+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		artText(w, resp.StatusCode, "The box has no such artifact or version.")
		return
	}
	if resp.Header.Get("X-Berth-Artifact-Kind") != "page" {
		// Data artifacts are drawn by the app, never served as a page.
		artText(w, http.StatusNotFound, "This artifact isn't a page.")
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		artText(w, http.StatusBadGateway, "The box stopped answering.")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", PagePolicy(origin))
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Permissions-Policy", artPermissions)
	w.Write(ArtifactPageBody(body))
}

// artPermissions turns off the powerful features a page could ask for.
const artPermissions = "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=(), fullscreen=(), publickey-credentials-get=(), screen-wake-lock=()"

// PagePolicy is a page's Content-Security-Policy on origin.
func PagePolicy(origin string) string {
	return strings.Join([]string{
		"sandbox allow-scripts",
		"default-src 'none'",
		"script-src 'unsafe-inline' 'unsafe-eval' " + origin + "/_lib/",
		"style-src 'unsafe-inline'",
		"img-src data: blob:",
		"font-src data:",
		"media-src data: blob:",
		"connect-src 'none'",
		"frame-src 'none'",
		"child-src 'none'",
		"worker-src 'none'",
		"manifest-src 'none'",
		"object-src 'none'",
		"form-action 'none'",
		"base-uri 'none'",
		"frame-ancestors " + origin + " " + strings.Join(AppOrigins, " "),
		// CSP3's WebRTC switch, honoured where a browser has it; the
		// page script removes the constructors everywhere else.
		"webrtc 'block'",
	}, "; ")
}

// ShellPolicy is the shell's: its own script, and frames of this origin's
// pages only.
func ShellPolicy(origin string) string {
	return strings.Join([]string{
		"default-src 'none'",
		"script-src " + shellHash,
		"style-src 'unsafe-inline'",
		"frame-src " + origin + "/v/",
		"connect-src 'none'",
		"form-action 'none'",
		"base-uri 'none'",
		"frame-ancestors " + strings.Join(AppOrigins, " "),
	}, "; ")
}

func artText(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.WriteHeader(status)
	io.WriteString(w, msg+"\n")
}

// The shell's script: the page at the version asked, with the theme in its
// fragment, and the app's theme messages passed on. Nothing comes back up.
const shellScript = `(function(){var f=document.getElementById("page"),v=document.documentElement.getAttribute("data-v")||"latest";f.src="/v/"+v+location.hash;addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.berth==="theme"&&f.contentWindow)f.contentWindow.postMessage(e.data,"*")})})();`

var shellHash = func() string {
	sum := sha256.Sum256([]byte(shellScript))
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}()

func shellDoc(v string) string {
	return `<!doctype html><html data-v="` + html.EscapeString(v) + `"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer">` +
		`<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%;background:transparent}</style></head>` +
		`<body><iframe id="page" title="Artifact" sandbox="allow-scripts" referrerpolicy="no-referrer" allow=""></iframe><script>` + shellScript + `</script></body></html>`
}

// pageScript goes first in a page's <head>: the theme from the fragment
// (#berth=<JSON>), the app's later theme messages, and no WebRTC (it is
// outside CSP's connect-src).
const pageScript = `(function(){var w=window,d=document;` +
	`["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCIceTransport","RTCSctpTransport","RTCRtpSender","RTCRtpReceiver"].forEach(function(k){try{Object.defineProperty(w,k,{value:undefined,writable:false,configurable:false})}catch(e){}});` +
	`try{["contentWindow","contentDocument"].forEach(function(k){var o=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,k);Object.defineProperty(HTMLIFrameElement.prototype,k,{configurable:false,get:function(){var x=o.get.call(this);try{var cw=k==="contentWindow"?x:x&&x.defaultView;if(cw){cw.RTCPeerConnection=undefined;cw.webkitRTCPeerConnection=undefined}}catch(e){}return x}})})}catch(e){}` +
	`var ok=/^--(berth|chart)-[a-z0-9-]{1,40}$/,bad=/[;{}<>\\]/;` +
	`function apply(t){if(!t||typeof t!=="object")return;var v=t.vars||{},css=":root{";for(var k in v){var x=String(v[k]);if(ok.test(k)&&x.length<200&&!bad.test(x))css+=k+":"+x+";"}var s=t.scheme==="light"?"light":"dark";css+="color-scheme:"+s+"}";var el=d.getElementById("berth-theme");if(!el){el=d.createElement("style");el.id="berth-theme";(d.head||d.documentElement).insertBefore(el,(d.head||d.documentElement).firstChild)}el.textContent=css;var m=d.querySelector('meta[name="color-scheme"]');if(m)m.setAttribute("content",s)}` +
	`try{var h=location.hash.match(/[#&]berth=([^&]*)/);if(h)apply(JSON.parse(decodeURIComponent(h[1])))}catch(e){}` +
	`w.addEventListener("message",function(e){if(e.source===w.parent&&e.data&&e.data.berth==="theme")apply(e.data)})})();`

// pageHead is what a page gets first: the script, a colour scheme, and a
// quiet default surface the page's own styles override.
const pageHead = `<meta name="color-scheme" content="dark"><script data-berth>` + pageScript + `</script>` +
	`<style data-berth>:where(html){background:var(--berth-bg,Canvas);color:var(--berth-fg,CanvasText);font-family:var(--berth-font,system-ui,sans-serif)}</style>`

var headTag = regexp.MustCompile(`(?i)<head(\s[^>]*)?>`)

// ArtifactPageBody is a page as served: the head first, and the pinned
// libraries' CDN addresses pointed at /_lib/.
func ArtifactPageBody(body []byte) []byte {
	for _, l := range artLibs {
		for _, u := range l.aliases {
			body = bytes.ReplaceAll(body, []byte(u), []byte("/_lib/"+l.path))
		}
	}
	if loc := headTag.FindIndex(firstN(body, 64<<10)); loc != nil {
		out := make([]byte, 0, len(body)+len(pageHead))
		out = append(out, body[:loc[1]]...)
		out = append(out, pageHead...)
		return append(out, body[loc[1]:]...)
	}
	return append([]byte(pageHead), body...)
}

func firstN(b []byte, n int) []byte {
	if len(b) > n {
		return b[:n]
	}
	return b
}

// artLib is a library a page may load: fetched from fetch, checked
// against sha256, and the CDN addresses that mean it.
type artLib struct {
	path    string // under /_lib/
	fetch   string
	sha256  string
	aliases []string
}

func jsdelivr(pkg, ver, file, cdnjsName, cdnjsFile, sum string) artLib {
	p := pkg + "@" + ver + "/" + file
	l := artLib{path: p, fetch: "https://cdn.jsdelivr.net/npm/" + p, sha256: sum, aliases: []string{"https://cdn.jsdelivr.net/npm/" + p, "https://unpkg.com/" + p}}
	if cdnjsName != "" {
		l.aliases = append(l.aliases, "https://cdnjs.cloudflare.com/ajax/libs/"+cdnjsName+"/"+ver+"/"+cdnjsFile)
	}
	return l
}

// artLibs are the libraries pages may use, by exact version and file.
// Adding one: its jsDelivr address and the sha256 of what it serves.
var artLibs = []artLib{
	jsdelivr("chart.js", "4.4.1", "dist/chart.umd.js", "Chart.js", "chart.umd.js", "74401d738dd3e03ee5dfb3b6841210fe2c4ead8a960c4011ca4ba0b78a9fd8f3"),
	jsdelivr("d3", "7.9.0", "dist/d3.min.js", "d3", "d3.min.js", "f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539"),
	jsdelivr("alpinejs", "3.14.1", "dist/cdn.min.js", "alpinejs", "cdn.min.js", "358d9afbb1ab5befa2f48061a30776e5bcd7707f410a606ba985f98bc3b1c034"),
	jsdelivr("echarts", "5.5.0", "dist/echarts.min.js", "echarts", "echarts.min.js", "42f8329d989b6f6539dd2b15bbdf0d82025762ac112fbb60dc57b27d7bcf3946"),
	jsdelivr("three", "0.160.0", "build/three.min.js", "three.js", "three.min.js", "170c6789f43217c96b3170f4b42fafe135de7f7cd48497a4218f9757ee1d49fa"),
	jsdelivr("marked", "12.0.2", "marked.min.js", "marked", "marked.min.js", "15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894"),
}

// ArtifactLibraries are the CDN addresses a page may name, one per
// library (for the skill and docs).
func ArtifactLibraries() []string {
	var out []string
	for _, l := range artLibs {
		out = append(out, l.aliases[0])
	}
	return out
}

type libCache struct {
	mu   sync.Mutex
	got  map[string][]byte
	busy map[string]*sync.Mutex
}

func (p *Proxy) artifactLib(w http.ResponseWriter, r *http.Request, path string) {
	var lib *artLib
	for i := range artLibs {
		if artLibs[i].path == path {
			lib = &artLibs[i]
		}
	}
	if lib == nil {
		artText(w, http.StatusNotFound, "Not a library pages may load.")
		return
	}
	body, err := p.libs.get(r.Context(), *lib, p.LibFetch)
	if err != nil {
		artText(w, http.StatusBadGateway, err.Error())
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/javascript; charset=utf-8")
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	// The page is an opaque origin: it loads this cross-origin.
	h.Set("Cross-Origin-Resource-Policy", "cross-origin")
	w.Write(body)
}

func (c *libCache) get(ctx context.Context, l artLib, fetch func(ctx context.Context, url string) ([]byte, error)) ([]byte, error) {
	c.mu.Lock()
	if c.got == nil {
		c.got, c.busy = map[string][]byte{}, map[string]*sync.Mutex{}
	}
	if b, ok := c.got[l.path]; ok {
		c.mu.Unlock()
		return b, nil
	}
	m := c.busy[l.path]
	if m == nil {
		m = &sync.Mutex{}
		c.busy[l.path] = m
	}
	c.mu.Unlock()
	m.Lock()
	defer m.Unlock()
	c.mu.Lock()
	if b, ok := c.got[l.path]; ok {
		c.mu.Unlock()
		return b, nil
	}
	c.mu.Unlock()
	if fetch == nil {
		fetch = fetchLib
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	b, err := fetch(ctx, l.fetch)
	if err != nil {
		return nil, fmt.Errorf("couldn't fetch %s: %v", l.path, err)
	}
	sum := sha256.Sum256(b)
	if hex.EncodeToString(sum[:]) != l.sha256 {
		return nil, fmt.Errorf("%s isn't what Terminal pinned (its hash differs); not served", l.path)
	}
	c.mu.Lock()
	c.got[l.path] = b
	c.mu.Unlock()
	return b, nil
}

func fetchLib(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 8<<20))
}
