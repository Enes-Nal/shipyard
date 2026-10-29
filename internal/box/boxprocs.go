package box

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/events"
)

// A box's browsers and heavy processes, visible: every Chromium, Chrome or
// Firefox on the box, grouped as one browser with its helpers, with who
// started it and what it costs, and what each session's processes use.
// Anything berth or its sessions started can be stopped from here; a
// browser nothing of berth's started (the box user's own) is listed but
// never touched.

// Owners of a browser.
const (
	OwnerAgent        = "agent"         // berth's agent browser (or the visual-diff one)
	OwnerAgentBrowser = "agent-browser" // a session's agent-browser CLI
	OwnerSession      = "session"       // started by a running session's programs
	OwnerOrphan       = "orphan"        // left by a session (or berthd) that has ended
	OwnerOther        = "other"         // not started by Terminal
)

// BoxBrowser is one browser: its main process and every helper under it.
type BoxBrowser struct {
	// ID names it for POST /v1/processes/{id}/stop.
	ID string `json:"id"`
	// Engine is Chromium, Headless Chromium, Chrome, Edge or Firefox.
	Engine string `json:"engine"`
	// Owner is one of the Owner constants; Label says it in words
	// ("Playwright tests in cal/billing").
	Owner string `json:"owner"`
	Label string `json:"label"`
	// Via is what drives it, when that shows: Playwright, Puppeteer,
	// agent-browser, Cypress, ….
	Via string `json:"via,omitempty"`
	// Session is the berth session it belongs to, Location and Worktree
	// where (for berth's own browser, the worktree's).
	Session  string `json:"session,omitempty"`
	Location string `json:"location,omitempty"`
	Worktree string `json:"worktree,omitempty"`
	// PID is its main process; Processes how many it has.
	PID       int   `json:"pid"`
	PIDs      []int `json:"pids"`
	Processes int   `json:"processes"`
	// CPUPercent (100 is one core) and Memory (resident, bytes) are summed
	// over its processes.
	CPUPercent float64   `json:"cpu_percent"`
	Memory     uint64    `json:"memory"`
	Started    time.Time `json:"started,omitzero"`
	Exe        string    `json:"exe,omitempty"`
	// Stoppable is false for a browser Terminal did not start.
	Stoppable bool `json:"stoppable"`

	procs []procStat
	path  string // berth's own browser's worktree
}

// BoxSessionProcs is what one session's processes use.
type BoxSessionProcs struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Location string    `json:"location,omitempty"`
	Title    string    `json:"title,omitempty"`
	Agent    string    `json:"agent,omitempty"`
	Scope    string    `json:"scope,omitempty"`
	Usage    ProcUsage `json:"usage"`
}

// BoxProcesses is GET /v1/processes.
type BoxProcesses struct {
	Browsers []BoxBrowser      `json:"browsers"`
	Sessions []BoxSessionProcs `json:"sessions,omitempty"`
	// Scopes says new sessions on this box get a systemd scope.
	Scopes bool      `json:"scopes"`
	At     time.Time `json:"at"`
}

