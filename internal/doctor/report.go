package doctor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// Diagnostics is everything "Copy diagnostics" (the app) and
// `berth doctor --report` (the CLI) put in one report someone can paste
// into a chat: the app, the agent, this laptop's checks, the local box,
// each box, and the last errors and toasts. The app writes its own part
// to the agent (GET /v1/app/diagnostics), so the CLI can show it too.
//
// FormatReport and app/src/lib/diagnostics-format.ts print the same text;
// testdata/diagnostics.golden holds both to it.
type Diagnostics struct {
	Generated string `json:"generated"`
	// Home is redacted to ~ wherever it appears; never printed.
	Home        string        `json:"home,omitempty"`
	App         *AppInfo      `json:"app,omitempty"`
	Agent       AgentInfo     `json:"agent"`
	Doctor      []Check       `json:"doctor"`
	DoctorError string        `json:"doctor_error,omitempty"`
	LocalBox    *LocalBoxInfo `json:"local_box,omitempty"`
	Boxes       []BoxInfo     `json:"boxes"`
}

// AppInfo is the desktop app's own part.
type AppInfo struct {
	Version        string  `json:"version,omitempty"`
	Build          string  `json:"build,omitempty"`
	OS             string  `json:"os,omitempty"`
	Arch           string  `json:"arch,omitempty"`
	Renderer       string  `json:"renderer,omitempty"`
	Chosen         string  `json:"chosen,omitempty"`
	RendererReason string  `json:"renderer_reason,omitempty"`
	Theme          string  `json:"theme,omitempty"`
	Labs           bool    `json:"labs"`
	Zen            bool    `json:"zen"`
	AgentView      string  `json:"agent_view,omitempty"`
	Errors         []Event `json:"errors,omitempty"`
	Toasts         []Event `json:"toasts,omitempty"`
}

// Event is one error or toast the app showed.
type Event struct {
	At      string `json:"at"`
	Kind    string `json:"kind,omitempty"`
	Code    string `json:"code,omitempty"`
	Title   string `json:"title"`
	Message string `json:"message,omitempty"`
}

type AgentInfo struct {
	Version string `json:"version,omitempty"`
	Build   string `json:"build,omitempty"`
	State   string `json:"state,omitempty"`
	Error   string `json:"error,omitempty"`
}

type LocalBoxInfo struct {
	Name    string  `json:"name"`
	State   string  `json:"state,omitempty"`
	Version string  `json:"version,omitempty"`
	Error   string  `json:"error,omitempty"`
	Checks  []Check `json:"checks,omitempty"`
}

