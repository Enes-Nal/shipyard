package box

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/box/runs"
	"github.com/cosscom/shipyard/internal/transcript"
)

// fakeNotifyHost is a box as the notifier sees it, run by the test.
type fakeNotifyHost struct {
	mu        sync.Mutex
	turnsBy   map[string][]Turn // by session, oldest first
	live      map[string]liveSession
	busy      map[string]bool
	runsBy    map[string]runs.Run
	states    map[string]SessionState
	delivered map[string][]string
	failWith  error
}

func newFakeHost() *fakeNotifyHost {
	return &fakeNotifyHost{turnsBy: map[string][]Turn{}, live: map[string]liveSession{}, busy: map[string]bool{}, runsBy: map[string]runs.Run{}, states: map[string]SessionState{}, delivered: map[string][]string{}}
}

func (f *fakeNotifyHost) agent(names ...string) {
	for _, n := range names {
		f.live[n] = liveSession{Agent: true}
	}
}

func (f *fakeNotifyHost) setTurn(tr Turn) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ts := f.turnsBy[tr.Session]
	for i := range ts {
		if ts[i].ID == tr.ID {
			ts[i] = tr
			return
		}
	}
	f.turnsBy[tr.Session] = append(ts, tr)
}

func (f *fakeNotifyHost) turn(id string) (Turn, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	name, _, _ := strings.Cut(id, "#")
	for _, t := range f.turnsBy[name] {
		if t.ID == id {
			return t, true
		}
	}
	return Turn{}, false
}

func (f *fakeNotifyHost) turns(session string) []Turn {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Turn(nil), f.turnsBy[session]...)
}

func (f *fakeNotifyHost) state(session string) (SessionState, bool) {
	s, ok := f.states[session]
	return s, ok
}

func (f *fakeNotifyHost) sessions(ctx context.Context) (map[string]liveSession, error) {
	out := map[string]liveSession{}
	for k, v := range f.live {
		out[k] = v
	}
	return out, nil
}

func (f *fakeNotifyHost) ready(s string) bool { return !f.busy[s] }

func (f *fakeNotifyHost) run(id string) (runs.Run, bool) {
	r, ok := f.runsBy[id]
	return r, ok
}

func (f *fakeNotifyHost) describe(ctx context.Context, r *Report) {
	if r.Session != "" {
		r.Worktree, r.Branch, r.Path, r.Repo, r.Base = "shop/"+r.Session, r.Session, "/w/"+r.Session, "/w/shop", "main"
		r.Files = []ReviewFile{{Path: "a.go", Added: 3, Removed: 1}}
		r.Uncommitted = 1
		r.Answer = "Done: " + r.Session
		sumFiles(r)
	}
}

func (f *fakeNotifyHost) deliver(ctx context.Context, parent, text string) error {
	if f.failWith != nil {
		return f.failWith
	}
	f.delivered[parent] = append(f.delivered[parent], text)
	return nil
}

// clock is a test's time.
type clock struct{ t time.Time }

func (c *clock) now() time.Time                   { return c.t }
func (c *clock) advance(d time.Duration)          { c.t = c.t.Add(d) }
func newClock() *clock                            { return &clock{time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)} }
func ended(c *clock, ago time.Duration) time.Time { return c.t.Add(-ago) }

func testNotifier(t *testing.T, h *fakeNotifyHost, c *clock, path string) *Notifier {
	t.Helper()
	n := &Notifier{Path: path, Now: c.now}
	n.mu.Lock()
	n.load()
	n.host = h
	n.mu.Unlock()
	return n
}

