package box

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/doctor"
	"github.com/cosscom/shipyard/internal/integrations"
)

// accountsHome is an empty home with a fake claude on PATH, and none of
// this process's own account picks.
func accountsHome(t *testing.T) string {
	t.Helper()
	home, bin := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\n"), 0o755)
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "")
	return home
}

func TestConfiguredAccountDirsComeFromTheBoxAndProjects(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	envFile, locFile := filepath.Join(dir, "env.json"), filepath.Join(dir, "locations.json")
	saveBoxEnv(envFile, BoxEnv{Env: map[string]string{"CLAUDE_CONFIG_DIR": "$HOME/.berth/accounts/claude/work", "OTHER": "x"}})
	locs := NewLocations(locFile)
	repo := gitRepo(t)
	locs.Add(ctx, "shop", repo)
	locs.SetLocalConfig("shop", RepoConfig{Env: map[string]string{"CODEX_HOME": "/srv/codex/client", "CLAUDE_CONFIG_DIR": "op://vault/item/field"}})
	got := ConfiguredAccountDirs(envFile, locFile)
	if strings.Join(got["claude"], ",") != "$HOME/.berth/accounts/claude/work" || strings.Join(got["codex"], ",") != "/srv/codex/client" {
		t.Fatalf("configured = %v", got)
	}
	if got := ConfiguredAccountDirs(filepath.Join(dir, "none.json"), ""); len(got) != 0 {
		t.Fatalf("no files: %v", got)
	}
}

