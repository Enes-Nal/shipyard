package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const artHost = "art-0123456789.devl.localhost:1377"

const hostilePage = `<!doctype html><html><head><title>Reindex</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>
<script src="https://cdn.jsdelivr.net/npm/evil-pkg@1.0.0/x.js"></script></head>
<body><script>fetch("http://127.0.0.1:1378/v1/state")</script></body></html>`

// fakeBox answers artifact fetches as a box does, recording what it was
// asked; it also tries to set a cookie, which must never get through.
type fakeBox struct {
	calls []string
	kind  string
	body  string
}

func (f *fakeBox) fetch(_ context.Context, box, id, version string) (*http.Response, error) {
	f.calls = append(f.calls, box+"/"+id+"/"+version)
	if id != "0123456789" {
		return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("no such artifact")), Header: http.Header{}}, nil
	}
	h := http.Header{"X-Berth-Artifact-Kind": {f.kind}, "Set-Cookie": {"box=secret"}, "Content-Type": {"text/plain; charset=utf-8"}}
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(f.body)), Header: h}, nil
}

func artProxy(f *fakeBox) (*Proxy, *int) {
	dials := 0
	p := newProxy()
	p.Dialer = func(box string) (DialFunc, bool) {
		dials++
		return func(ctx context.Context, port int) (net.Conn, error) {
			return nil, errors.New("no dev server for artifacts")
		}, true
	}
	p.Artifact = f.fetch
	p.LibFetch = func(ctx context.Context, url string) ([]byte, error) {
		if strings.Contains(url, "chart.js@4.4.1") {
			return []byte("tampered"), nil
		}
		return nil, errors.New("offline")
	}
	return p, &dials
}

