package box

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/cosscom/shipyard/internal/doctor"
	"github.com/cosscom/shipyard/internal/groups"
	"github.com/cosscom/shipyard/internal/integrations"
)

// Doctor reports what this box can do and what is missing. Daemon-level
// checks (service, listen address, paired laptops) come from berthd through
// DaemonChecks; the rest are the same on every box.
func (b *Box) Doctor(ctx context.Context) []doctor.Check {
	var checks []doctor.Check
	if b.DaemonChecks != nil {
		checks = append(checks, b.DaemonChecks()...)
	}
	checks = append(checks,
		doctor.ToolCheck("Worktrees and sessions", "git", "locations and worktrees", "Install git with your package manager", true),
		TmuxCheck(),
		doctor.ToolCheck("Worktrees and sessions", "cloudflared", "public shares", "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/", false),
		// What sessions and the checks above find tools on: a service often
		// starts with less than a login shell has.
		doctor.Check{Area: "Worktrees and sessions", Name: "PATH", Status: doctor.Info, Detail: os.Getenv("PATH")},
	)
	// Doctor looks for the agent CLIs afresh: one installed since shows.
	b.refreshAgents(ctx)
	checks = append(checks, agentChecks()...)
	if m := groups.Now(); len(m.Groups) > 0 {
		checks = append(checks, doctor.Check{Area: "Worktrees and sessions", Name: "groups", Status: doctor.Info,
			Detail: "you joined " + strings.Join(m.Groups, ", ") + " after berthd started, so berthd lacks it; what berthd starts now (terminals, services, scripts, hooks) gets it through sg",
			Fix:    "Terminals and services already running keep their groups until they start again; after the next reboot this goes away"})
	}
	if home, err := os.UserHomeDir(); err == nil {
		for _, t := range integrations.Tools {
			if !t.Present(home) {
				continue
			}
			c := doctor.Check{Area: "Agents", Name: t.Name + " hooks", Status: doctor.OK, Detail: "installed"}
			fix := "berthd integrations install " + t.ID
			if _, ok := integrations.AccountVars[t.ID]; ok {
				// Per account folder: "hooks and 7 skills in ~/.claude, ~/.berth/accounts/claude/work".
				summary, missing, outdated := integrations.AccountSummary(home, t.ID)
				c.Detail = summary
				switch {
				case !t.Hooked(home):
					c.Status, c.Detail, c.Fix = doctor.Warn, "not installed, so Terminal cannot show when this agent is done or needs you", fix
					if !strings.HasPrefix(summary, "none in ") {
						// Some other account has them.
						c.Detail += " (" + summary + ")"
					}
				case len(missing) > 0:
					c.Status, c.Fix = doctor.Warn, fix
					c.Detail += ", so Terminal cannot show when an agent on those accounts is done or needs you"
				case len(outdated) > 0:
					c.Status, c.Fix = doctor.Warn, fix
					c.Detail += "; from an older berth in " + strings.Join(outdated, ", ") + ": turns start and approvals clear late"
				}
			} else if !t.Hooked(home) {
				c.Status, c.Detail, c.Fix = doctor.Warn, "not installed, so Terminal cannot show when this agent is done or needs you", fix
			} else if !t.Current(home) {
				c.Status, c.Detail, c.Fix = doctor.Warn, "from an older berth: turns start and approvals clear late", fix
			}
			checks = append(checks, c)
		}
	}
	checks = append(checks, b.eventChecks()...)
	locs, err := b.Locations.List(ctx)
	if err != nil {
		checks = append(checks, doctor.Check{Area: "Locations", Name: "locations", Status: doctor.Fail, Detail: err.Error()})
		return checks
	}
	for _, l := range locs {
		if _, err := os.Stat(l.Path); err != nil {
			checks = append(checks, doctor.Check{Area: "Locations", Name: l.Name, Status: doctor.Fail, Detail: l.Path + " no longer exists", Fix: "berthd location rm " + l.Name})
			continue
		}
		kind := "folder"
		if l.Repo {
			kind = "git repository"
		}
		checks = append(checks, doctor.Check{Area: "Locations", Name: l.Name, Status: doctor.OK, Detail: kind + " at " + l.Path})
	}
	if len(locs) == 0 {
		checks = append(checks, doctor.Check{Area: "Locations", Name: "locations", Status: doctor.Info, Detail: "none yet", Fix: "berthd location add NAME ~/path/to/repo"})
	}
	if b.Browsers != nil {
		if p, err := FindChromium(); err != nil {
			checks = append(checks, doctor.Check{Area: "Agents", Name: "agent browser", Status: doctor.Info, Detail: "no Chromium for agents' browsers", Fix: "berthd browser install"})
		} else {
			checks = append(checks, doctor.Check{Area: "Agents", Name: "agent browser", Status: doctor.OK, Detail: fmt.Sprintf("Chromium at %s; at most %d at once; pages at %s unless an agent sets a size", p, b.Browsers.limit(), DefaultViewport)})
			checks = append(checks, browserSandboxChecks(b.Browsers.Health())...)
		}
	}
	if c, ok := b.agentBrowserCheck(ctx); ok {
		checks = append(checks, c)
	}
	return append(checks, b.processChecks(ctx)...)
}

