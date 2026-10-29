package desk

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Handler serves the desk to the app on loopback. Every request carries
// token as a bearer token, and only the app's own origins may call it from
// a page, so another site open in a browser can't drive an agent.
func (d *Desk) Handler(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/state", func(w http.ResponseWriter, r *http.Request) { reply(w, d.State(), nil) })
	mux.HandleFunc("POST /v1/projects", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		if !decode(w, r, &body) {
			return
		}
		p, err := d.AddProject(body.Path)
		reply(w, p, err)
	})
	mux.HandleFunc("DELETE /v1/projects/{id}", func(w http.ResponseWriter, r *http.Request) {
		reply(w, ok{}, d.RemoveProject(r.PathValue("id")))
	})
	mux.HandleFunc("POST /v1/chats", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Project string `json:"project"`
			Access  string `json:"access"`
		}
		if !decode(w, r, &body) {
			return
		}
		c, err := d.NewChat(body.Project, body.Access)
		reply(w, c, err)
	})
	mux.HandleFunc("PATCH /v1/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body ChatPatch
		if !decode(w, r, &body) {
			return
		}
		c, err := d.UpdateChat(r.PathValue("id"), body)
		reply(w, c, err)
	})
	mux.HandleFunc("DELETE /v1/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		reply(w, ok{}, d.RemoveChat(r.PathValue("id")))
	})
	mux.HandleFunc("POST /v1/chats/{id}/send", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text   string `json:"text"`
			Branch string `json:"branch"`
		}
		if !decode(w, r, &body) {
			return
		}
		q, err := d.Send(r.PathValue("id"), body.Text, body.Branch)
		reply(w, map[string]bool{"queued": q}, err)
	})
	mux.HandleFunc("POST /v1/chats/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		d.Stop(r.PathValue("id"))
		reply(w, ok{}, nil)
	})
	mux.HandleFunc("GET /v1/chats/{id}/items", func(w http.ResponseWriter, r *http.Request) {
		since, _ := strconv.Atoi(r.URL.Query().Get("since"))
		res, err := d.Items(r.PathValue("id"), since, r.URL.Query().Get("gen"))
		reply(w, res, err)
	})
	mux.HandleFunc("GET /v1/events", d.events)
	return guard(token, mux)
}

type ok struct{}

// events streams Events as server-sent events, with a comment now and then
// so a quiet stream isn't taken for a dead one.
func (d *Desk) events(w http.ResponseWriter, r *http.Request) {
	fl, can := w.(http.Flusher)
	if !can {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	ch, cancel := d.Subscribe()
	defer cancel()
	fmt.Fprint(w, ": hello\n\n")
	fl.Flush()
	beat := time.NewTicker(20 * time.Second)
	defer beat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-beat.C:
			fmt.Fprint(w, ": beat\n\n")
		case e := <-ch:
			b, _ := json.Marshal(e)
			fmt.Fprintf(w, "data: %s\n\n", b)
		}
		fl.Flush()
	}
}

// allowedOrigin is a page that may call the desk: the app's own webview
// (tauri.localhost on Windows, tauri://localhost elsewhere) and its dev
// server.
func allowedOrigin(o string) bool {
	switch o {
	case "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost":
		return true
	}
	for _, host := range []string{"http://localhost:", "http://127.0.0.1:"} {
		if port, found := strings.CutPrefix(o, host); found {
			n, err := strconv.Atoi(port)
			return err == nil && n >= 1420 && n <= 1439
		}
	}
	return false
}

func guard(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" {
			if !allowedOrigin(o) {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		got, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		reply(w, nil, fmt.Errorf("bad request: %w", err))
		return false
	}
	return true
}

// reply writes v as JSON, or err as {"error": …}: 409 for a branch switch
// that uncommitted changes stopped, 400 otherwise.
func reply(w http.ResponseWriter, v any, err error) {
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, ErrDirty) {
			code = http.StatusConflict
		}
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(v)
}