func TestArtifactPageIsServedOnItsOwnOriginUnderAStrictPolicy(t *testing.T) {
	f := &fakeBox{kind: "page", body: hostilePage}
	p, dials := artProxy(f)
	resp := get(t, p, artHost, "/v/3", http.Header{"Cookie": {"session=laptop"}, "Sec-Fetch-Dest": {"iframe"}})
	body := read(t, resp)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	if len(f.calls) != 1 || f.calls[0] != "devl/0123456789/3" {
		t.Fatalf("box asked %v", f.calls)
	}
	if *dials != 0 {
		t.Fatalf("an artifact host dialled a box port %d times", *dials)
	}
	h := resp.Header
	if got := h.Values("Set-Cookie"); len(got) != 0 {
		t.Fatalf("a cookie got through: %v", got)
	}
	csp := h.Get("Content-Security-Policy")
	for _, want := range []string{
		"sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'",
		"img-src data: blob:", "font-src data:", "base-uri 'none'", "webrtc 'block'",
		"script-src 'unsafe-inline' 'unsafe-eval' http://" + artHost + "/_lib/;",
		"frame-ancestors http://" + artHost + " tauri://localhost http://tauri.localhost https://tauri.localhost http://localhost:1420",
	} {
		if !strings.Contains(csp, want) {
			t.Errorf("policy lacks %q:\n%s", want, csp)
		}
	}
	// No sandbox flag that would give the page an origin, forms, popups or navigation.
	for _, never := range []string{"allow-same-origin", "allow-forms", "allow-popups", "allow-top-navigation", "allow-modals", "localhost:*"} {
		if strings.Contains(csp, never) {
			t.Errorf("policy has %q", never)
		}
	}
	// Nor a wildcard or a whole scheme as a source.
	for _, tok := range strings.Fields(strings.ReplaceAll(csp, ";", " ")) {
		if tok == "*" || tok == "https:" || tok == "http:" || tok == "ws:" || tok == "wss:" {
			t.Errorf("policy allows %q", tok)
		}
	}
	for k, want := range map[string]string{
		"Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
		"Cache-Control": "no-store", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin",
	} {
		if got := h.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if !strings.Contains(h.Get("Permissions-Policy"), "camera=()") {
		t.Errorf("Permissions-Policy = %q", h.Get("Permissions-Policy"))
	}
	// The page script comes first in <head>, then the page's own.
	head := strings.Index(body, "<head>")
	if head < 0 || !strings.HasPrefix(body[head+len("<head>"):], `<meta name="color-scheme" content="dark"><script data-berth>`) {
		t.Fatalf("page script not first in head:\n%.300s", body)
	}
	if !strings.Contains(body, `Object.defineProperty(w,k,{value:undefined`) {
		t.Error("WebRTC isn't removed")
	}
	// A pinned library's CDN address points at the origin's own /_lib/;
	// anything else stays, and the policy blocks it.
	if !strings.Contains(body, `src="/_lib/chart.js@4.4.1/dist/chart.umd.js"`) || strings.Contains(body, "cdn.jsdelivr.net/npm/chart.js") {
		t.Errorf("chart.js not pointed at /_lib/")
	}
	if !strings.Contains(body, "https://cdn.jsdelivr.net/npm/evil-pkg@1.0.0/x.js") {
		t.Errorf("an unpinned script was rewritten")
	}
}

func TestArtifactShellFramesOnlyItsOwnPages(t *testing.T) {
	p, _ := artProxy(&fakeBox{kind: "page", body: "<p>hi</p>"})
	resp := get(t, p, artHost, "/?v=2", nil)
	body := read(t, resp)
	csp := resp.Header.Get("Content-Security-Policy")
	sum := sha256.Sum256([]byte(shellScript))
	hash := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	for _, want := range []string{"script-src " + hash, "frame-src http://" + artHost + "/v/", "connect-src 'none'", "frame-ancestors tauri://localhost"} {
		if !strings.Contains(csp, want) {
			t.Errorf("shell policy lacks %q: %s", want, csp)
		}
	}
	if strings.Contains(csp, "unsafe-inline' ") && strings.Contains(csp, "script-src 'unsafe-inline'") {
		t.Error("the shell allows inline scripts")
	}
	if !strings.Contains(body, `data-v="2"`) || !strings.Contains(body, "<script>"+shellScript+"</script>") || !strings.Contains(body, `sandbox="allow-scripts"`) {
		t.Fatalf("shell = %s", body)
	}
	if got := get(t, p, artHost, "/?v=x", nil); got.StatusCode != 400 {
		t.Errorf("bad version: %d", got.StatusCode)
	}
}

func TestArtifactOriginRefusesEverythingElse(t *testing.T) {
	f := &fakeBox{kind: "chart", body: `{"$schema":"berth.chart/v1"}`}
	p, dials := artProxy(f)
	for _, c := range []struct {
		host, path string
		status     int
	}{
		{artHost, "/v/1", 404},                           // a chart isn't a page
		{artHost, "/v1/boxes/devl/api/sessions", 404},    // not the laptop agent's API
		{artHost, "/v/0", 404},                           // no version 0
		{artHost, "/_lib/evil-pkg@1.0.0/x.js", 404},      // not a pinned library
		{"art-zzz.devl.localhost:1377", "/v/1", 404},     // not an id
		{"art-9999999999.devl.localhost:1377", "/", 200}, // the shell; its page 404s
		{"art-9999999999.devl.localhost:1377", "/v/1", 404},
	} {
		resp := get(t, p, c.host, c.path, nil)
		if resp.StatusCode != c.status {
			t.Errorf("%s%s = %d, want %d", c.host, c.path, resp.StatusCode, c.status)
		}
		if len(resp.Header.Values("Set-Cookie")) != 0 {
			t.Errorf("%s%s set a cookie", c.host, c.path)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "http://"+artHost+"/v/1", strings.NewReader("x"))
	req.Host = artHost
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)
	if rec.Code != 405 {
		t.Errorf("POST = %d", rec.Code)
	}
	if *dials != 0 {
		t.Errorf("dialled a box port %d times", *dials)
	}
	// Without the agent's artifact fetch (the box's own browser proxy),
	// these hosts answer nothing.
	bare := newProxy()
	if resp := get(t, bare, artHost, "/v/1", nil); resp.StatusCode != 404 {
		t.Errorf("no fetcher: %d", resp.StatusCode)
	}
}

func TestArtifactLibrariesArePinned(t *testing.T) {
	p, _ := artProxy(&fakeBox{kind: "page"})
	// A library whose bytes differ from the pin is not served.
	resp := get(t, p, artHost, "/_lib/chart.js@4.4.1/dist/chart.umd.js?leak=data", nil)
	if resp.StatusCode != 502 || !strings.Contains(read(t, resp), "isn't what Terminal pinned") {
		t.Fatalf("tampered library: %d", resp.StatusCode)
	}
	// The right bytes are, from the canonical address, whatever the query.
	want := []byte("/* d3 */")
	sum := sha256.Sum256(want)
	var asked []string
	p.LibFetch = func(ctx context.Context, url string) ([]byte, error) { asked = append(asked, url); return want, nil }
	saved := artLibs
	t.Cleanup(func() { artLibs = saved })
	artLibs = []artLib{jsdelivr("d3", "7.9.0", "dist/d3.min.js", "", "", hexOf(sum[:]))}
	for i := 0; i < 2; i++ {
		resp = get(t, p, artHost, "/_lib/d3@7.9.0/dist/d3.min.js?x="+strings.Repeat("a", i), nil)
		if resp.StatusCode != 200 || read(t, resp) != string(want) || resp.Header.Get("Content-Type") != "text/javascript; charset=utf-8" {
			t.Fatalf("library: %d", resp.StatusCode)
		}
	}
	if len(asked) != 1 || asked[0] != "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js" {
		t.Fatalf("fetched %v; want the canonical address once", asked)
	}
}

func TestArtifactHostsArentWorktrees(t *testing.T) {
	p := newProxy()
	p.Worktree = func(labels []string) (string, int, bool) {
		t.Fatalf("an art- host was read as a worktree: %v", labels)
		return "", 0, false
	}
	if resp := get(t, p, artHost, "/", nil); resp.StatusCode != 404 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if !IsArtifactHost(artHost) || IsArtifactHost("art-0123456789.shop.devl.localhost:1377") || IsArtifactHost("web.devl.localhost") {
		t.Fatal("IsArtifactHost")
	}
}

func hexOf(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, digits[c>>4], digits[c&15])
	}
	return string(out)
}