// browserKind says whether p is a browser's process: its engine, and
// whether it is a helper (a renderer, the GPU process, …) rather than a
// browser's main process.
func browserKind(p procStat) (engine string, helper, ok bool) {
	name := p.Name
	if len(p.Args) > 0 && p.Args[0] != "" {
		name = path.Base(strings.ReplaceAll(p.Args[0], "\\", "/"))
	}
	if p.Exe != "" {
		name = filepath.Base(p.Exe)
	}
	n := strings.ToLower(name)
	hasArg := func(prefix string) bool {
		for _, a := range p.Args[min(1, len(p.Args)):] {
			if strings.HasPrefix(a, prefix) {
				return true
			}
		}
		return false
	}
	switch {
	case strings.Contains(n, "crashpad"):
		return "Chromium", true, true
	case n == "firefox" || n == "firefox-bin" || n == "firefox-esr" || strings.HasPrefix(n, "firefox "):
		return "Firefox", hasArg("-contentproc"), true
	case n == "chrome-headless-shell" || n == "headless_shell" || strings.HasPrefix(n, "chrome-headless"):
		return "Headless Chromium", hasArg("--type="), true
	case n == "chrome" || n == "google-chrome" || n == "google-chrome-stable" || strings.HasPrefix(n, "google chrome"):
		engine = "Chrome"
		if lp := strings.ToLower(p.Exe); strings.Contains(lp, "ms-playwright") || strings.Contains(lp, "chromium") || strings.Contains(lp, "puppeteer") {
			engine = "Chromium"
		}
		if hasArg("--headless") {
			engine = "Headless " + engine
		}
		return engine, hasArg("--type=") || strings.Contains(n, "helper"), true
	case n == "chromium" || n == "chromium-browser" || strings.HasPrefix(n, "chromium "):
		engine = "Chromium"
		if hasArg("--headless") {
			engine = "Headless Chromium"
		}
		return engine, hasArg("--type=") || strings.Contains(n, "helper"), true
	case n == "msedge" || strings.HasPrefix(n, "microsoft edge"):
		return "Edge", hasArg("--type=") || strings.Contains(n, "helper"), true
	}
	return "", false, false
}

// procWorld is what grouping needs to know besides the processes: berth's
// own browsers, its sessions, their panes and scopes.
type procWorld struct {
	// agent maps an agent browser's main process to its worktree.
	agent map[int]BrowserStatus
	// sessions are the sessions tmux has; panes maps a pane's process to
	// its session, scopes a scope unit to its session.
	sessions map[string]Session
	panes    map[int]string
	scopes   map[string]string
	// socket is berth's tmux server's; self is berthd's process.
	socket string
	self   int
}

// groupBrowsers finds the browsers among ps and who started each.
func groupBrowsers(ps []procStat, w procWorld) []BoxBrowser {
	byPID := make(map[int]procStat, len(ps))
	kids := map[int][]int{}
	for _, p := range ps {
		byPID[p.PID] = p
		kids[p.PPID] = append(kids[p.PPID], p.PID)
	}
	isBrowser := func(pid int) bool {
		p, ok := byPID[pid]
		if !ok {
			return false
		}
		_, _, ok = browserKind(p)
		return ok
	}
	// A browser's main process is a browser process whose parent is not
	// one (helpers sit under it; a zygote under a zygote).
	var roots []procStat
	for _, p := range ps {
		_, _, ok := browserKind(p)
		if ok && (p.PPID == p.PID || !isBrowser(p.PPID)) {
			roots = append(roots, p)
		}
	}
	var out []BoxBrowser
	for _, root := range roots {
		engine, helper, _ := browserKind(root)
		var procs []procStat
		var walk func(int)
		seen := map[int]bool{}
		walk = func(pid int) {
			if seen[pid] {
				return
			}
			seen[pid] = true
			if p, ok := byPID[pid]; ok {
				procs = append(procs, p)
			}
			for _, k := range kids[pid] {
				walk(k)
			}
		}
		walk(root.PID)
		// A crash reporter on its own is no browser to show.
		if helper && strings.Contains(strings.ToLower(filepath.Base(root.Exe)+" "+root.Name), "crashpad") && len(procs) == 1 {
			continue
		}
		b := BoxBrowser{ID: browserID(root), Engine: engine, PID: root.PID, Started: root.Start, Exe: root.Exe, procs: procs}
		for _, p := range procs {
			b.PIDs = append(b.PIDs, p.PID)
			b.CPUPercent += p.CPUPercent
			b.Memory += p.RSS
		}
		b.Processes = len(procs)
		b.CPUPercent = float64(int(b.CPUPercent*10+0.5)) / 10
		owner(&b, root, byPID, w)
		out = append(out, b)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CPUPercent != out[j].CPUPercent {
			return out[i].CPUPercent > out[j].CPUPercent
		}
		return out[i].Memory > out[j].Memory
	})
	return out
}

