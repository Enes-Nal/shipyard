package box

import (
	"net/http"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const (
	pwShell = "/home/acme/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell"
	ourSelf = 999
)

// boxProcsFixture is a box's processes: a session's Playwright tests and
// their browser, a browser left by a session that ended, berth's own agent
// browser, an agent-browser session, the user's own Chrome, a Firefox
// started in a scoped session that double-forked out of its pane, and a
// crash reporter on its own.
func boxProcsFixture(socket string) []procStat {
	tmux := socket + ",4242,0"
	start := time.Now().Add(-12 * time.Minute)
	p := func(pid, ppid int, exe string, cpu float64, rss uint64, env map[string]string, args ...string) procStat {
		return procStat{PID: pid, PPID: ppid, Name: exe[strings.LastIndex(exe, "/")+1:], Exe: exe, Args: append([]string{exe}, args...),
			CPUPercent: cpu, RSS: rss << 20, Env: env, Start: start, StartKey: uint64(pid) * 7}
	}
	sess := map[string]string{"BERTH_SESSION": "acme-task", "TMUX": tmux}
	old := map[string]string{"BERTH_SESSION": "old-task", "TMUX": tmux}
	ab := map[string]string{"BERTH_SESSION": "acme-task", "TMUX": tmux, "AGENT_BROWSER_DAEMON": "1", "AGENT_BROWSER_SESSION": "qa"}
	ps := []procStat{
		p(200, 1, "/usr/bin/claude", 5, 300, sess),
		p(201, 200, "/usr/bin/node", 20, 200, sess, "/w/acme/node_modules/.bin/playwright", "test"),
		p(202, 201, pwShell, 30, 150, sess, "--headless", "--remote-debugging-pipe"),
		p(203, 202, pwShell, 150, 400, sess, "--type=renderer"),
		p(204, 202, pwShell, 300, 250, sess, "--type=gpu-process", "--use-angle=swiftshader"),
		p(300, 1, pwShell, 90, 100, old, "--headless"),
		p(301, 300, pwShell, 10, 300, old, "--type=renderer"),
		p(400, ourSelf, pwShell, 1, 120, map[string]string{"BERTH_BROWSER": "agent"}, "--headless=new"),
		p(401, 400, pwShell, 1, 80, map[string]string{"BERTH_BROWSER": "agent"}, "--type=renderer"),
		p(500, 200, "/home/acme/.npm/_npx/agent-browser-linux-x64", 0, 30, ab),
		p(501, 500, "/opt/google/chrome/chrome", 4, 200, ab, "--headless=new", "--user-data-dir=/tmp/agent-browser-chrome-abc"),
		p(600, 1, "/opt/google/chrome/chrome", 2, 500, nil),
		p(601, 600, "/opt/google/chrome/chrome", 1, 300, nil, "--type=renderer"),
		p(700, 1, "/usr/bin/node", 1, 50, nil, "server.js"),
		p(701, 700, "/usr/lib/firefox/firefox", 3, 250, nil, "--headless"),
		p(702, 701, "/usr/lib/firefox/firefox", 2, 150, nil, "-contentproc", "tab"),
		p(800, 1, "/opt/google/chrome/chrome_crashpad_handler", 0, 5, nil, "--monitor-self"),
	}
	for i := range ps {
		if ps[i].PID >= 700 && ps[i].PID < 800 {
			ps[i].Cgroup = "/user.slice/user-501.slice/user@501.service/app.slice/berth-acme-two-abc.scope"
		}
	}
	return ps
}

func fixtureWorld(socket string) procWorld {
	return procWorld{
		agent: map[int]BrowserStatus{400: {Location: "acme", Worktree: "billing", Path: "/w/acme-billing", PID: 400}},
		sessions: map[string]Session{
			"acme-task": {Name: "acme-task", Location: "acme/checkout", panePID: 200},
			"acme-two":  {Name: "acme-two", Location: "acme/search", Scope: "berth-acme-two-abc.scope", panePID: 650},
		},
		panes:  map[int]string{200: "acme-task", 650: "acme-two"},
		scopes: map[string]string{"berth-acme-two-abc.scope": "acme-two"},
		socket: socket,
		self:   ourSelf,
	}
}

func TestBrowsersAreGroupedWithWhoStartedThem(t *testing.T) {
	socket := "/tmp/tmux-501/berth"
	got := groupBrowsers(boxProcsFixture(socket), fixtureWorld(socket))
	by := map[int]BoxBrowser{}
	for _, b := range got {
		by[b.PID] = b
	}
	if len(got) != 6 {
		for _, b := range got {
			t.Logf("%d %s %s", b.PID, b.Owner, b.Label)
		}
		t.Fatalf("got %d browsers, want 6 (no crash reporter on its own)", len(got))
	}
	// The busiest first: the session's Playwright tests.
	pw := got[0]
	if pw.PID != 202 || pw.Owner != OwnerSession || pw.Session != "acme-task" || pw.Label != "Playwright tests in acme/checkout" ||
		pw.Processes != 3 || pw.CPUPercent != 480 || pw.Memory != 800<<20 || pw.Engine != "Headless Chromium" || !pw.Stoppable {
		t.Fatalf("Playwright's browser = %+v", pw)
	}
	if !slices.Equal(pw.PIDs, []int{202, 203, 204}) {
		t.Fatalf("its processes = %v", pw.PIDs)
	}
	if b := by[300]; b.Owner != OwnerOrphan || b.Session != "old-task" || b.Label != "Playwright left by ended session old-task" || !b.Stoppable {
		t.Fatalf("orphan = %+v", b)
	}
	if b := by[400]; b.Owner != OwnerAgent || b.Location != "acme" || b.Worktree != "billing" || b.Label != "Agent browser for acme/billing" {
		t.Fatalf("agent browser = %+v", b)
	}
	if b := by[501]; b.Owner != OwnerAgentBrowser || b.Session != "acme-task" || b.Via != "agent-browser" || !strings.Contains(b.Label, `"qa" of acme/checkout`) {
		t.Fatalf("agent-browser = %+v", b)
	}
	if b := by[600]; b.Owner != OwnerOther || b.Stoppable || b.Engine != "Chrome" || b.Processes != 2 {
		t.Fatalf("the user's own Chrome = %+v", b)
	}
	if b := by[701]; b.Owner != OwnerSession || b.Session != "acme-two" || b.Engine != "Firefox" || b.Processes != 2 || b.Label != "Firefox in acme/search" {
		t.Fatalf("a scoped session's Firefox = %+v", b)
	}
}

func TestBrowserKind(t *testing.T) {
	for _, c := range []struct {
		p      procStat
		engine string
		helper bool
	}{
		{procStat{Exe: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}, "Chrome", false},
		{procStat{Exe: "/Applications/Google Chrome.app/Contents/Frameworks/x/Google Chrome Helper (Renderer)", Args: []string{"x", "--type=renderer"}}, "Chrome", true},
		{procStat{Exe: "/snap/chromium/1/usr/lib/chromium-browser/chrome", Args: []string{"chrome", "--headless"}}, "Headless Chromium", false},
		{procStat{Name: "chromium", Args: []string{"chromium", "--type=zygote"}}, "Chromium", true},
		{procStat{Exe: "/usr/lib/firefox/firefox", Args: []string{"firefox", "-contentproc"}}, "Firefox", true},
	} {
		engine, helper, ok := browserKind(c.p)
		if !ok || engine != c.engine || helper != c.helper {
			t.Errorf("%s: %q %v %v", c.p.Exe+c.p.Name, engine, helper, ok)
		}
	}
	for _, exe := range []string{"/usr/bin/node", "/usr/bin/chromedriver", "/usr/bin/agent-browser"} {
		if _, _, ok := browserKind(procStat{Exe: exe}); ok {
			t.Errorf("%s taken for a browser", exe)
		}
	}
}

// fakeProcs stands in for the system: a fixed set of processes that end
// when signalled.
type fakeProcs struct {
	mu     sync.Mutex
	ps     []procStat
	killed map[int]syscall.Signal
}

func (f *fakeProcs) snap() ([]procStat, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []procStat
	for _, p := range f.ps {
		if _, gone := f.killed[p.PID]; !gone {
			out = append(out, p)
		}
	}
	return out, nil
}

func (f *fakeProcs) signal(pid int, sig syscall.Signal) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.killed == nil {
		f.killed = map[int]syscall.Signal{}
	}
	f.killed[pid] = sig
}