func TestAFinishedTaskReportsToItsParentOnceItIsIdle(t *testing.T) {
	h, c := newFakeHost(), newClock()
	h.agent("lead", "fix")
	n := testNotifier(t, h, c, "")
	if err := n.Add(Watch{Kind: "task", Parent: "lead", Session: "fix"}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	// Working: nothing to say.
	h.setTurn(Turn{ID: "fix#1", Session: "fix", N: 1, State: "running", Started: c.t})
	n.Step(ctx)
	if len(h.delivered["lead"]) != 0 {
		t.Fatal("reported a turn still running")
	}
	// It ends while the parent works: held.
	c.advance(4 * time.Minute)
	h.setTurn(Turn{ID: "fix#1", Session: "fix", N: 1, State: "finished", Started: c.t.Add(-4 * time.Minute), Ended: c.t})
	h.busy["lead"] = true
	c.advance(3 * time.Second)
	n.Step(ctx)
	if len(h.delivered["lead"]) != 0 {
		t.Fatal("typed into a parent mid-turn")
	}
	h.busy["lead"] = false
	n.Step(ctx)
	got := h.delivered["lead"]
	if len(got) != 1 {
		t.Fatalf("delivered %d messages, want 1", len(got))
	}
	for _, want := range []string{"<berth-notification>", "not from the user", `session="fix"`, `status="finished"`, `duration="4m00s"`, `added="3"`, "<answer>\nDone: fix\n</answer>", "git merge fix", "berth_screen session=fix"} {
		if !strings.Contains(got[0], want) {
			t.Errorf("message lacks %q:\n%s", want, got[0])
		}
	}
	// Said once: the watch is gone and a second look says nothing.
	c.advance(time.Minute)
	n.Step(ctx)
	if len(h.delivered["lead"]) != 1 || len(n.Watches()) != 0 {
		t.Fatalf("reported again: %d messages, %d watches", len(h.delivered["lead"]), len(n.Watches()))
	}
}

func TestSeveralChildrenFinishingGoAsOneMessage(t *testing.T) {
	h, c := newFakeHost(), newClock()
	h.agent("lead", "a", "b", "c")
	n := testNotifier(t, h, c, "")
	for _, s := range []string{"a", "b", "c"} {
		n.Add(Watch{Kind: "turn", Parent: "lead", Session: s, Turn: s + "#1"})
		h.setTurn(Turn{ID: s + "#1", Session: s, N: 1, State: "running"})
	}
	h.busy["lead"] = true
	ctx := context.Background()
	for _, s := range []string{"a", "b"} {
		h.setTurn(Turn{ID: s + "#1", Session: s, N: 1, State: "finished", Ended: c.t})
		c.advance(10 * time.Second)
		n.Step(ctx)
	}
	h.busy["lead"] = false
	// One just ended: the message waits a moment for others.
	h.setTurn(Turn{ID: "c#1", Session: "c", N: 1, State: "finished", Status: "error", Ended: c.t.Add(-1600 * time.Millisecond)})
	n.Step(ctx)
	if len(h.delivered["lead"]) != 0 {
		t.Fatal("did not wait to gather reports close together")
	}
	c.advance(3 * time.Second)
	n.Step(ctx)
	got := h.delivered["lead"]
	if len(got) != 1 || strings.Count(got[0], "<report ") != 3 {
		t.Fatalf("want one message with three reports, got %d: %v", len(got), got)
	}
	if !strings.Contains(got[0], `session="c"`) || !strings.Contains(got[0], `status="failed"`) {
		t.Fatalf("the failed turn is not said: %s", got[0])
	}
}

func TestWaitingForAPersonIsSaidOncePerWait(t *testing.T) {
	h, c := newFakeHost(), newClock()
	h.agent("lead", "fix")
	n := testNotifier(t, h, c, "")
	n.Add(Watch{Kind: "turn", Parent: "lead", Session: "fix", Turn: "fix#1"})
	ask := &Ask{Tool: "Bash", Input: "pnpm db:migrate"}
	h.setTurn(Turn{ID: "fix#1", Session: "fix", N: 1, State: "waiting", Waits: []Span{{Start: c.t, Ask: ask}}})
	ctx := context.Background()
	c.advance(5 * time.Second)
	n.Step(ctx)
	c.advance(30 * time.Second)
	n.Step(ctx)
	got := h.delivered["lead"]
	if len(got) != 1 || !strings.Contains(got[0], `status="waiting"`) || !strings.Contains(got[0], "permission to use Bash: pnpm db:migrate") || !strings.Contains(got[0], "never answer for them") {
		t.Fatalf("want one waiting report naming the ask: %v", got)
	}
	// Answered, then it asks again: a second report. Then it ends: a third.
	h.setTurn(Turn{ID: "fix#1", Session: "fix", N: 1, State: "waiting", Waits: []Span{{Start: c.t.Add(-time.Minute), End: c.t}, {Start: c.t}}})
	c.advance(20 * time.Second)
	n.Step(ctx)
	h.setTurn(Turn{ID: "fix#1", Session: "fix", N: 1, State: "finished", Ended: c.t})
	c.advance(20 * time.Second)
	n.Step(ctx)
	if len(h.delivered["lead"]) != 3 {
		t.Fatalf("want 3 messages (wait, wait again, end), got %d", len(h.delivered["lead"]))
	}
}

func TestAParentThatIsGoneIsNeverTypedInto(t *testing.T) {
	h, c := newFakeHost(), newClock()
	h.agent("lead", "fix", "shell")
	h.live["shell"] = liveSession{} // a shell, no agent
	n := testNotifier(t, h, c, "")
	n.Add(Watch{Kind: "turn", Parent: "lead", Session: "fix", Turn: "fix#1"})
	n.Add(Watch{Kind: "turn", Parent: "shell", Session: "fix", Turn: "fix#1"})
	h.setTurn(Turn{ID: "fix#1", Session: "fix", N: 1, State: "finished", Ended: c.t})
	delete(h.live, "lead") // archived with its worktree
	c.advance(10 * time.Second)
	n.Step(context.Background())
	if len(h.delivered) != 0 {
		t.Fatalf("typed into a parent that is gone or runs no agent: %v", h.delivered)
	}
	if len(n.Watches()) != 0 || len(n.st.Pending) != 0 {
		t.Fatalf("kept watches or reports for gone parents: %+v %+v", n.Watches(), n.st.Pending)
	}
	// An exited parent is dropped too, and a send that finds it gone.
	h.agent("lead2")
	h.live["lead2"] = liveSession{Agent: true, Exited: true}
	n.Add(Watch{Kind: "turn", Parent: "lead2", Session: "fix", Turn: "fix#1"})
	n.Step(context.Background())
	if len(n.Watches()) != 0 {
		t.Fatal("kept a watch for an exited parent")
	}
	h.agent("lead3")
	h.failWith = ErrSessionExited
	n.Add(Watch{Kind: "task", Parent: "lead3", Session: "fix"})
	n.Step(context.Background())
	if len(n.st.Pending["lead3"]) != 0 || len(n.Watches()) != 0 {
		t.Fatal("kept reports for a parent whose send failed as exited")
	}
}

func TestWatchesAndHeldReportsSurviveARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notify.json")
	h, c := newFakeHost(), newClock()
	h.agent("lead", "a", "b")
	n := testNotifier(t, h, c, path)
	n.Add(Watch{Kind: "task", Parent: "lead", Session: "a"})
	n.Add(Watch{Kind: "turn", Parent: "lead", Session: "b", Turn: "b#4"})
	// b ends while the parent works: held, then berthd restarts.
	h.busy["lead"] = true
	h.setTurn(Turn{ID: "b#4", Session: "b", N: 4, State: "finished", Ended: c.t})
	c.advance(5 * time.Second)
	n.Step(context.Background())

	n2 := testNotifier(t, h, c, path)
	if len(n2.Watches()) != 1 || len(n2.st.Pending["lead"]) != 1 {
		t.Fatalf("after a restart: %d watches, %d held reports", len(n2.Watches()), len(n2.st.Pending["lead"]))
	}
	// a's first turn ends while berthd is down; it is still reported.
	h.setTurn(Turn{ID: "a#1", Session: "a", N: 1, State: "finished", Ended: c.t})
	h.busy["lead"] = false
	c.advance(5 * time.Second)
	n2.Step(context.Background())
	got := h.delivered["lead"]
	if len(got) != 1 || strings.Count(got[0], "<report ") != 2 {
		t.Fatalf("want both reports in one message after the restart: %v", got)
	}
	// What was said stays said across another restart.
	n3 := testNotifier(t, h, c, path)
	n3.Add(Watch{Kind: "turn", Parent: "lead", Session: "b", Turn: "b#4"})
	c.advance(time.Minute)
	n3.Step(context.Background())
	if len(h.delivered["lead"]) != 1 {
		t.Fatal("a turn already reported was reported again after a restart")
	}
}

