package box

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Agents often drive a browser with Vercel's agent-browser CLI (npx
// agent-browser … open URL) rather than berth's own. Each of its sessions is
// a daemon plus a headless Chrome with a throwaway profile in the temp
// folder, and both live until the agent runs `agent-browser close`, which
// agents forget. On a box that runs agents all day they pile up, each Chrome
// burning CPU rendering in software.
//
// Terminal keeps them in check from both ends. Every session it starts gets
// AGENT_BROWSER_IDLE_TIMEOUT_MS, so an idle daemon closes its browser and
// exits by itself; and when a berth session ends (stopped, its program
// exited, its worktree archived), the agent-browser sessions it started are
// closed. Those are known by their environment: agent-browser's daemon and
// every Chrome process it starts carry AGENT_BROWSER_DAEMON=1, and they keep
// the environment of the agent that started them, so its BERTH_SESSION and
// its TMUX (the berth tmux server it ran in). A process with no
// BERTH_SESSION, or one from another tmux server, is never touched: someone
// may run agent-browser by hand.

// AgentBrowserIdleEnv is agent-browser's idle shutdown, in milliseconds.
const AgentBrowserIdleEnv = "AGENT_BROWSER_IDLE_TIMEOUT_MS"

// AgentBrowserIdleDefault is what berth sets it to unless the person, the
// box or the project does: five idle minutes, as berth's own browser.
const AgentBrowserIdleDefault = "300000"

// withAgentBrowserIdle adds the idle timeout to a session's environment,
// unless the environment already sets it (the box's env.json or the
// project's env, which come in env) or berthd's own environment does.
func withAgentBrowserIdle(env []string) []string {
	if os.Getenv(AgentBrowserIdleEnv) != "" {
		return env
	}
	for _, kv := range env {
		if strings.HasPrefix(kv, AgentBrowserIdleEnv+"=") {
			return env
		}
	}
	return append(env, AgentBrowserIdleEnv+"="+AgentBrowserIdleDefault)
}

// AgentBrowserSession is one agent-browser session a berth session started:
// its daemon and the browser processes under it.
type AgentBrowserSession struct {
	// BerthSession is the berth session that started it, and Live whether
	// that session's program still runs.
	BerthSession string `json:"berth_session"`
	Live         bool   `json:"live"`
	// Session is agent-browser's own session name (--session), Namespace
	// its --namespace, if any.
	Session   string `json:"session"`
	Namespace string `json:"namespace,omitempty"`
	// Daemon is the daemon's process, 0 when it is gone and only its
	// browser is left; PIDs are all of its processes, the daemon's first.
	Daemon int   `json:"daemon,omitempty"`
	PIDs   []int `json:"pids"`
	// Profiles are the browser's throwaway profile folders.
	Profiles []string `json:"profiles,omitempty"`
	// ClosedBy, once reaped, says what ended it: "agent-browser close",
	// "SIGTERM" or "SIGKILL".
	ClosedBy string `json:"closed_by,omitempty"`

	exe string
	env map[string]string
}

// AgentBrowsers finds and closes the agent-browser sessions berth sessions
// started.
type AgentBrowsers struct {
	// Socket is the tmux server berth's sessions run in; only processes
	// started in it are berth's.
	Socket string
	// Live lists the berth sessions whose program still runs.
	Live func(ctx context.Context) (map[string]bool, error)

	// scan, signal and closeCmd stand in for the system in tests.
	scan     func() ([]proc, error)
	signal   func(pid int, sig syscall.Signal) error
	closeCmd func(ctx context.Context, s AgentBrowserSession) error
	// grace is how long each step waits for the processes to go.
	grace time.Duration

	// mu keeps reaps one at a time.
	mu       sync.Mutex
	pokeOnce sync.Once
	poke     chan struct{}
}

func (a *AgentBrowsers) pokes() chan struct{} {
	a.pokeOnce.Do(func() { a.poke = make(chan struct{}, 1) })
	return a.poke
}

