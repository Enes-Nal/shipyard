package agent

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/pairing"
	"github.com/cosscom/shipyard/internal/trust"
)

// The app's "Add another computer" and "I already use Terminal on another
// computer": berth invite and berth join, run by the agent like the rest of
// box management. The join link goes to the CLI on its stdin, never in its
// arguments, where other users of this computer could read it in ps.

func (a *Agent) joinRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/invite", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Boxes []string `json:"boxes"`
			For   string   `json:"for"`
		}
		if !decodeBody(w, r, &req) {
			return
		}
		for _, b := range req.Boxes {
			if !trust.ValidName(b) {
				writeError(w, http.StatusBadRequest, "not a box name: "+b)
				return
			}
		}
		if req.For != "" && !trust.ValidName(req.For) {
			req.For = ""
		}
		// The app asked the person first ("This lets another computer
		// control …"), so the CLI does not.
		args := []string{"invite", "--json", "--yes"}
		if len(req.Boxes) > 0 {
			args = append(args, "--boxes", strings.Join(req.Boxes, ","))
		}
		if req.For != "" {
			args = append(args, "--for", req.For)
		}
		a.runJSON(w, r, args...)
	})
	join := func(check bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var req struct {
				Link string `json:"link"`
			}
			if !decodeBody(w, r, &req) {
				return
			}
			// Whatever was pasted, only the link goes on.
			link := pairing.FindJoinLink(req.Link)
			if link == "" {
				writeError(w, http.StatusBadRequest, "no join link in that; it starts with berth://join? (Settings → Computers → Add another computer makes one)")
				return
			}
			args := []string{"join", "--json", "--yes", "-"}
			if check {
				args = []string{"join", "--check", "--json", "-"}
			}
			a.runJSONInput(w, r, link, args...)
			if !check {
				a.checkSoon()
			}
		}
	}
	mux.HandleFunc("POST /v1/join", join(false))
	mux.HandleFunc("POST /v1/join/check", join(true))
}

// runJSONInput is runJSON with input on the command's stdin.
func (a *Agent) runJSONInput(w http.ResponseWriter, r *http.Request, input string, args ...string) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	cmd := a.cli(ctx, args...)
	cmd.Stdin = strings.NewReader(input)
	out, err := cmd.Output()
	if err != nil {
		writeError(w, http.StatusBadRequest, cliError(err))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(out)
}