func TestTheProcessesAPIListsBrowsersAndStopsOnlyTerminals(t *testing.T) {
	var fake fakeProcs
	c, _ := servedBox(t, func(b *Box) {
		fake.ps = boxProcsFixture(tmuxSocketPath())
		b.procSampler.snap = fake.snap
		b.Sessions.procs = fake.snap
		b.Sessions.signal = fake.signal
	})
	var list BoxProcesses
	if code := call(t, c, "GET", "/v1/processes?kind=browser", "", nil, &list); code != 200 {
		t.Fatalf("list: %d", code)
	}
	ids := map[int]BoxBrowser{}
	for _, b := range list.Browsers {
		ids[b.PID] = b
	}
	// No session runs in this box's tmux, so a session's browsers are left
	// by ended sessions; berthd's own browser isn't this test's.
	if b := ids[300]; b.Owner != OwnerOrphan || b.ID == "" {
		t.Fatalf("orphan = %+v (all %+v)", b, list.Browsers)
	}
	var res struct{ Text string }
	if code := call(t, c, "POST", "/v1/processes/"+ids[600].ID+"/stop", "", nil, &res); code != http.StatusForbidden {
		t.Fatalf("stopping the user's own Chrome: %d", code)
	}
	if code := call(t, c, "POST", "/v1/processes/"+ids[300].ID+"/stop", "", nil, &res); code != 200 || !strings.Contains(res.Text, "Stopped") {
		t.Fatalf("stop: %d %q", code, res.Text)
	}
	fake.mu.Lock()
	if fake.killed[300] != syscall.SIGTERM || fake.killed[301] != syscall.SIGTERM || len(fake.killed) != 2 {
		t.Fatalf("signalled %v, want only the orphan's two processes", fake.killed)
	}
	fake.mu.Unlock()
	if code := call(t, c, "POST", "/v1/processes/b-12345-1/stop", "", nil, &res); code != http.StatusNotFound {
		t.Fatalf("an unknown id: %d", code)
	}
}