// NewAgentBrowsers watches the agent-browser sessions of s's sessions, and
// closes them when their session ends.
func NewAgentBrowsers(s *Sessions) *AgentBrowsers {
	a := &AgentBrowsers{Socket: tmuxSocketPath(), Live: s.live}
	s.Ended = a.Poke
	s.Reap = func(ctx context.Context, session string) { a.Reap(ctx, session) }
	return a
}

// live is the sessions whose program still runs.
func (s *Sessions) live(ctx context.Context) (map[string]bool, error) {
	all, err := s.list(ctx)
	if err != nil {
		return nil, err
	}
	m := map[string]bool{}
	for _, sess := range all {
		if !sess.Exited {
			m[sess.Name] = true
		}
	}
	return m, nil
}

// tmuxSocketPath is where berth's tmux server listens, as tmux names it in
// the TMUX variable of its panes: $TMUX_TMPDIR (or /tmp), resolved, then
// tmux-UID/berth.
func tmuxSocketPath() string {
	dir := os.Getenv("TMUX_TMPDIR")
	if dir == "" {
		dir = "/tmp"
	}
	if r, err := filepath.EvalSymlinks(dir); err == nil {
		dir = r
	}
	return filepath.Join(dir, "tmux-"+strconv.Itoa(os.Getuid()), tmuxSocket)
}

// sameSocket says whether a pane's TMUX value (socket,pid,index) names the
// socket at path.
func sameSocket(tmux, path string) bool {
	sock, _, _ := strings.Cut(tmux, ",")
	if sock == "" || path == "" {
		return false
	}
	norm := func(p string) string {
		p = filepath.Clean(p)
		if r, err := filepath.EvalSymlinks(filepath.Dir(p)); err == nil {
			return filepath.Join(r, filepath.Base(p))
		}
		return p
	}
	return norm(sock) == norm(path)
}

// tmuxServerRuns says whether the tmux server a pane's TMUX value
// (socket,pid,index) names still runs.
func tmuxServerRuns(tmux string) bool {
	f := strings.Split(tmux, ",")
	if len(f) < 2 {
		return false
	}
	pid, err := strconv.Atoi(f[1])
	if err != nil || pid <= 0 {
		return false
	}
	err = syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func (a *AgentBrowsers) procs() ([]proc, error) {
	if a.scan != nil {
		return a.scan()
	}
	return scanProcs("AGENT_BROWSER_DAEMON=", "BERTH_SESSION=")
}

// isAgentBrowser says whether p runs agent-browser itself (its daemon is
// the agent-browser binary, agent-browser-linux-x64 from npx, say).
func isAgentBrowser(p proc) bool {
	if strings.HasPrefix(filepath.Base(p.Exe), "agent-browser") {
		return true
	}
	return len(p.Args) > 0 && strings.HasPrefix(filepath.Base(p.Args[0]), "agent-browser")
}

// List finds the agent-browser sessions berth sessions started, with
// whether their berth session still runs.
func (a *AgentBrowsers) List(ctx context.Context) ([]AgentBrowserSession, error) {
	ps, err := a.procs()
	if err != nil {
		return nil, err
	}
	live, err := a.Live(ctx)
	if err != nil {
		return nil, err
	}
	return a.group(ps, live), nil
}

type abKey struct{ berth, session, namespace string }

func (a *AgentBrowsers) group(ps []proc, live map[string]bool) []AgentBrowserSession {
	byKey := map[abKey]*AgentBrowserSession{}
	var keys []abKey
	for _, p := range ps {
		if p.Env["AGENT_BROWSER_DAEMON"] == "" || p.Env["BERTH_SESSION"] == "" || !sameSocket(p.Env["TMUX"], a.Socket) {
			continue
		}
		k := abKey{p.Env["BERTH_SESSION"], p.Env["AGENT_BROWSER_SESSION"], p.Env["AGENT_BROWSER_NAMESPACE"]}
		if k.session == "" {
			k.session = "default"
		}
		g := byKey[k]
		if g == nil {
			g = &AgentBrowserSession{BerthSession: k.berth, Live: live[k.berth], Session: k.session, Namespace: k.namespace, env: p.Env}
			// tmux listing no sessions while its server still runs is a
			// listing to doubt, not every session ended: a server with no
			// sessions exits.
			if live != nil && len(live) == 0 && tmuxServerRuns(p.Env["TMUX"]) {
				g.Live = true
			}
			byKey[k] = g
			keys = append(keys, k)
		}
		if isAgentBrowser(p) && g.Daemon == 0 {
			g.Daemon, g.exe, g.env = p.PID, p.Exe, p.Env
			g.PIDs = append([]int{p.PID}, g.PIDs...)
		} else {
			g.PIDs = append(g.PIDs, p.PID)
		}
		for _, arg := range p.Args {
			if dir, ok := strings.CutPrefix(arg, "--user-data-dir="); ok && isAgentBrowserProfile(dir) && !slices.Contains(g.Profiles, dir) {
				g.Profiles = append(g.Profiles, dir)
			}
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].berth != keys[j].berth {
			return keys[i].berth < keys[j].berth
		}
		return keys[i].session < keys[j].session
	})
	out := make([]AgentBrowserSession, 0, len(keys))
	for _, k := range keys {
		out = append(out, *byKey[k])
	}
	return out
}