// The e2e suite serves artifact pages with exactly these headers and
// documents (app/src/lib/art/origin.gen.json, which the app also uses for its mock frames), to check in a real browser that a
// hostile page can't reach the app or the network. It must match what the
// proxy sends: BERTH_UPDATE_FIXTURES=1 rewrites it.
func TestArtifactOriginFixtureIsCurrent(t *testing.T) {
	const origin = "http://ORIGIN"
	fixture := map[string]any{
		"shellPolicy": ShellPolicy(origin),
		"pagePolicy":  PagePolicy(origin),
		"permissions": artPermissions,
		"shellDoc":    shellDoc("VERSION"),
		"pageHead":    pageHead,
		"libraries":   ArtifactLibraries(),
	}
	want, _ := json.MarshalIndent(fixture, "", "  ")
	want = append(want, '\n')
	path := filepath.Join("..", "..", "app", "src", "lib", "art", "origin.gen.json")
	if os.Getenv("BERTH_UPDATE_FIXTURES") != "" {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (BERTH_UPDATE_FIXTURES=1 go test ./internal/proxy writes it)", err)
	}
	if string(got) != string(want) {
		t.Fatalf("%s is out of date: BERTH_UPDATE_FIXTURES=1 go test ./internal/proxy -run Fixture", path)
	}
}
