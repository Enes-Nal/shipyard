package box

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/statefile"
)

// Chromium's sandbox. Ubuntu 24.04 (and others) stop unprivileged programs
// making the user namespaces Chromium's sandbox needs
// (kernel.apparmor_restrict_unprivileged_userns=1), so the agent's browser
// can't start there. berthd remembers why a browser last failed to start,
// reads the setting's current value, and says so cheaply, without starting
// Chromium to find out. The fix needs the box's owner: either allow it with
// sudo (SandboxFix, which Terminal types into a terminal for them and never
// runs itself), or turn on the box's no_sandbox setting, which starts
// Chromium without its sandbox; Terminal's proxy still confines it to the
// worktree's own pages.

// usernsPath is the sysctl's file. BERTH_TEST_USERNS_SYSCTL names another
// file in its place, for testing on a box without it: berthd then reads
// that file and, while it says 1, refuses to start Chromium with its
// sandbox as Ubuntu would, without starting it.
const usernsPath = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"

// SandboxFix allows Chromium's sandbox now and after a restart.
const SandboxFix = "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 && echo kernel.apparmor_restrict_unprivileged_userns=0 | sudo tee /etc/sysctl.d/60-chromium.conf"

// apparmorDir holds the profiles that can let one program make namespaces
// despite the setting (Google Chrome's package ships one).
var apparmorDir = "/etc/apparmor.d"

// ErrBrowserSandbox is a Chromium that could not start its sandbox. What an
// agent reads after it is short and says who can fix it.
var ErrBrowserSandbox = errors.New("the box's browser is blocked")

func sandboxError(userns string) error {
	if userns == "1" {
		return fmt.Errorf("%w by Ubuntu's sandbox setting (kernel.apparmor_restrict_unprivileged_userns=1); ask the person to fix it from Terminal (Settings → Boxes), or to run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` in a terminal on the box. Don't work around it", ErrBrowserSandbox)
	}
	return fmt.Errorf("%w: Chromium could not start its sandbox on this box; ask the person to fix it from Terminal (Settings → Boxes). Don't work around it", ErrBrowserSandbox)
}

// BrowserSettings are the box owner's choices for agents' browsers, in
// <state>/browser/settings.json.
type BrowserSettings struct {
	// NoSandbox starts Chromium without its own sandbox.
	NoSandbox bool `json:"no_sandbox"`
}

// BrowserHealth is whether agents' browsers can start on this box, and if
// not, why.
type BrowserHealth struct {
	// State is ok, sandbox (Chromium's sandbox can't start) or error (it
	// failed to start for another reason).
	State string `json:"state"`
	// Likely is a sandbox state judged from the box's settings, before any
	// browser tried to start.
	Likely bool `json:"likely,omitempty"`
	// Userns is the sysctl's value ("1" restricts), empty where the box
	// has no such setting.
	Userns string `json:"userns,omitempty"`
	// NoSandbox is whether browsers start without Chromium's sandbox, and
	// NoSandboxFrom what says so: "env" (BERTH_BROWSER_NO_SANDBOX, which
	// wins) or "setting".
	NoSandbox     bool   `json:"no_sandbox"`
	NoSandboxFrom string `json:"no_sandbox_from,omitempty"`
	// Env is BERTH_BROWSER_NO_SANDBOX's value when it is set.
	Env     string          `json:"env,omitempty"`
	Setting BrowserSettings `json:"setting"`
	// Error is what the last failed start said, and At when it was.
	Error string     `json:"error,omitempty"`
	At    *time.Time `json:"at,omitempty"`
	// Fix is the command that allows the sandbox, when that is the fix.
	Fix string `json:"fix,omitempty"`
	// Viewport is the size a browser opens at unless an agent chose
	// another for its worktree, and Size it as text.
	Viewport Viewport `json:"viewport"`
	Size     string   `json:"size"`
	Text     string   `json:"text"`
}

// startFailure is the last browser start that failed, until one succeeds.
type startFailure struct {
	sandbox bool
	userns  string
	err     string
	at      time.Time
}

func testUsernsPath() string { return os.Getenv("BERTH_TEST_USERNS_SYSCTL") }

