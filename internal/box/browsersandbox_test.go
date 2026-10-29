package box

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
	"github.com/cosscom/shipyard/internal/hooks"
)

// fakeUserns stands in for Ubuntu's setting, as BERTH_TEST_USERNS_SYSCTL
// does on a box being tested: while it says 1, Chromium is refused its
// sandbox without being started.
func fakeUserns(t *testing.T, v string) func(string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "userns")
	set := func(v string) {
		if err := os.WriteFile(p, []byte(v+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	set(v)
	t.Setenv("BERTH_TEST_USERNS_SYSCTL", p)
	t.Setenv("BERTH_BROWSER_NO_SANDBOX", "")
	return set
}

func TestBrowserHealthSaysWhyABrowserCantStartWithoutStartingOne(t *testing.T) {
	set := fakeUserns(t, "1")
	b := &Box{Name: "devbox", Events: &events.Bus{}}
	m := b.NewBrowsers(t.TempDir(), 1)

	// Before anything tried: the setting alone says it would be refused.
	h := m.Health()
	if h.State != "sandbox" || !h.Likely || h.Userns != "1" || h.Fix != SandboxFix || h.NoSandbox {
		t.Fatalf("before a start: %+v", h)
	}

	// A start is refused, and remembered.
	if err := m.Check(context.Background()); !errors.Is(err, ErrBrowserSandbox) {
		t.Fatalf("check: %v, want the sandbox", err)
	}
	h = m.Health()
	if h.State != "sandbox" || h.Likely || h.At == nil || !strings.Contains(h.Error, "Settings → Boxes") {
		t.Fatalf("after a refused start: %+v", h)
	}

	// The person ran the fix: the setting reads 0, and that is enough.
	set("0")
	if h = m.Health(); h.State != "ok" || h.Fix != "" {
		t.Fatalf("after the fix: %+v", h)
	}
	// sudo was refused or cancelled: nothing changed, still blocked.
	set("1")
	if h = m.Health(); h.State != "sandbox" {
		t.Fatalf("still restricted: %+v", h)
	}

	// The box's setting starts Chromium without its sandbox, at once.
	if err := m.SetSettings(BrowserSettings{NoSandbox: true}); err != nil {
		t.Fatal(err)
	}
	if h = m.Health(); h.State != "ok" || !h.NoSandbox || h.NoSandboxFrom != "setting" || !h.Setting.NoSandbox {
		t.Fatalf("with no_sandbox: %+v", h)
	}
	if err := m.simulatedSandbox(); err != nil {
		t.Fatalf("a start with no_sandbox is still refused: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(m.Dir, "settings.json")); !strings.Contains(string(b), `"no_sandbox": true`) {
		t.Fatalf("settings.json: %s", b)
	}

	// BERTH_BROWSER_NO_SANDBOX keeps working, and wins either way.
	t.Setenv("BERTH_BROWSER_NO_SANDBOX", "0")
	if h = m.Health(); h.NoSandbox || h.NoSandboxFrom != "env" || h.State != "sandbox" {
		t.Fatalf("env 0 over the setting: %+v", h)
	}
	m.SetSettings(BrowserSettings{})
	t.Setenv("BERTH_BROWSER_NO_SANDBOX", "1")
	if h = m.Health(); !h.NoSandbox || h.NoSandboxFrom != "env" || h.State != "ok" || h.Env != "1" {
		t.Fatalf("env 1: %+v", h)
	}
	t.Setenv("BERTH_BROWSER_NO_SANDBOX", "")

	// A start that works clears it; another failure is told apart.
	m.noteStart(nil)
	if h = m.Health(); h.State != "ok" {
		t.Fatalf("after a start: %+v", h)
	}
	m.noteStart(errors.New("starting Chromium: it crashed"))
	if h = m.Health(); h.State != "error" || h.Error != "starting Chromium: it crashed" || h.Fix != "" {
		t.Fatalf("another failure: %+v", h)
	}
	// No Chromium at all is not a failure to remember.
	m.noteStart(nil)
	m.noteStart(errNoChromium)
	if h = m.Health(); h.State != "ok" {
		t.Fatalf("no Chromium: %+v", h)
	}

	// The doctor says it with the same two ways out.
	set("1")
	m.noteStart(sandboxError("1"))
	checks := browserSandboxChecks(m.Health())
	if len(checks) != 1 || !strings.Contains(checks[0].Fix, SandboxFix) || !strings.Contains(checks[0].Fix, "without Chromium's sandbox") || !strings.Contains(checks[0].Fix, "Settings → Boxes") {
		t.Fatalf("doctor: %+v", checks)
	}
}

func TestTheSandboxErrorIsShortAndTellsTheAgentWhoFixesIt(t *testing.T) {
	err := sandboxError("1")
	msg := err.Error()
	if !errors.Is(err, ErrBrowserSandbox) || statusFor(err) != 503 || codeFor(err) != CodeBrowserBlock {
		t.Fatalf("%v: status %d, code %s", err, statusFor(err), codeFor(err))
	}
	for _, want := range []string{"blocked by Ubuntu's sandbox setting", "ask the person to fix it from Terminal (Settings → Boxes)", "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0", "Don't work around it"} {
		if !strings.Contains(msg, want) {
			t.Errorf("lacks %q: %s", want, msg)
		}
	}
	if len(msg) > 320 {
		t.Errorf("%d bytes is long for an agent: %s", len(msg), msg)
	}
	if other := sandboxError("").Error(); strings.Contains(other, "sysctl") || !strings.Contains(other, "Settings → Boxes") {
		t.Errorf("without the setting: %s", other)
	}
}

func TestAProfileOrASnapLetsChromiumMakeNamespaces(t *testing.T) {
	dir := t.TempDir()
	was := apparmorDir
	apparmorDir = dir
	t.Cleanup(func() { apparmorDir = was })
	os.WriteFile(filepath.Join(dir, "chrome"), []byte("abi <abi/4.0>,\nprofile chrome /opt/google/chrome/chrome flags=(unconfined) {\n  userns,\n}\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "other"), []byte("profile other /usr/bin/other {\n}\n"), 0o644)
	for bin, want := range map[string]bool{
		"/opt/google/chrome/chrome":                           true,
		"/snap/chromium/3000/usr/lib/chromium-browser/chrome": true,
		"/home/me/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell": false,
		"/usr/bin/other": false,
	} {
		if got := profileAllowsUserns(bin); got != want {
			t.Errorf("%s: %v, want %v", bin, got, want)
		}
	}
}

func TestTheSandboxSettingOverTheAPI(t *testing.T) {
	fakeUserns(t, "1")
	dir := t.TempDir()
	cfg := filepath.Join(dir, "hooks.json")
	var bx *Box
	c, bus := servedBox(t, func(b *Box) {
		b.NewBrowsers(filepath.Join(dir, "browser"), 1)
		b.Hooks = &hooks.Runner{Path: cfg}
		bx = b
	})
	evs, unsub := bus.Subscribe()
	defer unsub()
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "cal", "path": repo}, nil)
	var locs []Location
	call(t, c, "GET", "/v1/locations", "", nil, &locs)
	if len(locs) != 1 || len(locs[0].Worktrees) == 0 {
		t.Fatalf("locations: %+v", locs)
	}
	wt := locs[0].Worktrees[0].Name

	var h BrowserHealth
	if status := call(t, c, "GET", "/v1/browser/health", "", nil, &h); status != 200 || h.State != "sandbox" || h.Userns != "1" {
		t.Fatalf("health: %d %+v", status, h)
	}

	// An agent opening it gets the short answer, coded.
	var refused struct{ Error, Code string }
	if status := call(t, c, "POST", "/v1/worktrees/cal/"+wt+"/browser/open", "", map[string]string{}, &refused); status != 503 || refused.Code != CodeBrowserBlock || !strings.Contains(refused.Error, "Settings → Boxes") {
		t.Fatalf("open: %d %+v", status, refused)
	}
	var st struct {
		Running bool
		Text    string
		Health  *BrowserHealth
	}
	call(t, c, "GET", "/v1/worktrees/cal/"+wt+"/browser/status", "", nil, &st)
	if st.Running || st.Health == nil || st.Health.State != "sandbox" || st.Health.Likely {
		t.Fatalf("status: %+v", st)
	}

	// The setting is a change to the box, so a gate decides.
	os.WriteFile(cfg, []byte(`{"hooks":[{"on":"before:config.change","run":"echo \"no $BERTH_EVENT\"; exit 1"}]}`), 0o600)
	if status := call(t, c, "PUT", "/v1/browser/settings", "", BrowserSettings{NoSandbox: true}, &refused); status != 403 || !strings.Contains(refused.Error, "no config.change") {
		t.Fatalf("gated: %d %+v", status, refused)
	}
	if bx.Browsers.Settings().NoSandbox {
		t.Fatal("a refused change was saved")
	}
	os.Remove(cfg)
	if status := call(t, c, "PUT", "/v1/browser/settings", "", BrowserSettings{NoSandbox: true}, &h); status != 200 || h.State != "ok" || !h.NoSandbox || h.NoSandboxFrom != "setting" {
		t.Fatalf("set: %d %+v", status, h)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case e := <-evs:
			if e.Type == "config.changed" && e.Data["browser_no_sandbox"] == true {
				return
			}
		case <-deadline:
			t.Fatal("no config.changed event")
		}
	}
}