func TestReportingBackNeverGoesRoundInACircle(t *testing.T) {
	h, c := newFakeHost(), newClock()
	h.agent("a", "b", "c")
	n := testNotifier(t, h, c, "")
	if err := n.Add(Watch{Kind: "turn", Parent: "a", Session: "a", Turn: "a#1"}); !errors.Is(err, ErrReportCycle) {
		t.Fatalf("a session watched itself: %v", err)
	}
	if err := n.Add(Watch{Kind: "task", Parent: "a", Session: "b"}); err != nil {
		t.Fatal(err)
	}
	if err := n.Add(Watch{Kind: "task", Parent: "b", Session: "c"}); err != nil {
		t.Fatal(err)
	}
	// c reports to b, b to a: a may not report to b or c.
	for _, child := range []string{"b", "c"} {
		if err := n.Add(Watch{Kind: "turn", Parent: child, Session: "a", Turn: "a#2"}); !errors.Is(err, ErrReportCycle) {
			t.Fatalf("a may report to %s, which reports to it: %v", child, err)
		}
	}
	// A run never reports to a session as its child, so it makes no cycle.
	if err := n.Add(Watch{Kind: "run", Parent: "c", Run: "r_1"}); err != nil {
		t.Fatal(err)
	}
}

func TestDeliveriesAreRateLimited(t *testing.T) {
	h, c := newFakeHost(), newClock()
	h.agent("lead", "x")
	n := testNotifier(t, h, c, "")
	ctx := context.Background()
	end := func(i int) {
		id := "x#" + string(rune('a'+i))
		n.Add(Watch{Kind: "turn", Parent: "lead", Session: "x", Turn: id})
		h.setTurn(Turn{ID: id, Session: "x", N: i + 1, State: "finished", Ended: c.t})
	}
	end(0)
	c.advance(3 * time.Second)
	n.Step(ctx)
	end(1)
	c.advance(3 * time.Second)
	if wait := n.Step(ctx); len(h.delivered["lead"]) != 1 || wait <= 0 || wait > notifyMinGap {
		t.Fatalf("second message not held for the gap: %d messages, retry in %v", len(h.delivered["lead"]), wait)
	}
	c.advance(notifyMinGap)
	n.Step(ctx)
	if len(h.delivered["lead"]) != 2 {
		t.Fatal("held message never went")
	}
	// At most notifyPerHour an hour.
	n.mu.Lock()
	for i := 0; i < notifyPerHour; i++ {
		n.st.Sent["lead"] = append(n.st.Sent["lead"], c.t.Add(-time.Duration(i)*time.Minute-time.Minute))
	}
	n.mu.Unlock()
	end(2)
	c.advance(time.Minute)
	n.Step(ctx)
	if len(h.delivered["lead"]) != 2 {
		t.Fatal("went past the hourly limit")
	}
	// Too many held reports keep the newest, and say some were dropped.
	for i := 3; i < 3+maxPendingReports+5; i++ {
		end(i)
	}
	c.advance(5 * time.Second)
	n.Step(ctx)
	if got := len(n.st.Pending["lead"]); got != maxPendingReports {
		t.Fatalf("holds %d reports, want %d", got, maxPendingReports)
	}
	c.advance(time.Hour)
	n.Step(ctx)
	last := h.delivered["lead"][len(h.delivered["lead"])-1]
	if !strings.Contains(last, "earlier updates were dropped") {
		t.Fatal("did not say reports were dropped")
	}
}

