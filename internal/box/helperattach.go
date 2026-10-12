package box

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Before berthd starts a worktree's service it tells each running helper
// that asked to be told (its manifest's "attach"), and the helper may answer
// with variables for the service's environment: where to send telemetry, a
// database URL that goes through its recording proxy.
//
// A helper is never in the way of a service. One that is down, slow or
// answers an error changes nothing, and the service starts exactly as it
// would have. What a helper is told, and what it may set, is only the
// variables its manifest names (attach_env), which the person allowed with
// the plugin; a variable that names a secret is neither sent nor replaced,
// and Shipyard's own BERTH_ variables are never changed.

// HelperAttach is what a helper is told of a service about to start.
type HelperAttach struct {
	Box     string `json:"box"`
	Project string `json:"project"`
	// Worktree is the worktree's name; empty for the project's own checkout.
	Worktree string `json:"worktree"`
	Branch   string `json:"branch"`
	Path     string `json:"path"`
	// Command is the service's name in the project's config.
	Command string `json:"command"`
	// Env is the variables of the service's environment the helper's
	// manifest names, and no others.
	Env map[string]string `json:"env"`
}

const (
	// maxAttachAnswer bounds a helper's answer, and maxAttachValue one
	// variable in it.
	maxAttachAnswer = 256 << 10
	maxAttachValue  = 32 << 10
)

// Attach tells every running helper with an attach path that a service is
// about to start, and puts what each answers into env. refs are the
// variables that name a secret: they are not in env, and stay the project's.
//
// svc names the service as the box does. Which services each helper changed
// is remembered, so that removing a helper can say which still point at it.
func (h *Helpers) Attach(ctx context.Context, about HelperAttach, svc HelperService, env, refs map[string]string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	procs := make([]*helperProc, 0, len(h.procs))
	for _, p := range h.procs {
		if p.rec.Attach != "" {
			procs = append(procs, p)
		}
	}
	h.mu.Unlock()
	sort.Slice(procs, func(i, j int) bool { return procs[i].rec.Plugin < procs[j].rec.Plugin })
	asked := map[string]bool{}
	for _, p := range procs {
		asked[p.rec.Plugin] = true
		h.noteAttached(p.rec.Plugin, svc, h.attachOne(ctx, p, about, env, refs))
	}
	// A helper that is off had no say: a service it changed the last time
	// is as the project wrote it now (helperdetach.go).
	h.startedPlain(svc, asked)
}

// attachOne asks one helper, and reports whether it changed env.
func (h *Helpers) attachOne(ctx context.Context, p *helperProc, about HelperAttach, env, refs map[string]string) (changed bool) {
	timeout := orDuration(h.attachTimeout, 2*time.Second)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// One that berthd has only just started gets the same moment to come
	// up as it has to answer.
	p.waitStarted(ctx, timeout)
	state, api := p.snapshot()
	if state != HelperRunning || api == nil {
		return false
	}
	about.Env = map[string]string{}
	for k, v := range env {
		if p.rec.matchesEnv(k) {
			about.Env[k] = v
		}
	}
	answer, err := askHelper(ctx, api, p.rec.Attach, about)
	if err != nil {
		// Never the request or the answer: they hold the environment.
		h.logf("helper %s: not attached to %s/%s %s: %v", p.rec.Plugin, about.Project, about.Worktree, about.Command, err)
		return false
	}
	for k, v := range answer {
		if !envName.MatchString(k) || !p.rec.matchesEnv(k) || strings.HasPrefix(k, "BERTH_") {
			continue
		}
		if _, secret := refs[k]; secret || len(v) > maxAttachValue || strings.ContainsRune(v, 0) {
			continue
		}
		if had, ok := env[k]; !ok || had != v {
			changed = true
		}
		env[k] = v
	}
	return changed
}

// askHelper POSTs about to a helper's attach path and returns the "env" of
// its answer. Its errors name no address and repeat nothing that was sent.
func askHelper(ctx context.Context, api *url.URL, path string, about HelperAttach) (map[string]string, error) {
	body, err := json.Marshal(about)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, api.String()+path, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("its attach address cannot be used")
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := helperClient.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, errors.New("it did not answer in time")
		}
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("it answered " + resp.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxAttachAnswer+1))
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, errors.New("it did not answer in time")
		}
		return nil, errors.New("its answer could not be read")
	}
	var answer struct {
		Env map[string]string `json:"env"`
	}
	if len(raw) > maxAttachAnswer || json.Unmarshal(raw, &answer) != nil {
		return nil, errors.New("its answer is not the JSON berthd expects")
	}
	return answer.Env, nil
}

// helperClient reaches helpers, on loopback: never through a proxy the
// environment names, and never following a redirect somewhere else.
var helperClient = &http.Client{
	Transport: helperTransport,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

var helperTransport = func() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	return t
}()

// attachHelpers is Attach for one service of a worktree.
func (b *Box) attachHelpers(ctx context.Context, loc Location, wt Worktree, service string, env, refs map[string]string) {
	if b.Helpers == nil {
		return
	}
	about := HelperAttach{Box: b.Name, Project: loc.Name, Worktree: wt.Name, Branch: wt.Branch, Path: wt.Path, Command: service}
	if wt.Main {
		about.Worktree = ""
	}
	b.Helpers.Attach(ctx, about, HelperService{Location: loc.Name, Worktree: wt.Name, Service: service}, env, refs)
}