func TestASessionOnAFreshAccountHasTheHooksWhenItStarts(t *testing.T) {
	home := accountsHome(t)
	account := filepath.Join(home, "logins", "work")
	os.MkdirAll(account, 0o700)
	envFile := filepath.Join(t.TempDir(), "env.json")
	var bx *Box
	c, bus := servedBox(t, func(b *Box) {
		b.EnvFile = envFile
		b.Sessions.Prepare = b.PrepareAccounts
		bx = b
	})
	seen, stop := bus.Subscribe()
	defer stop()
	// The user installed Terminal's integrations for their default account.
	if status := call(t, c, "POST", "/v1/integrations/install", "", map[string]string{"tool": "claude"}, nil); status != 200 {
		t.Fatalf("install: %d", status)
	}
	// Then picked a new account for the box's sessions.
	if err := saveBoxEnv(envFile, BoxEnv{Env: map[string]string{"CLAUDE_CONFIG_DIR": account}}); err != nil {
		t.Fatal(err)
	}
	repo := gitRepo(t)
	call(t, c, "POST", "/v1/locations", "", map[string]string{"name": "shop", "path": repo}, nil)
	call(t, c, "POST", "/v1/locations/shop/worktrees", "", WorktreeRequest{Name: "fix"}, nil)
	// What the agent finds when it starts.
	cmd := `if grep -q 'hook claude Stop' "$CLAUDE_CONFIG_DIR/settings.json" && test -f "$CLAUDE_CONFIG_DIR/skills/berth/SKILL.md"; then echo READY-ON-START; else echo MISSING-ON-START; fi; cat`
	var sess Session
	if status := call(t, c, "POST", "/v1/sessions", "", map[string]string{"location": "shop/fix", "command": cmd}, &sess); status != 200 {
		t.Fatalf("session: %d", status)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		text, _ := bx.Sessions.Screen(context.Background(), sess.Name, 50)
		if strings.Contains(text, "READY-ON-START") {
			break
		}
		if strings.Contains(text, "MISSING-ON-START") || time.Now().After(deadline) {
			t.Fatalf("screen:\n%s", text)
		}
		time.Sleep(50 * time.Millisecond)
	}
	for {
		select {
		case e := <-seen:
			if e.Type == "integrations.installed" && e.Data["account"] == account {
				return
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no integrations.installed for the account")
		}
	}
}

func TestDoctorAndTheReportListEachAccount(t *testing.T) {
	home := accountsHome(t)
	work := filepath.Join(home, ".berth", "accounts", "claude", "work")
	os.MkdirAll(work, 0o700)
	var bx *Box
	c, _ := servedBox(t, func(b *Box) { bx = b })
	claudeCheck := func() doctor.Check {
		for _, ch := range bx.Doctor(context.Background()) {
			if ch.Name == "Claude Code hooks" {
				return ch
			}
		}
		t.Fatal("no Claude Code check")
		return doctor.Check{}
	}
	if ch := claudeCheck(); ch.Status != doctor.Warn || ch.Fix != "berthd integrations install claude" {
		t.Fatalf("before: %+v", ch)
	}
	// "Add account…" installs in the folder it made, and nowhere else.
	var rep IntegrationsReport
	if status := call(t, c, "POST", "/v1/integrations/install", "", map[string]string{"tool": "claude", "account": work}, &rep); status != 200 || !strings.Contains(rep.Output, "hooks and 7 skills in ~/.berth/accounts/claude/work") {
		t.Fatalf("account install: %d %q", status, rep.Output)
	}
	if ch := claudeCheck(); ch.Status != doctor.Warn || !strings.Contains(ch.Detail, "(hooks and 7 skills in ~/.berth/accounts/claude/work; none in ~/.claude)") {
		t.Fatalf("one account: %+v", ch)
	}
	if status := call(t, c, "POST", "/v1/integrations/install", "", map[string]string{"tool": "claude", "account": t.TempDir()}, nil); status != 400 {
		t.Fatalf("a folder that is no account: %d", status)
	}
	call(t, c, "POST", "/v1/integrations/install", "", map[string]string{"tool": "claude"}, &rep)
	if ch := claudeCheck(); ch.Status != doctor.OK || ch.Detail != "hooks and 7 skills in ~/.claude, ~/.berth/accounts/claude/work" {
		t.Fatalf("after: %+v", ch)
	}
	var claude IntegrationTool
	for _, x := range rep.Tools {
		if x.ID == "claude" {
			claude = x
		}
	}
	if len(claude.Accounts) != 2 || !claude.Accounts[0].Default || claude.Accounts[1].Dir != work || !claude.Accounts[1].Hooked || claude.Accounts[1].Skills != 7 {
		t.Fatalf("report = %+v", claude)
	}

	// A new account shows as missing its hooks until berthd puts them there.
	other := filepath.Join(home, ".berth", "accounts", "claude", "other")
	os.MkdirAll(other, 0o700)
	if ch := claudeCheck(); ch.Status != doctor.Warn || !strings.HasSuffix(ch.Detail, "none in ~/.berth/accounts/claude/other, so Terminal cannot show when an agent on those accounts is done or needs you") {
		t.Fatalf("new account: %+v", ch)
	}
}

func TestUserSkillsGoToEveryClaudeAccount(t *testing.T) {
	home := accountsHome(t)
	work := filepath.Join(home, ".berth", "accounts", "claude", "work")
	os.MkdirAll(work, 0o700)
	c, _ := servedBox(t)
	var rep SkillsReport
	if status := call(t, c, "POST", "/v1/skills/install", "", map[string]any{"skills": "all", "agent": "claude"}, &rep); status != 200 {
		t.Fatalf("install: %d", status)
	}
	for _, dir := range []string{filepath.Join(home, ".claude"), work} {
		if _, err := os.Stat(filepath.Join(dir, "skills", "berth-preview", "SKILL.md")); err != nil {
			t.Fatalf("%s: %v", dir, err)
		}
	}
	// One account without a skill shows it missing.
	os.RemoveAll(filepath.Join(work, "skills", "berth"))
	call(t, c, "GET", "/v1/skills", "", nil, &rep)
	for _, s := range rep.Skills {
		if want := map[bool]integrations.SkillState{true: integrations.SkillMissing, false: integrations.SkillInstalled}[s.Name == "berth"]; s.User["claude"] != want {
			t.Errorf("%s: %s", s.Name, s.User["claude"])
		}
	}
	if status := call(t, c, "POST", "/v1/skills/uninstall", "", map[string]any{"skills": []string{"berth-preview"}, "agent": "claude"}, &rep); status != 200 {
		t.Fatalf("uninstall: %d", status)
	}
	for _, dir := range []string{filepath.Join(home, ".claude"), work} {
		if _, err := os.Stat(filepath.Join(dir, "skills", "berth-preview")); !os.IsNotExist(err) {
			t.Fatalf("%s still has it: %v", dir, err)
		}
	}
}