func TestRunsReportTheirGateAndTheirEnd(t *testing.T) {
	h, c := newFakeHost(), newClock()
	h.agent("lead")
	n := testNotifier(t, h, c, "")
	n.Add(Watch{Kind: "run", Parent: "lead", Run: "r_1"})
	h.runsBy["r_1"] = runs.Run{ID: "r_1", Template: "attempts", Status: runs.WaitingGate, Created: c.t, Updated: c.t, Gate: &runs.Gate{Path: "2.t.0", Title: "Pick the best attempt"}}
	ctx := context.Background()
	c.advance(5 * time.Second)
	n.Step(ctx)
	c.advance(30 * time.Second)
	n.Step(ctx)
	if got := h.delivered["lead"]; len(got) != 1 || !strings.Contains(got[0], `status="waiting_gate"`) || !strings.Contains(got[0], "berthd run approve|reject r_1") {
		t.Fatalf("gate: %v", got)
	}
	h.runsBy["r_1"] = runs.Run{ID: "r_1", Template: "attempts", Status: runs.Succeeded, Created: c.t.Add(-2 * time.Minute), Finished: c.t}
	c.advance(30 * time.Second)
	n.Step(ctx)
	if got := h.delivered["lead"]; len(got) != 2 || !strings.Contains(got[1], `status="succeeded"`) {
		t.Fatalf("end: %v", got)
	}
	if len(n.Watches()) != 0 {
		t.Fatal("kept the watch on a run that ended")
	}
}