// isAgentBrowserProfile says whether dir is a profile agent-browser made for
// one browser, which it deletes when the browser closes: an absolute
// agent-browser-chrome-* folder. Anything else (a --profile someone keeps)
// is never removed.
func isAgentBrowserProfile(dir string) bool {
	return filepath.IsAbs(dir) && strings.HasPrefix(filepath.Base(dir), "agent-browser-chrome-") && filepath.Clean(dir) == dir
}

// Reap closes the agent-browser sessions whose berth session no longer
// runs; with only, just those of that berth session. It says what it
// closed.
func (a *AgentBrowsers) Reap(ctx context.Context, only string) ([]AgentBrowserSession, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	all, err := a.List(ctx)
	if err != nil {
		return nil, err
	}
	var done []AgentBrowserSession
	for _, s := range all {
		if s.Live || (only != "" && s.BerthSession != only) {
			continue
		}
		s.ClosedBy = a.close(ctx, s)
		done = append(done, s)
	}
	return done, nil
}

// close ends one agent-browser session: agent-browser's own close first,
// which saves what it keeps and removes its profile, then SIGTERM to what is
// left, then SIGKILL, and its profile goes.
func (a *AgentBrowsers) close(ctx context.Context, s AgentBrowserSession) string {
	by := "agent-browser close"
	grace := a.grace
	if grace == 0 {
		grace = 5 * time.Second
	}
	if s.Daemon != 0 {
		cctx, cancel := context.WithTimeout(ctx, 2*grace)
		a.runClose(cctx, s)
		cancel()
	}
	for _, sig := range []syscall.Signal{0, syscall.SIGTERM, syscall.SIGKILL} {
		left := a.remaining(s)
		if len(left) == 0 {
			break
		}
		if sig == 0 {
			// Give close a moment to finish.
			a.waitGone(ctx, s, grace)
			continue
		}
		if sig == syscall.SIGTERM {
			by = "SIGTERM"
		} else {
			by = "SIGKILL"
		}
		for _, pid := range left {
			a.kill(pid, sig)
		}
		a.waitGone(ctx, s, grace)
	}
	for _, dir := range s.Profiles {
		os.RemoveAll(dir)
	}
	return by
}