// processChecks say how sessions are cleaned up here and which browsers
// run on the box, so an agent reading doctor sees a runaway one.
func (b *Box) processChecks(ctx context.Context) []doctor.Check {
	var checks []doctor.Check
	if b.Sessions != nil {
		c := doctor.Check{Area: "Worktrees and sessions", Name: "session cleanup", Status: doctor.OK}
		switch {
		case b.Sessions.Scopes != nil && b.Sessions.Scopes.Available(ctx):
			c.Detail = "each new session runs in a systemd scope of its own; ending it stops everything it started"
			if g := b.Guard.SessionMemoryHigh(); g > 0 {
				c.Detail += fmt.Sprintf(", and its memory is held under %s", gbOrMB(g))
			}
		case useMarkers:
			c.Detail = "no systemd user manager, so ending a session stops the processes in its tree and those that carry its BERTH_SESSION"
		default:
			c.Detail = "ending a session stops the processes in its tree"
		}
		checks = append(checks, c)
	}
	list, err := b.Processes(ctx, false)
	if err != nil {
		return checks
	}
	c := doctor.Check{Area: "Agents", Name: "browsers", Status: doctor.OK, Detail: "none running"}
	var busy, lines []string
	for _, br := range list.Browsers {
		lines = append(lines, br.describe())
		if br.Stoppable && (br.CPUPercent >= 100 || br.Owner == OwnerOrphan) {
			busy = append(busy, br.Label)
		}
	}
	if len(lines) > 0 {
		c.Detail = fmt.Sprintf("%d running: %s", len(lines), strings.Join(lines, "; "))
	}
	if len(busy) > 0 {
		c.Status, c.Fix = doctor.Warn, "See them with `berthd ps`, stop one with `berthd ps stop ID`"
	}
	return append(checks, c)
}

// browserSandboxChecks say when Chromium's sandbox stops agents' browsers,
// with the same two ways out the app offers, or that they run without it.
func browserSandboxChecks(h BrowserHealth) []doctor.Check {
	const off = "Run without Chromium's sandbox in Terminal (Settings → Boxes); Terminal's proxy still confines it to the worktree's own pages"
	switch {
	case h.State == "sandbox" && h.Fix != "":
		detail := "Ubuntu's sandbox setting (kernel.apparmor_restrict_unprivileged_userns=1) stops Chromium's sandbox, so agents' browsers can't start"
		if h.Likely {
			detail = "Ubuntu's sandbox setting (kernel.apparmor_restrict_unprivileged_userns=1) will stop Chromium's sandbox, so agents' browsers won't start"
		}
		return []doctor.Check{{Area: "Agents", Name: "browser sandbox", Status: doctor.Warn, Detail: detail,
			Fix: "Fix it from Terminal (Settings → Boxes), or run `" + h.Fix + "`. Or: " + off}}
	case h.State == "sandbox":
		return []doctor.Check{{Area: "Agents", Name: "browser sandbox", Status: doctor.Warn, Detail: "Chromium could not start its sandbox on this box, so agents' browsers can't start", Fix: off}}
	case h.State == "error":
		return []doctor.Check{{Area: "Agents", Name: "browser start", Status: doctor.Warn, Detail: h.Error}}
	case h.NoSandbox:
		from := "the box's setting (Terminal: Settings → Boxes)"
		if h.NoSandboxFrom == "env" {
			from = "BERTH_BROWSER_NO_SANDBOX=1"
		}
		return []doctor.Check{{Area: "Agents", Name: "browser sandbox", Status: doctor.Info, Detail: "agents' browsers run without Chromium's sandbox, by " + from + "; Terminal's proxy still confines them to the worktree's own pages"}}
	}
	return nil
}