func TestAParentWaitingOnItsOwnWorkReportsOnceThatIsDone(t *testing.T) {
	h, c := newFakeHost(), newClock()
	h.agent("top", "mid", "leaf")
	n := testNotifier(t, h, c, "")
	ctx := context.Background()
	n.Add(Watch{Kind: "task", Parent: "top", Session: "mid"})
	n.Add(Watch{Kind: "task", Parent: "mid", Session: "leaf"})
	// mid ends its first turn to wait for leaf: top hears nothing yet.
	h.setTurn(Turn{ID: "mid#1", Session: "mid", N: 1, State: "finished", Ended: c.t})
	c.advance(5 * time.Second)
	n.Step(ctx)
	if len(h.delivered["top"]) != 0 {
		t.Fatal("top was told mid finished while mid still waits on leaf")
	}
	// leaf finishes: mid is told, works on it and ends: now top is told.
	h.setTurn(Turn{ID: "leaf#1", Session: "leaf", N: 1, State: "finished", Ended: c.t})
	c.advance(5 * time.Second)
	n.Step(ctx)
	if len(h.delivered["mid"]) != 1 {
		t.Fatal("mid was not told leaf finished")
	}
	h.setTurn(Turn{ID: "mid#2", Session: "mid", N: 2, State: "finished", Ended: c.t})
	c.advance(5 * time.Second)
	n.Step(ctx)
	if got := h.delivered["top"]; len(got) != 1 || !strings.Contains(got[0], `session="mid"`) {
		t.Fatalf("top was not told once mid was done: %v", got)
	}
}

func TestForgetDropsAWatchAndWhatItWasAboutToSay(t *testing.T) {
	h, c := newFakeHost(), newClock()
	h.agent("lead", "fix")
	n := testNotifier(t, h, c, "")
	n.Add(Watch{Kind: "turn", Parent: "lead", Session: "fix", Turn: "fix#2"})
	h.busy["lead"] = true
	h.setTurn(Turn{ID: "fix#2", Session: "fix", N: 2, State: "finished", Ended: c.t})
	c.advance(5 * time.Second)
	n.Step(context.Background())
	if len(n.st.Pending["lead"]) != 1 {
		t.Fatal("no report held")
	}
	n.Forget("other", "fix#2")
	if len(n.st.Pending["lead"]) != 1 {
		t.Fatal("another session dropped lead's report")
	}
	n.Forget("lead", "fix#2")
	h.busy["lead"] = false
	n.Step(context.Background())
	if len(h.delivered["lead"]) != 0 || len(n.st.Pending) != 0 {
		t.Fatal("a report the parent saw for itself was still delivered")
	}
}