func (a *AgentBrowsers) runClose(ctx context.Context, s AgentBrowserSession) error {
	if a.closeCmd != nil {
		return a.closeCmd(ctx, s)
	}
	if s.exe == "" {
		return errors.New("no agent-browser to run")
	}
	args := []string{"--session", s.Session}
	if s.Namespace != "" {
		args = append(args, "--namespace", s.Namespace)
	}
	cmd := exec.CommandContext(ctx, s.exe, append(args, "close")...)
	// As the agent ran it: its HOME, socket folder and namespace, without
	// the mark that makes it the daemon.
	for k, v := range s.env {
		if k != "AGENT_BROWSER_DAEMON" {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}
	cmd.Dir = os.TempDir()
	return cmd.Run()
}

func (a *AgentBrowsers) kill(pid int, sig syscall.Signal) {
	if a.signal != nil {
		a.signal(pid, sig)
		return
	}
	syscall.Kill(pid, sig)
}

// remaining is which of s's processes still run, looked up again by their
// environment, so a browser process started since is included and a process
// id the system gave to something else is never signalled.
func (a *AgentBrowsers) remaining(s AgentBrowserSession) []int {
	ps, err := a.procs()
	if err != nil {
		return nil
	}
	var left []int
	for _, g := range a.group(ps, nil) {
		if g.BerthSession == s.BerthSession && g.Session == s.Session && g.Namespace == s.Namespace {
			left = append(left, g.PIDs...)
		}
	}
	return left
}

func (a *AgentBrowsers) waitGone(ctx context.Context, s AgentBrowserSession, d time.Duration) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		if len(a.remaining(s)) == 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// Poke asks the reaper to look now: a session just ended.
func (a *AgentBrowsers) Poke() {
	if a == nil {
		return
	}
	select {
	case a.pokes() <- struct{}{}:
	default:
	}
}

// Run closes agent-browser sessions left by berth sessions that ended,
// when one is stopped and every minute (an agent's program can exit by
// itself), until ctx ends.
func (a *AgentBrowsers) Run(ctx context.Context, logf func(string, ...any)) {
	ch := a.pokes()
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		done, err := a.Reap(ctx, "")
		if err != nil && !errors.Is(err, errNoProcs) && ctx.Err() == nil && logf != nil {
			logf("agent-browser reaper: %v", err)
		}
		for _, s := range done {
			if logf != nil {
				logf("closed agent-browser session %q of ended berth session %s (%d processes) with %s", s.Session, s.BerthSession, len(s.PIDs), s.ClosedBy)
			}
		}
		if errors.Is(err, errNoProcs) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-ch:
		}
	}
}

// describe is one line for a session in doctor and reap output.
func (s AgentBrowserSession) describe() string {
	what := fmt.Sprintf("%q of %s", s.Session, s.BerthSession)
	if s.Daemon == 0 {
		return what + fmt.Sprintf(" (browser only, %d processes)", len(s.PIDs))
	}
	return what + fmt.Sprintf(" (daemon %d, %d processes)", s.Daemon, len(s.PIDs))
}

// browserReap is POST /v1/browser/reap {dry_run}: close the agent-browser
// sessions no running berth session owns, or with dry_run only list them.
func (b *Box) browserReap(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		DryRun bool `json:"dry_run"`
	}
	if r.ContentLength != 0 {
		if err := decode(r, &req); err != nil {
			return err
		}
	}
	if b.AgentBrowsers == nil {
		writeJSON(w, map[string]any{"sessions": []AgentBrowserSession{}, "text": "This box doesn't watch agent-browser sessions."})
		return nil
	}
	var found []AgentBrowserSession
	var err error
	if req.DryRun {
		var all []AgentBrowserSession
		if all, err = b.AgentBrowsers.List(r.Context()); err == nil {
			for _, s := range all {
				if !s.Live {
					found = append(found, s)
				}
			}
		}
	} else {
		found, err = b.AgentBrowsers.Reap(r.Context(), "")
	}
	if errors.Is(err, errNoProcs) {
		writeJSON(w, map[string]any{"sessions": []AgentBrowserSession{}, "text": "Terminal can't see other processes' environment on this system, so it can't find agent-browser sessions."})
		return nil
	}
	if err != nil {
		return err
	}
	if found == nil {
		found = []AgentBrowserSession{}
	}
	var text strings.Builder
	switch {
	case len(found) == 0:
		text.WriteString("No agent-browser sessions left by ended berth sessions.")
	case req.DryRun:
		fmt.Fprintf(&text, "%d agent-browser %s left by ended berth sessions:", len(found), "session"+plural(len(found)))
	default:
		fmt.Fprintf(&text, "Closed %d agent-browser %s left by ended berth sessions:", len(found), "session"+plural(len(found)))
	}
	for _, s := range found {
		text.WriteString("\n  " + s.describe())
	}
	writeJSON(w, map[string]any{"sessions": found, "text": text.String()})
	return nil
}
