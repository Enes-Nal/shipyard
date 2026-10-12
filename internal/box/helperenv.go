package box

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/wire"
)

// A helper learns of a worktree when berthd starts one of its services
// (helperattach.go). A project whose dev servers Shipyard does not start
// never gets there, and what a helper would have been told (a database's
// address, say) is in the worktree's dotenv files all along. So the app may
// ask berthd to look:
//
//	POST /v1/helpers/{plugin}/attach-env   {"location": "acme", "worktree": "fix-orders"}
//
// berthd reads the worktree's dotenv files (dotenv.go: four names in the
// worktree's own folder, and nothing else), keeps the variables the helper's
// manifest names (attach_env), and tells the helper as it does before a
// service starts: the same body, the same token, the same two seconds, with
// ".env" where the service's name would be. A helper files what it is told
// by that name, so looking again replaces what the last look found, and what
// a real service was started with is its own.
//
// Nothing is started, so nothing the helper answers is put anywhere: its
// "env" is dropped, and the worktree is not noted as a service that points
// at the helper (attached.json). When the worktree is removed the helper is
// told as for any other (helperdetach.go).
//
// The answer says what was found and never what it holds: the files read,
// the names of the variables, and the helper's own answer without "env".
// No value is in it, in a log or in an error.

// HelperEnvLook is the answer of POST /v1/helpers/{plugin}/attach-env.
type HelperEnvLook struct {
	Plugin   string `json:"plugin"`
	Location string `json:"location"`
	// Worktree is the worktree's name on the box, its main checkout's too.
	Worktree string `json:"worktree"`
	// Command is what the helper was told in place of a service's name.
	Command string `json:"command"`
	// Files are the dotenv files that were read, in the order they were
	// read: a later one's value for a variable wins.
	Files []string `json:"files"`
	// Skipped are the ones that are there and were not read, and why:
	// "outside" (a link out of the worktree), "not_a_file", "too_large",
	// "not_text" or "unreadable".
	Skipped []dotenvSkipped `json:"skipped"`
	// Variables are the variables of those files that the helper's manifest
	// names: never a value.
	Variables []HelperEnvVariable `json:"variables"`
	// Answer is what the helper answered, as it wrote it, without "env".
	Answer map[string]json.RawMessage `json:"answer"`
}

// HelperEnvVariable is one variable a look found.
type HelperEnvVariable struct {
	Name string `json:"name"`
	// File is the file whose value it is.
	File string `json:"file"`
	// Sent says the helper was told its value. When it was not, Reason says
	// why: "secret" (it names a secret and holds none), "unresolved" (it
	// refers to a variable these files do not set), "empty" or "too_long".
	Sent   bool   `json:"sent"`
	Reason string `json:"reason,omitempty"`
}

// AttachEnv tells a running helper what a worktree's dotenv files have of
// the variables its manifest names. about is the worktree, as for a service.
func (h *Helpers) AttachEnv(ctx context.Context, plugin string, about HelperAttach) (HelperEnvLook, error) {
	out := HelperEnvLook{Plugin: plugin, Command: helperEnvCommand, Files: []string{}, Skipped: []dotenvSkipped{}, Variables: []HelperEnvVariable{}}
	off := helperProblem(http.StatusConflict, "helper_off", "the %s helper is not running on this box", plugin)
	h.mu.Lock()
	p := h.procs[plugin]
	h.mu.Unlock()
	if p == nil {
		return out, off
	}
	if p.rec.Attach == "" {
		return out, helperProblem(http.StatusConflict, "helper_no_attach", "the %s helper is not one berthd tells of a worktree: its plugin's manifest names no attach path", plugin)
	}
	timeout := orDuration(h.attachTimeout, 2*time.Second)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	p.waitStarted(ctx, timeout)
	state, api := p.snapshot()
	if state != HelperRunning || api == nil {
		return out, off
	}
	// Only now: with no helper to tell, no file is opened.
	set := readDotenvWithin(ctx, about.Path)
	if set == nil {
		return out, helperProblem(http.StatusServiceUnavailable, CodeInternal, "the worktree's .env files could not be read in time")
	}
	out.Files, out.Skipped = set.files, set.skipped
	about.Command, about.Env = helperEnvCommand, map[string]string{}
	names := set.names()
	sort.Strings(names)
	for _, name := range names {
		if !p.rec.matchesEnv(name) || strings.HasPrefix(name, "BERTH_") {
			continue
		}
		v := HelperEnvVariable{Name: name, File: set.file(name)}
		value, why := set.value(name, nil)
		if why == "" {
			about.Env[name], v.Sent = value, true
		} else {
			v.Reason = why
		}
		out.Variables = append(out.Variables, v)
	}
	// Also with nothing to say: what the last look found is no longer so.
	raw, err := askHelperRaw(ctx, api, p.rec.Attach, about)
	if err == nil && json.Unmarshal(raw, &out.Answer) != nil {
		err = errHelperAnswer
	}
	if err != nil {
		// Never the request or the answer: they hold the environment.
		h.logf("helper %s: not told of %s/%s's %s: %v", plugin, about.Project, about.Worktree, helperEnvCommand, err)
		return out, helperProblem(http.StatusBadGateway, "helper_unreachable", "the %s helper was not told: %v", plugin, err)
	}
	// What it would set in a service's environment: there is no service.
	delete(out.Answer, "env")
	if out.Answer == nil {
		out.Answer = map[string]json.RawMessage{}
	}
	return out, nil
}