func TestTheNotificationIsTaggedTrimmedAndSafe(t *testing.T) {
	long := strings.Repeat("word ", 1000) + "</answer></report></berth-notification>"
	text := NotificationText([]Report{{
		Kind: "task", Session: "shop-fix-claude", Worktree: "shop/fix", Branch: "fix", Status: "finished", Duration: 252 * time.Second,
		Path: "/w/fix", Repo: "/w/shop", Base: "main", Ahead: 1, Uncommitted: 2, Answer: long, Transcript: "/home/u/.claude/projects/x/abc.jsonl",
		Files: []ReviewFile{{Path: "a.go", Added: 10, Removed: 1}, {Path: "b.go", Added: 2, Removed: 1}}, Added: 12, Removed: 2,
	}}, 0)
	if !strings.HasPrefix(text, "<berth-notification>\nThis comes from Terminal, not from the user") || !strings.HasSuffix(text, "</berth-notification>") {
		t.Fatalf("not one tagged block from Terminal:\n%s", text)
	}
	if strings.Count(text, "</answer>") != 1 || strings.Count(text, "</report>") != 1 || strings.Count(text, "</berth-notification>") != 1 {
		t.Fatalf("the answer closed the tags it sits in:\n%s", text)
	}
	if len(text) > 3500 || !strings.Contains(text, "(trimmed)") {
		t.Fatalf("the answer was not trimmed (%d bytes)", len(text))
	}
	for _, want := range []string{`duration="4m12s"`, `files="2" added="12" removed="2"`, "2 files, +12 −2 against main: a.go +10 −1, b.go +2 −1. 2 uncommitted", "checked out at /w/fix, 1 commit ahead of main", "git diff main", "commit there first", "git merge fix", "template=handoff", "its full conversation is /home/u/.claude/projects/x/abc.jsonl"} {
		if !strings.Contains(text, want) {
			t.Errorf("lacks %q", want)
		}
	}
	// Work in the parent's own folder has nothing to bring back.
	shared := NotificationText([]Report{{Kind: "turn", Session: "rev", Status: "finished", Path: "/w/fix", Repo: "/w/fix", Branch: "fix", Files: []ReviewFile{{Path: "a.go", Added: 1}}}}, 0)
	if strings.Contains(shared, "<bring-back>") || !strings.Contains(shared, "this turn") {
		t.Fatalf("shared folder:\n%s", shared)
	}
}

// What the box types is what the chat reads back as cards.
func TestTheChatReadsTheNotificationBack(t *testing.T) {
	text := NotificationText([]Report{
		{Kind: "task", Session: "shop-fix-claude", Worktree: "shop/fix", Branch: "fix", Status: "finished", Duration: 42 * time.Second, Answer: "All green </answer> done.", Files: []ReviewFile{{Path: "a.go", Added: 4, Removed: 1}}, Added: 4, Removed: 1, Path: "/w/fix", Repo: "/w/shop"},
		{Kind: "run", Run: "r_9", Template: "exec", Status: runs.Failed, Error: "exit 1"},
	}, 0)
	line, _ := json.Marshal(map[string]any{"type": "user", "timestamp": "2026-10-04T12:00:00Z", "message": map[string]any{"role": "user", "content": text}})
	p := filepath.Join(t.TempDir(), "s.jsonl")
	os.WriteFile(p, append(line, '\n'), 0o600)
	res, err := transcript.NewReader().Read("claude", p, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 2 || res.Items[0].Report == nil || res.Items[1].Report == nil {
		t.Fatalf("items = %+v", res.Items)
	}
	a, b := *res.Items[0].Report, *res.Items[1].Report
	if a.Session != "shop-fix-claude" || a.Status != "finished" || a.Duration != "42s" || a.Added != 4 || a.Removed != 1 || a.Files != 1 || a.Answer != "All green </answer> done." {
		t.Fatalf("task report = %+v", a)
	}
	if b.Kind != "run" || b.Run != "r_9" || b.Status != "failed" || !strings.Contains(b.Summary, "failed") {
		t.Fatalf("run report = %+v", b)
	}
}