func browserID(p procStat) string {
	return "b-" + strconv.Itoa(p.PID) + "-" + strconv.FormatUint(p.StartKey, 10)
}

// ancestors is p and its parents, nearest first, up to the first that
// isn't the user's (or a loop).
func ancestors(p procStat, byPID map[int]procStat) []procStat {
	out := []procStat{p}
	seen := map[int]bool{p.PID: true}
	for {
		parent, ok := byPID[p.PPID]
		if !ok || seen[parent.PID] {
			return out
		}
		seen[parent.PID] = true
		out = append(out, parent)
		p = parent
	}
}

// via is what drives a browser, from its program's path and its parents'
// command lines.
func via(root procStat, up []procStat) string {
	tools := []struct{ needle, name string }{
		{"agent-browser", "agent-browser"}, {"playwright", "Playwright"}, {"puppeteer", "Puppeteer"},
		{"cypress", "Cypress"}, {"vitest", "Vitest"}, {"jest", "Jest"}, {"selenium", "Selenium"}, {"webdriver", "WebDriver"},
	}
	tests := false
	found := ""
	for i, p := range up {
		line := strings.ToLower(strings.Join(p.Args, " "))
		if i == 0 {
			line = strings.ToLower(root.Exe)
		}
		for _, t := range tools {
			if found == "" && strings.Contains(line, t.needle) {
				found = t.name
			}
		}
		for _, a := range p.Args {
			a = strings.ToLower(a)
			if a == "test" || a == "e2e" || strings.HasSuffix(a, ".spec.ts") || strings.HasSuffix(a, ".test.ts") || strings.HasPrefix(a, "test:") {
				tests = true
			}
		}
	}
	switch {
	case found == "Vitest" || found == "Jest" || found == "Cypress":
		return found + " tests"
	case found != "" && found != "agent-browser" && tests:
		return found + " tests"
	}
	return found
}

// owner says who started b.
func owner(b *BoxBrowser, root procStat, byPID map[int]procStat, w procWorld) {
	b.Stoppable = true
	if st, ok := w.agent[root.PID]; ok {
		b.Owner, b.Location, b.Worktree, b.path = OwnerAgent, st.Location, st.Worktree, st.Path
		b.Label = "Agent browser for " + st.Location + "/" + st.Worktree
		return
	}
	up := ancestors(root, byPID)
	b.Via = via(root, up)
	switch root.Env["BERTH_BROWSER"] {
	case "shots", "agent":
		if root.PPID == w.self {
			b.Owner, b.Label = OwnerAgent, "Visual diff browser"
			return
		}
		b.Owner, b.Label = OwnerOrphan, "Agent browser left by an earlier berthd"
		return
	}
	// Whose session: a pane or scope it runs under, or the marker it
	// carries from berth's tmux server.
	session := ""
	for _, p := range up {
		if s, ok := w.panes[p.PID]; ok {
			session = s
			break
		}
		if unit := path.Base(p.Cgroup); strings.HasPrefix(unit, "berth-") {
			if s, ok := w.scopes[unit]; ok {
				session = s
				break
			}
		}
	}
	if session == "" && root.Env["BERTH_SESSION"] != "" && sameSocket(root.Env["TMUX"], w.socket) {
		session = root.Env["BERTH_SESSION"]
	}
	sess, live := w.sessions[session]
	live = live && !sess.Exited
	if root.Env["AGENT_BROWSER_DAEMON"] != "" && session != "" {
		b.Via = "agent-browser"
		name := root.Env["AGENT_BROWSER_SESSION"]
		if name == "" {
			name = "default"
		}
		b.Owner, b.Session = OwnerAgentBrowser, session
		if live {
			b.Location = sess.Location
			b.Label = fmt.Sprintf("agent-browser %q of %s", name, sessionWhere(sess))
		} else {
			b.Owner = OwnerOrphan
			b.Label = fmt.Sprintf("agent-browser %q left by ended session %s", name, session)
		}
		return
	}
	what := b.Via
	if what == "" || what == "agent-browser" {
		what = b.Engine
	}
	switch {
	case session != "" && live:
		b.Owner, b.Session, b.Location = OwnerSession, session, sess.Location
		b.Label = what + " in " + sessionWhere(sess)
	case session != "":
		b.Owner, b.Session = OwnerOrphan, session
		b.Label = what + " left by ended session " + session
	default:
		b.Owner, b.Stoppable = OwnerOther, false
		b.Label = what + ", not started by Terminal"
	}
}