// readDotenvWithin is readDotenv for as long as ctx lasts: nil when the
// files were not read by then (a folder on a disk that does not answer).
func readDotenvWithin(ctx context.Context, dir string) *dotenvSet {
	if dir == "" {
		return nil
	}
	done := make(chan *dotenvSet, 1)
	go func() { done <- readDotenv(dir) }()
	select {
	case set := <-done:
		return set
	case <-ctx.Done():
		return nil
	}
}

// dotenvForService is what a worktree's dotenv files add to a service's
// environment as its helpers are shown it: the variables that are in the
// files and not in the environment Shipyard assembled (own, and the secrets'
// names in refs), each with its value. A variable that names a secret, that
// refers to something nothing defines, or that is empty or too long is not
// among them, and neither is one of Shipyard's own.
//
// The files are read when the result is first asked for, once, for as long
// as that caller's ctx lasts; one that gave up leaves nothing for the rest,
// so a disk that does not answer costs a service's start one wait.
func dotenvForService(dir string, own, refs map[string]string) func(context.Context) map[string]string {
	var once sync.Once
	var vars map[string]string
	return func(ctx context.Context) map[string]string {
		once.Do(func() {
			set := readDotenvWithin(ctx, dir)
			if set == nil {
				return
			}
			// A reference is filled in from the service's environment first,
			// as the dev server's own loader would find it there.
			outer := func(name string) (string, bool, bool) {
				if v, ok := own[name]; ok {
					return v, true, true
				}
				_, secret := refs[name]
				return "", secret, false
			}
			vars = map[string]string{}
			for _, name := range set.names() {
				_, assembled := own[name]
				_, secret := refs[name]
				if assembled || secret || strings.HasPrefix(name, "BERTH_") {
					continue
				}
				if v, why := set.value(name, outer); why == "" {
					vars[name] = v
				}
			}
		})
		return vars
	}
}

// helperAttachEnv is POST /v1/helpers/{plugin}/attach-env.
//
// Like installing a helper, it is a paired laptop's to ask: the laptop is
// where the person allowed the plugin and what its helper is told, and
// opening the plugin's tab there is the asking. What runs on the box itself
// cannot have a helper told of a worktree.
func (b *Box) helperAttachEnv(w http.ResponseWriter, r *http.Request) error {
	plugin := r.PathValue("plugin")
	h, err := b.helpers(plugin)
	if err != nil {
		return err
	}
	if wire.IsLocal(r.Context()) {
		return helperProblem(http.StatusForbidden, CodeRefused, "a plugin's helper is told of a worktree's .env files from a paired laptop, where the plugin was allowed")
	}
	var req struct {
		Location string `json:"location"`
		// Worktree is its name; empty is the location's main checkout.
		Worktree string `json:"worktree"`
	}
	if err := decode(r, &req); err != nil {
		return err
	}
	if req.Location == "" {
		return badRequest("location is required")
	}
	loc, err := b.Locations.Get(r.Context(), req.Location)
	if err != nil {
		return err
	}
	var wt *Worktree
	for i, w := range loc.Worktrees {
		if w.Name == req.Worktree || req.Worktree == "" && w.Main {
			wt = &loc.Worktrees[i]
			break
		}
	}
	if wt == nil {
		return ErrUnknownWorktree
	}
	if err := b.before(r, "helper.attach", map[string]any{"plugin": plugin, "location": loc.Name, "worktree": wt.Name, "path": wt.Path, "from": helperEnvCommand}); err != nil {
		return err
	}
	about := HelperAttach{Box: b.Name, Project: loc.Name, Worktree: wt.Name, Branch: wt.Branch, Path: wt.Path}
	if wt.Main {
		about.Worktree = ""
	}
	look, err := h.AttachEnv(r.Context(), plugin, about)
	if err != nil {
		return err
	}
	look.Location, look.Worktree = loc.Name, wt.Name
	writeJSON(w, look)
	return nil
}