type BoxInfo struct {
	Name         string   `json:"name"`
	State        string   `json:"state,omitempty"`
	Version      string   `json:"version,omitempty"`
	Build        string   `json:"build,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
	Error        string   `json:"error,omitempty"`
}

// recentEvents is how many errors and toasts the report keeps, newest last.
const recentEvents = 8

// maxDetail is the longest one detail runs before it is cut with "…".
const maxDetail = 160

var marks = map[Status]string{OK: "✓", Warn: "!", Fail: "✗", Info: "·"}

// FormatReport writes the report, redacted (Redact).
func FormatReport(d Diagnostics) string {
	var l []string
	add := func(s string) { l = append(l, s) }
	add("Terminal diagnostics · " + stamp(d.Generated))
	if a := d.App; a == nil {
		add("App: not recorded (open Terminal once)")
	} else {
		line := "App: " + or(a.Version, "unknown")
		if a.Build != "" {
			line += " (build " + a.Build + ")"
		}
		if a.OS != "" {
			line += " · " + a.OS
		}
		if a.Arch != "" {
			line += " " + a.Arch
		}
		add(line)
	}
	agent := "Agent: " + or(d.Agent.State, "unknown")
	if d.Agent.Version != "" {
		agent += " · berth " + d.Agent.Version
	}
	if d.Agent.Build != "" {
		agent += " (build " + d.Agent.Build + ")"
	}
	if d.Agent.Error != "" {
		agent += " · " + clip(d.Agent.Error)
	}
	add(agent)
	if a := d.App; a != nil {
		add("Terminal: " + terminal(a))
		look := "Look: theme " + or(a.Theme, "default") + " · Labs " + onOff(a.Labs)
		if a.Labs {
			look += " (agents as " + or(a.AgentView, "terminal") + ", zen " + onOff(a.Zen) + ")"
		}
		add(look)
	}

	add("")
	add("Laptop (berth doctor)")
	switch {
	case d.DoctorError != "":
		add("  " + clip(d.DoctorError))
	case len(d.Doctor) == 0:
		add("  no checks")
	}
	for _, c := range d.Doctor {
		add(checkLine(c))
	}

	add("")
	if b := d.LocalBox; b == nil {
		add("Local box: none")
	} else {
		line := "Local box " + b.Name + " · " + or(b.State, "unknown")
		if b.Version != "" {
			line += " · berthd " + b.Version
		}
		if b.Error != "" {
			line += " · " + clip(b.Error)
		}
		add(line)
		for _, c := range b.Checks {
			add(checkLine(c))
		}
	}

	add("")
	add(fmt.Sprintf("Boxes (%d)", len(d.Boxes)))
	if len(d.Boxes) == 0 {
		add("  none paired")
	}
	for _, b := range d.Boxes {
		line := "  " + b.Name + " · " + or(b.State, "unknown")
		var ver []string
		if b.Version != "" {
			ver = append(ver, b.Version)
		}
		if b.Build != "" {
			ver = append(ver, "("+b.Build+")")
		}
		if len(ver) > 0 {
			line += " · " + strings.Join(ver, " ")
		}
		if len(b.Capabilities) > 0 {
			line += " · caps: " + strings.Join(b.Capabilities, " ")
		}
		if b.Error != "" {
			line += " · last error: " + clip(b.Error)
		}
		add(line)
	}

	var errs, toasts []Event
	if d.App != nil {
		errs, toasts = d.App.Errors, d.App.Toasts
	}
	events := func(name string, list []Event, code bool) {
		add("")
		if len(list) == 0 {
			add(name + ": none")
			return
		}
		add(fmt.Sprintf("%s (%d)", name, len(list)))
		if len(list) > recentEvents {
			list = list[len(list)-recentEvents:]
		}
		for _, e := range list {
			line := "  " + clock(e.At) + " "
			if code {
				if e.Code != "" {
					line += "[" + e.Code + "] "
				}
			} else {
				line += or(e.Kind, "info") + " "
			}
			text := flat(e.Title)
			if m := flat(e.Message); m != "" {
				text += ": " + m
			}
			add(line + clip(text))
		}
	}
	events("Recent errors", errs, true)
	events("Recent toasts", toasts, false)
	return Redact(strings.Join(l, "\n")+"\n", d.Home)
}

func checkLine(c Check) string {
	mark, ok := marks[c.Status]
	if !ok {
		mark = "?"
	}
	line := "  " + mark + " " + c.Name
	if d := flat(c.Detail); d != "" {
		line += "  " + clip(d)
	}
	if c.Fix != "" && c.Status != OK {
		line += " → " + clip(flat(c.Fix))
	}
	return line
}

func terminal(a *AppInfo) string {
	switch {
	case a.Renderer == "":
		return "not started yet"
	case a.Renderer == "xterm" && a.Chosen == "ghostty":
		return "xterm.js (ghostty-web failed: " + clip(or(flat(a.RendererReason), "no reason given")) + ")"
	case a.Renderer == "xterm":
		return "xterm.js (chosen in Settings)"
	case a.Renderer == "ghostty":
		return "ghostty-web"
	}
	return a.Renderer
}

func stamp(s string) string {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return or(s, "unknown time")
	}
	return t.UTC().Format("2006-01-02 15:04") + " UTC"
}

func clock(s string) string {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return "--:--"
	}
	return t.UTC().Format("15:04")
}

func or(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

// flat puts text on one line.
func flat(s string) string { return strings.Join(strings.Fields(s), " ") }

// clip cuts text longer than maxDetail characters.
func clip(s string) string {
	r := []rune(s)
	if len(r) <= maxDetail {
		return s
	}
	return string(r[:maxDetail-1]) + "…"
}

var (
	userPath    = regexp.MustCompile(`(?:/Users/|/home/)[^/\s:"']+`)
	winUserPath = regexp.MustCompile(`[A-Za-z]:\\Users\\[^\\\s"']+`)
	opRef       = regexp.MustCompile(`op://[^\s"'<>]+`)
	urlUser     = regexp.MustCompile(`://[^/\s:@]+:[^/\s@]+@`)
	email       = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	keyValue    = regexp.MustCompile(`(?i)(token|secret|password|passwd|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+`)
	bearer      = regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+`)
	longRun     = regexp.MustCompile(`[A-Za-z0-9_+=-]{32,}`)
	hasLetter   = regexp.MustCompile(`[A-Za-z]`)
	hasDigit    = regexp.MustCompile(`[0-9]`)
)

// Redact takes out what a report must not carry: the home folder and any
// other account's home (as ~), 1Password references, a URL's user and
// password, email addresses,
// tokens and passwords given as key=value or Bearer, and long runs of
// letters and digits that look like a key. Paths keep their shape: a run
// stops at "/", so only one long segment would go.
func Redact(s, home string) string {
	if home = strings.TrimRight(home, "/\\"); len(home) > 1 {
		s = strings.ReplaceAll(s, home, "~")
	}
	s = userPath.ReplaceAllString(s, "~")
	s = winUserPath.ReplaceAllString(s, "~")
	s = opRef.ReplaceAllString(s, "op://[redacted]")
	s = urlUser.ReplaceAllString(s, "://[redacted]@")
	s = email.ReplaceAllString(s, "[email]")
	s = keyValue.ReplaceAllString(s, "${1}${2}[redacted]")
	s = bearer.ReplaceAllString(s, "Bearer [redacted]")
	s = longRun.ReplaceAllStringFunc(s, func(m string) string {
		if hasLetter.MatchString(m) && hasDigit.MatchString(m) {
			return "[redacted]"
		}
		return m
	})
	return s
}

// HostOS names this computer's system: "macOS 26.3" on a Mac.
func HostOS(ctx context.Context) string {
	switch runtime.GOOS {
	case "darwin":
		ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if out, err := exec.CommandContext(ctx, "sw_vers", "-productVersion").Output(); err == nil {
			return "macOS " + strings.TrimSpace(string(out))
		}
		return "macOS"
	case "linux":
		if b, err := os.ReadFile("/etc/os-release"); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if v, ok := strings.CutPrefix(line, "PRETTY_NAME="); ok {
					return strings.Trim(v, `"`)
				}
			}
		}
	}
	return runtime.GOOS
}