// eventChecks report the journal and every subscriber that fell behind or
// lost events.
func (b *Box) eventChecks() []doctor.Check {
	var checks []doctor.Check
	if j := b.Events.Journal; j != nil {
		st := j.Stats()
		c := doctor.Check{Area: "Events", Name: "journal", Status: doctor.OK,
			Detail: fmt.Sprintf("%d events, %d segments, %.1f MB", st.Head, st.Segments, float64(st.Bytes)/(1<<20))}
		if st.Errors > 0 {
			c.Status, c.Detail = doctor.Warn, fmt.Sprintf("%d writes failed; check the disk under %s", st.Errors, j.Dir)
		}
		checks = append(checks, c)
	}
	for _, s := range b.Events.Stats() {
		c := doctor.Check{Area: "Events", Name: s.Name, Status: doctor.OK, Detail: "no events lost"}
		if s.Lags > 0 {
			c.Detail = fmt.Sprintf("fell behind %d times and caught up from the journal", s.Lags)
		}
		if s.Dropped > 0 {
			c.Status, c.Detail = doctor.Warn, fmt.Sprintf("lost %d events", s.Dropped)
		}
		checks = append(checks, c)
	}
	if b.Turns != nil && b.Turns.Ambiguous.Load() > 0 {
		checks = append(checks, doctor.Check{Area: "Events", Name: "agent hooks", Status: doctor.Info,
			Detail: fmt.Sprintf("%d hook events named only a folder shared by several agents, so they were not used", b.Turns.Ambiguous.Load()),
			Fix:    "Restart those agent sessions: sessions berth starts now tell hooks their name"})
	}
	return checks
}

func (b *Box) handleDoctor(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, b.Doctor(r.Context()))
	return nil
}

// agentBrowserCheck reports agent-browser sessions (Vercel's CLI) whose
// berth session has ended: berth closes them within a minute, so any here
// are stuck or were left while berthd was down.
func (b *Box) agentBrowserCheck(ctx context.Context) (doctor.Check, bool) {
	if b.AgentBrowsers == nil {
		return doctor.Check{}, false
	}
	all, err := b.AgentBrowsers.List(ctx)
	if errors.Is(err, errNoProcs) {
		return doctor.Check{}, false
	}
	c := doctor.Check{Area: "Agents", Name: "agent-browser sessions"}
	if err != nil {
		c.Status, c.Detail = doctor.Info, "could not look: "+err.Error()
		return c, true
	}
	var orphans []string
	live := 0
	for _, s := range all {
		if s.Live {
			live++
		} else {
			orphans = append(orphans, s.describe())
		}
	}
	switch {
	case len(orphans) > 0:
		c.Status = doctor.Warn
		c.Detail = fmt.Sprintf("%d left running by berth sessions that ended: %s", len(orphans), strings.Join(orphans, "; "))
		c.Fix = "berthd browser reap"
	case live > 0:
		c.Status, c.Detail = doctor.OK, fmt.Sprintf("%d open, each closed when its berth session ends", live)
	default:
		c.Status, c.Detail = doctor.OK, "none left behind"
	}
	return c, true
}
