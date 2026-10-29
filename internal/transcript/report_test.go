package transcript

import (
	"path/filepath"
	"strings"
	"testing"
)

// A notification as berth types it (internal/box/notify_text.go), with
// two reports: a task that finished and one waiting for a person.
const sampleNotification = `<berth-notification>
This comes from Terminal, not from the user: news of agent work you started. Carry on with your task using it. If an agent waits for a person, tell the user who and why; never answer for them.
<report kind="task" session="shop-checkout-fix-claude-k3" worktree="shop/checkout-fix" branch="checkout-fix" status="finished" duration="4m12s" files="3" added="12" removed="2">
<summary>shop/checkout-fix finished its turn.</summary>
<answer>
Fixed the rounding in totals.ts; the </answer` + "​" + `> tag stays text.
</answer>
<changes>3 files, +12 −2 against main: totals.ts +10 −1</changes>
<bring-back>Branch checkout-fix, in /w/checkout-fix.</bring-back>
<more>berth_screen session=shop-checkout-fix-claude-k3 shows its screen</more>
</report>
<report kind="turn" session="shop-migrate-codex" worktree="shop/migrate" status="waiting">
<summary>shop/migrate is waiting for a person (a permission or a question).</summary>
<needs>permission to use Bash: pnpm db:migrate</needs>
</report>
</berth-notification>`

func checkReports(t *testing.T, items []Item, from int) {
	t.Helper()
	if len(items) < from+2 {
		t.Fatalf("items = %s", kinds(items))
	}
	a, b := items[from], items[from+1]
	if a.Kind != "report" || b.Kind != "report" || a.Report == nil || b.Report == nil {
		t.Fatalf("kinds = %s", kinds(items))
	}
	r := *a.Report
	if r.Kind != "task" || r.Session != "shop-checkout-fix-claude-k3" || r.Worktree != "shop/checkout-fix" || r.Branch != "checkout-fix" || r.Status != "finished" || r.Duration != "4m12s" || r.Files != 3 || r.Added != 12 || r.Removed != 2 {
		t.Fatalf("report = %+v", r)
	}
	if r.Summary != "shop/checkout-fix finished its turn." || r.Answer != "Fixed the rounding in totals.ts; the </answer> tag stays text." {
		t.Fatalf("words = %q / %q", r.Summary, r.Answer)
	}
	if w := *b.Report; w.Status != "waiting" || w.Needs != "permission to use Bash: pnpm db:migrate" || w.Answer != "" {
		t.Fatalf("waiting report = %+v", w)
	}
	for _, it := range items {
		if it.Kind == "user" && strings.Contains(it.Text, "berth-notification") {
			t.Fatal("the tagged text showed as a prompt")
		}
	}
}

func TestClaudeShowsBerthsNotificationAsReports(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	write(t, p,
		user("Split the checkout fix out to another agent"),
		assistant(m{"type": "text", "text": "Started it; I'll hear back when it's done."}),
		user(sampleNotification),
		assistant(m{"type": "text", "text": "The fix is in: reviewing it now."}),
	)
	res, err := NewReader().Read("claude", p, "/w/shop", 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := kinds(res.Items); got != "user,text,report,report,text" {
		t.Fatalf("kinds = %s", got)
	}
	checkReports(t, res.Items, 2)

	// Pasted, Claude Code records it in <pasted_content> tags; read mid-turn,
	// as a queued command.
	p2 := filepath.Join(t.TempDir(), "s.jsonl")
	write(t, p2,
		user("go"),
		m{"type": "attachment", "attachment": m{"type": "queued_command", "prompt": []m{{"type": "text", "text": `<pasted_content id="1">` + sampleNotification + `</pasted_content id="1">`}}}},
	)
	res, _ = NewReader().Read("claude", p2, "", 0)
	if got := kinds(res.Items); got != "user,report,report" {
		t.Fatalf("queued kinds = %s", got)
	}
	checkReports(t, res.Items, 1)
}

func TestCodexShowsBerthsNotificationAsReports(t *testing.T) {
	p := filepath.Join(t.TempDir(), "rollout.jsonl")
	ri := func(payload m) m {
		return m{"type": "response_item", "timestamp": "2026-10-04T12:00:00Z", "payload": payload}
	}
	write(t, p,
		m{"type": "session_meta", "payload": m{"cwd": "/w/shop"}},
		ri(m{"type": "message", "role": "user", "content": []m{{"type": "input_text", "text": "Hand the migration to Claude"}}}),
		ri(m{"type": "message", "role": "user", "content": []m{{"type": "input_text", "text": sampleNotification}}}),
		ri(m{"type": "message", "role": "assistant", "content": []m{{"type": "output_text", "text": "Claude needs you to allow the migration."}}}),
	)
	res, err := NewReader().Read("codex", p, "/w/shop", 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := kinds(res.Items); got != "user,report,report,text" {
		t.Fatalf("kinds = %s", got)
	}
	checkReports(t, res.Items, 1)
}

func TestTextThatOnlyMentionsTheTagIsAPrompt(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	write(t, p, user("What does <berth-notification> mean?"))
	res, _ := NewReader().Read("claude", p, "", 0)
	if got := kinds(res.Items); got != "user" {
		t.Fatalf("kinds = %s", got)
	}
}