// sessionWhere names a session for people: its location and worktree, or
// its name.
func sessionWhere(s Session) string {
	if s.Location != "" {
		return s.Location
	}
	return s.Name
}

// world gathers what grouping needs.
func (b *Box) procWorld(ctx context.Context) (procWorld, []Session) {
	w := procWorld{agent: map[int]BrowserStatus{}, sessions: map[string]Session{}, panes: map[int]string{}, scopes: map[string]string{},
		socket: tmuxSocketPath(), self: os.Getpid()}
	if b.Browsers != nil {
		for _, st := range b.Browsers.mains() {
			w.agent[st.PID] = st
		}
	}
	var all []Session
	if b.Sessions != nil {
		all, _ = b.Sessions.list(ctx)
		for _, s := range all {
			w.sessions[s.Name] = s
			if s.panePID > 1 {
				w.panes[s.panePID] = s.Name
			}
			if s.Scope != "" {
				w.scopes[s.Scope] = s.Name
			}
		}
	}
	return w, all
}

// Processes is the box's browsers and what its sessions use.
func (b *Box) Processes(ctx context.Context, withSessions bool) (BoxProcesses, error) {
	ps, err := b.procSampler.Snapshot()
	if err != nil {
		return BoxProcesses{}, err
	}
	w, sessions := b.procWorld(ctx)
	out := BoxProcesses{Browsers: groupBrowsers(ps, w), At: time.Now().UTC()}
	if out.Browsers == nil {
		out.Browsers = []BoxBrowser{}
	}
	if b.Sessions != nil && b.Sessions.Scopes != nil {
		out.Scopes = b.Sessions.Scopes.Available(ctx)
	}
	if withSessions {
		out.Sessions = b.sessionsUsage(ctx, ps, sessions, w)
	}
	return out, nil
}

// sessionsUsage is what each session's processes use, busiest first.
func (b *Box) sessionsUsage(ctx context.Context, ps []procStat, sessions []Session, w procWorld) []BoxSessionProcs {
	byCgroup := map[string][]procStat{}
	for _, p := range ps {
		if unit := path.Base(p.Cgroup); strings.HasPrefix(unit, "berth-") {
			byCgroup[unit] = append(byCgroup[unit], p)
		}
	}
	out := []BoxSessionProcs{}
	for _, s := range sessions {
		e := BoxSessionProcs{ID: "s-" + s.Name, Name: s.Name, Location: s.Location, Title: s.Title, Agent: agentFor(s), Scope: s.Scope}
		var procs []procStat
		if u, ok := b.Sessions.scopeUsage(ctx, s); ok {
			e.Usage = u
			procs = byCgroup[s.Scope]
		} else {
			var panes []int
			if s.panePID > 1 {
				panes = []int{s.panePID}
			}
			procs = sessionProcs(ps, s.Name, panes, w.socket, time.Time{}, useMarkers)
			for _, p := range procs {
				e.Usage.Memory += p.RSS
				e.Usage.CPUSeconds += p.CPU
			}
			e.Usage.Processes = len(procs)
		}
		for _, p := range procs {
			e.Usage.CPUPercent += p.CPUPercent
		}
		e.Usage.CPUPercent = float64(int(e.Usage.CPUPercent*10+0.5)) / 10
		if e.Usage.Processes == 0 {
			continue
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Usage.Memory > out[j].Usage.Memory })
	return out
}

