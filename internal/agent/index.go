package agent

import (
	"fmt"
	"html"
	"net/http"
	"strconv"
	"strings"

	"github.com/cosscom/shipyard/internal/proxy"
)

// serveIndex lists what the proxy can reach, at plain http://localhost:1377/.
func (a *Agent) serveIndex(w http.ResponseWriter, r *http.Request) {
	s := a.status()
	port := ":" + strconv.Itoa(s.Proxy.URLPort)
	if s.Proxy.URLPort == 80 {
		port = ""
	}
	var b strings.Builder
	b.WriteString(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Terminal</title>` + proxy.PageStyle + `<body><h1>Terminal</h1>`)
	if len(s.Boxes) == 0 {
		b.WriteString(`<p>No paired boxes. Run <code>berthd pair</code> on a box, then <code>berth pair '&lt;link&gt;'</code>.</p>`)
	}
	for _, box := range s.Boxes {
		fmt.Fprintf(&b, `<h2>%s <small>%s</small></h2>`,
			html.EscapeString(box.Name), html.EscapeString(box.State))
		example := fmt.Sprintf("http://3000.%s.localhost%s/", box.Name, port)
		fmt.Fprintf(&b, `<p>Any port on this box: <a href="%s">%s</a></p>`, html.EscapeString(example), html.EscapeString(example))
	}
	if len(s.Forwards) > 0 {
		b.WriteString(`<h2>Forwards</h2><ul>`)
		for _, f := range s.Forwards {
			fmt.Fprintf(&b, `<li>localhost:%d → %s:%d <small>%s</small></li>`,
				f.Local, html.EscapeString(f.Box), f.Remote, html.EscapeString(f.State))
		}
		b.WriteString(`</ul>`)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, b.String())
}