// readUserns is the sysctl's current value, "" where there is none.
func readUserns() string {
	p := usernsPath
	if t := testUsernsPath(); t != "" {
		p = t
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func (m *Browsers) settingsPath() string { return filepath.Join(m.Dir, "settings.json") }

// Settings are the owner's saved choices.
func (m *Browsers) Settings() BrowserSettings {
	var s BrowserSettings
	if b, err := os.ReadFile(m.settingsPath()); err == nil {
		json.Unmarshal(b, &s)
	}
	return s
}

// SetSettings saves them; the next browser to start follows them.
func (m *Browsers) SetSettings(s BrowserSettings) error {
	if err := os.MkdirAll(m.Dir, 0o700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(s, "", "  ")
	if err := statefile.Write(m.settingsPath(), append(data, '\n')); err != nil {
		return err
	}
	m.mu.Lock()
	m.likelyAt = time.Time{}
	m.mu.Unlock()
	return nil
}

// noSandbox is whether browsers start without Chromium's sandbox, and
// why: BERTH_BROWSER_NO_SANDBOX when set (1 or not), else the setting.
func (m *Browsers) noSandbox() (bool, string) {
	if v := os.Getenv("BERTH_BROWSER_NO_SANDBOX"); v != "" {
		return v == "1", "env"
	}
	if m.Settings().NoSandbox {
		return true, "setting"
	}
	return false, ""
}

// noteStart remembers how a start went: a failure until a start succeeds.
func (m *Browsers) noteStart(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err == nil {
		m.failure, m.startedOK = nil, true
		return
	}
	if errors.Is(err, errNoChromium) {
		return // doctor and status say that on their own
	}
	m.failure = &startFailure{sandbox: errors.Is(err, ErrBrowserSandbox), userns: readUserns(), err: err.Error(), at: time.Now()}
}

// Health says whether a browser can start, without starting one.
func (m *Browsers) Health() BrowserHealth {
	h := BrowserHealth{State: "ok", Userns: readUserns(), Setting: m.Settings(), Env: os.Getenv("BERTH_BROWSER_NO_SANDBOX"), Viewport: DefaultViewport, Size: DefaultViewport.String()}
	h.NoSandbox, h.NoSandboxFrom = m.noSandbox()
	m.mu.Lock()
	fail, startedOK := m.failure, m.startedOK
	m.mu.Unlock()
	switch {
	case fail != nil && fail.sandbox:
		// Fixed since: the browser now starts without the sandbox, or the
		// setting that stopped it was turned off.
		if h.NoSandbox || (fail.userns == "1" && h.Userns == "0") {
			break
		}
		h.State, h.Error = "sandbox", fail.err
		at := fail.at
		h.At = &at
	case fail != nil:
		h.State, h.Error = "error", fail.err
		at := fail.at
		h.At = &at
	case !startedOK && !h.NoSandbox && h.Userns == "1" && m.likelyBlocked():
		h.State, h.Likely = "sandbox", true
	}
	if h.State == "sandbox" && h.Userns == "1" {
		h.Fix = SandboxFix
	}
	switch {
	case h.State == "sandbox" && h.Userns == "1":
		h.Text = "Ubuntu's sandbox setting (kernel.apparmor_restrict_unprivileged_userns=1) stops Chromium's sandbox, so agents' browsers can't start"
	case h.State == "sandbox":
		h.Text = "Chromium could not start its sandbox on this box, so agents' browsers can't start"
	case h.State == "error":
		h.Text = "the last browser failed to start: " + h.Error
	case h.NoSandbox:
		h.Text = "browsers start without Chromium's sandbox; Terminal's proxy still confines them to the worktree's own pages"
	default:
		h.Text = "browsers can start; pages open at " + DefaultViewport.String() + " unless an agent sets a size"
	}
	return h
}

// likelyBlocked is whether Chromium would be refused its sandbox: a
// Chromium is installed, outside a snap (snaps confine themselves) and
// with no AppArmor profile that lets it make namespaces. Kept a minute.
func (m *Browsers) likelyBlocked() bool {
	m.mu.Lock()
	if time.Since(m.likelyAt) < time.Minute {
		v := m.likely
		m.mu.Unlock()
		return v
	}
	m.mu.Unlock()
	v := false
	if testUsernsPath() != "" {
		v = true
	} else if runtime.GOOS == "linux" {
		bin := m.Chromium
		if bin == "" {
			bin, _ = FindChromium()
		}
		if bin != "" {
			v = !profileAllowsUserns(bin)
		}
	}
	m.mu.Lock()
	m.likely, m.likelyAt = v, time.Now()
	m.mu.Unlock()
	return v
}

// profileAllowsUserns is whether bin runs in a snap or under an AppArmor
// profile that grants it user namespaces.
func profileAllowsUserns(bin string) bool {
	if real, err := filepath.EvalSymlinks(bin); err == nil {
		bin = real
	}
	if strings.HasPrefix(bin, "/snap/") {
		return true
	}
	entries, err := os.ReadDir(apparmorDir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if !e.Type().IsRegular() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(apparmorDir, e.Name()))
		if err != nil || len(b) > 256<<10 {
			continue
		}
		s := string(b)
		if strings.Contains(s, bin) && strings.Contains(s, "userns") {
			return true
		}
	}
	return false
}

// The box-wide browser API:
//
//	GET  /v1/browser/health     BrowserHealth
//	PUT  /v1/browser/settings   {no_sandbox}: behind before:config.change
//	POST /v1/browser/check      starts Chromium once, closes it, and says how it went

func (b *Box) browserHealth(w http.ResponseWriter, r *http.Request) error {
	if b.Browsers == nil {
		return httpError{http.StatusNotFound, "this box has no agent browser"}
	}
	writeJSON(w, b.Browsers.Health())
	return nil
}

func (b *Box) putBrowserSettings(w http.ResponseWriter, r *http.Request) error {
	if b.Browsers == nil {
		return httpError{http.StatusNotFound, "this box has no agent browser"}
	}
	var req BrowserSettings
	if err := decode(r, &req); err != nil {
		return err
	}
	if err := b.before(r, "config.change", map[string]any{"browser_no_sandbox": req.NoSandbox}); err != nil {
		return err
	}
	if err := b.Browsers.SetSettings(req); err != nil {
		return err
	}
	b.publish(r, "config.changed", map[string]any{"browser_no_sandbox": req.NoSandbox})
	writeJSON(w, b.Browsers.Health())
	return nil
}

func (b *Box) checkBrowser(w http.ResponseWriter, r *http.Request) error {
	if b.Browsers == nil {
		return httpError{http.StatusNotFound, "this box has no agent browser"}
	}
	err := b.Browsers.Check(r.Context())
	h := b.Browsers.Health()
	if err != nil && h.State == "ok" {
		// No Chromium, say: not a state the box remembers.
		h.State, h.Error, h.Text = "error", err.Error(), err.Error()
	}
	writeJSON(w, h)
	return nil
}