// errNotOurs refuses to stop what berth didn't start.
var errNotOurs = errors.New("Terminal didn't start this browser, so it leaves it alone; stop it on the box if you mean to")

// StopProcess stops one browser or ends one session, by its ID in the
// list, and says what it did.
func (b *Box) StopProcess(ctx context.Context, id string) (string, error) {
	if name, ok := strings.CutPrefix(id, "s-"); ok {
		if err := b.Sessions.Kill(ctx, name); err != nil {
			return "", err
		}
		return "Ended session " + name + " and everything it started", nil
	}
	list, err := b.Processes(ctx, false)
	if err != nil {
		return "", err
	}
	for _, br := range list.Browsers {
		if br.ID != id {
			continue
		}
		if !br.Stoppable {
			return "", httpError{http.StatusForbidden, errNotOurs.Error()}
		}
		if br.Owner == OwnerAgent && br.path != "" && b.Browsers != nil {
			b.Browsers.Close(br.path, "stopped from the box's processes")
			return "Closed " + br.Label, nil
		}
		b.Sessions.stopProcs(br.procs)
		for _, dir := range agentBrowserProfiles(br.procs) {
			os.RemoveAll(dir)
		}
		return "Stopped " + br.Label + fmt.Sprintf(" (%d %s)", br.Processes, "process"+pluralES(br.Processes)), nil
	}
	return "", httpError{http.StatusNotFound, "no such browser or session on this box now; it may have ended"}
}

func pluralES(n int) string {
	if n == 1 {
		return ""
	}
	return "es"
}

// agentBrowserProfiles are the throwaway profiles agent-browser made for
// these processes, which go with them.
func agentBrowserProfiles(procs []procStat) []string {
	var out []string
	for _, p := range procs {
		for _, a := range p.Args {
			if dir, ok := strings.CutPrefix(a, "--user-data-dir="); ok && isAgentBrowserProfile(dir) {
				out = append(out, dir)
			}
		}
	}
	return out
}

// listProcesses is GET /v1/processes[?kind=browser].
func (b *Box) listProcesses(w http.ResponseWriter, r *http.Request) error {
	kind := r.URL.Query().Get("kind")
	if kind != "" && kind != "browser" {
		return badRequest("kind must be browser, or none for browsers and sessions")
	}
	list, err := b.Processes(r.Context(), kind == "")
	if errors.Is(err, errNoProcs) {
		writeJSON(w, BoxProcesses{Browsers: []BoxBrowser{}, At: time.Now().UTC()})
		return nil
	}
	if err != nil {
		return err
	}
	writeJSON(w, list)
	return nil
}

// stopProcess is POST /v1/processes/{id}/stop.
func (b *Box) stopProcess(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	if err := b.before(r, "process.stop", map[string]any{"id": id}); err != nil {
		return err
	}
	text, err := b.StopProcess(r.Context(), id)
	if err != nil {
		return err
	}
	b.Events.Publish(events.Event{Type: "process.stopped", Box: b.Name, Origin: "processes", Data: map[string]any{"id": id, "text": text}})
	writeJSON(w, map[string]string{"stopped": id, "text": text})
	return nil
}

// describe is one line for a browser in doctor and ps output.
func (br BoxBrowser) describe() string {
	return fmt.Sprintf("%s: %.0f%% CPU, %s, %s old", br.Label, br.CPUPercent, gbOrMB(br.Memory), age(br.Started))
}

func gbOrMB(n uint64) string {
	if n >= 1<<30 {
		return strings.TrimSuffix(fmt.Sprintf("%.1f", float64(n)/(1<<30)), ".0") + " GB"
	}
	return fmt.Sprintf("%d MB", n>>20)
}

func age(t time.Time) string {
	if t.IsZero() {
		return "?"
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}
