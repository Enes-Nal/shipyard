package guided

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

// A fresh Ubuntu box as the probe sees it: sudo asks for a password, git is
// there, tmux isn't (Terminal brings its own), lingering is off.
func freshUbuntu() Probe {
	return Probe{OS: "linux", Arch: "arm64", UID: 1000, User: "dev", Home: "/home/dev", Git: true, Manager: "apt-get", Linger: "no", Sudo: true, Agents: map[string]bool{}}
}

var quietRun = []string{StepBerthd, StepLinger, StepTools, StepAgents, StepIntegrations}

func terminalSteps(o Options, p Probe) []string {
	var out []string
	for _, seg := range Segments(quietRun, func(s string) bool { return NeedsPassword(s, o, p) }) {
		if seg.Terminal {
			out = append(out, seg.Steps...)
		}
	}
	return out
}

func TestQuietInstallAsksOnlyWhenAStepNeedsThePassword(t *testing.T) {
	o := Options{Target: "dev@box", Agents: []string{"claude"}, BundledTmux: true}
	cases := []struct {
		name     string
		probe    func(p *Probe)
		terminal []string
		ask      bool
	}{
		// LingerTry turned lingering on without sudo (polkit allows it):
		// nothing needs a person.
		{"git there, lingering on without sudo", func(p *Probe) { p.Linger = "yes" }, nil, false},
		// Terminal's tmux needs no sudo; git does.
		{"git missing", func(p *Probe) { p.Linger = "yes"; p.Git = false }, []string{StepTools}, false},
		// Lingering needs the password too: it rides in git's terminal, and
		// nothing is asked first.
		{"git missing, lingering needs root", func(p *Probe) { p.Git = false }, []string{StepLinger, StepTools}, false},
		// Lingering alone needs the password: asked about first (skippable).
		{"only lingering needs root", func(p *Probe) {}, []string{StepLinger}, true},
		// sudo without a password: everything runs on its own.
		{"passwordless sudo", func(p *Probe) { p.Git = false; p.SudoNoPassword = true }, nil, false},
		// No sudo at all: no terminal helps; the step says the command.
		{"no sudo", func(p *Probe) { p.Git = false; p.Sudo = false }, nil, false},
		// tmux missing with no Terminal build: the package manager, with sudo.
		{"tmux missing, none bundled", func(p *Probe) { p.Linger = "yes" }, []string{StepTools}, false},
	}
	for _, c := range cases {
		p := freshUbuntu()
		c.probe(&p)
		oo := o
		if c.name == "tmux missing, none bundled" {
			oo.BundledTmux = false
		}
		if got := terminalSteps(oo, p); !reflect.DeepEqual(got, c.terminal) {
			t.Errorf("%s: terminal for %v, want %v", c.name, got, c.terminal)
		}
		if got := AskLinger(quietRun, oo, p); got != c.ask {
			t.Errorf("%s: asks about lingering %v, want %v", c.name, got, c.ask)
		}
	}
}

func TestSegmentsKeepOrderAndShareATerminal(t *testing.T) {
	needs := map[string]bool{StepLinger: true, StepTools: true}
	got := Segments(quietRun, func(s string) bool { return needs[s] })
	want := []Segment{{Steps: []string{StepBerthd}}, {Steps: []string{StepLinger, StepTools}, Terminal: true}, {Steps: []string{StepAgents, StepIntegrations}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("segments = %+v", got)
	}
	if got := Segments(quietRun, func(string) bool { return false }); len(got) != 1 || got[0].Terminal {
		t.Fatalf("nothing needing a terminal still split: %+v", got)
	}
}

func TestLingerTryWithoutAPassword(t *testing.T) {
	// Where polkit lets the user turn lingering on (Debian 12 with polkitd),
	// it is on without sudo, and sudo is never called.
	_, env, log := fakeBox(t, true, "1000")
	out, _, err := runScript(t, LingerTry, "", append(env, "POLKIT=1"))
	if err != nil || !LingerOn(out) {
		t.Fatalf("%v %q", err, out)
	}
	if calls, _ := os.ReadFile(log); strings.Contains(string(calls), "sudo") {
		t.Errorf("sudo was called:\n%s", calls)
	}
}

func TestLingerTryNeverWaitsForAPassword(t *testing.T) {
	// No polkit (an Ubuntu without polkitd) and a sudo that asks: the
	// answer is no, at once, with nothing read from the input.
	_, env, log := fakeBox(t, true, "1000")
	out, _, err := runScript(t, LingerTry, "hunter2\n", env)
	if err != nil || LingerOn(out) || !strings.Contains(out, "linger no") {
		t.Fatalf("%v %q", err, out)
	}
	if calls, _ := os.ReadFile(log); strings.Contains(string(calls), "sudo loginctl") {
		t.Errorf("sudo ran loginctl, which would have asked:\n%s", calls)
	}
	// sudo without a password: on, through sudo -n.
	_, env, _ = fakeBox(t, false, "1000")
	if out, _, err := runScript(t, LingerTry, "", env); err != nil || !LingerOn(out) {
		t.Fatalf("passwordless sudo: %v %q", err, out)
	}
}

func TestScriptLingersWithoutSudoWhereAllowed(t *testing.T) {
	_, env, log := fakeBox(t, true, "1000")
	p := freshUbuntu()
	script := Script(Options{Target: "dev@box", Ask: true}, p, []string{StepLinger})
	out, events, err := runScript(t, script, "", append(env, "POLKIT=1"))
	if err != nil || states(events) != "linger:start linger:done" {
		t.Fatalf("%v %s\n%s", err, states(events), out)
	}
	if strings.Contains(out, "password") {
		t.Errorf("it mentioned a password:\n%s", out)
	}
	if calls, _ := os.ReadFile(log); strings.Contains(string(calls), "sudo") {
		t.Errorf("sudo was called:\n%s", calls)
	}
}

func TestQuietSegmentRunsWithNoInput(t *testing.T) {
	// The steps that need no person run with no terminal and nothing to
	// read: no prompt, no marker asking for sudo.
	_, env, log := fakeBox(t, true, "1000")
	p := freshUbuntu()
	p.Linger = "yes"
	o := Options{Target: "dev@box", Agents: []string{"claude"}, BundledTmux: true}
	script := Script(o, p, []string{StepBerthd, StepTools, StepAgents, StepIntegrations})
	out, events, err := runScript(t, script, "", env)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if got := states(events); got != "berthd:start berthd:done tools:start tools:done agents:start agents:done integrations:start integrations:done" {
		t.Errorf("events = %s\n%s", got, out)
	}
	if calls, _ := os.ReadFile(log); strings.Contains(string(calls), "sudo") {
		t.Errorf("sudo was called:\n%s", calls)
	}
}

func TestSudoAndAskMarkersParse(t *testing.T) {
	for _, st := range []string{Sudo, Ask} {
		e, ok := ParseMarker(Marker(StepLinger, st, LingerQuestion("dev")))
		if !ok || e.State != st {
			t.Errorf("%s: %+v %v", st, e, ok)
		}
	}
}
