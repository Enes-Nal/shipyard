package box

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/events"
)

// cloneWithWorktree makes an origin, a clone of it as a location, and a
// worktree with one commit of its own.
func cloneWithWorktree(t *testing.T) (*Box, string, Worktree) {
	t.Helper()
	ctx := context.Background()
	origin := gitRepo(t)
	clone := filepath.Join(t.TempDir(), "app")
	gitIn(t, filepath.Dir(clone), "clone", "-q", origin, clone)
	dir := t.TempDir()
	b := &Box{Name: "devbox", Locations: NewLocations(filepath.Join(dir, "locations.json")), Events: &events.Bus{},
		Sessions: testSessions(t), Paused: &PauseStore{Path: filepath.Join(dir, "paused.json")}}
	if _, err := b.Locations.Add(ctx, "app", clone); err != nil {
		t.Fatal(err)
	}
	wt, err := b.Locations.CreateWorktree(ctx, "app", "feature", "", "")
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(wt.Path, "feature.txt"), []byte("mine"), 0o644)
	gitIn(t, wt.Path, "add", ".")
	gitIn(t, wt.Path, "commit", "-q", "-m", "Add the feature")
	return b, origin, wt
}

func TestWorktreeStatusAndHistoryCompareWithTheBase(t *testing.T) {
	ctx := context.Background()
	b, origin, wt := cloneWithWorktree(t)
	// main moves on upstream.
	os.WriteFile(filepath.Join(origin, "upstream.txt"), []byte("theirs"), 0o644)
	gitIn(t, origin, "add", ".")
	gitIn(t, origin, "commit", "-q", "-m", "Upstream change")
	gitIn(t, wt.Path, "fetch", "-q", "origin")
	os.WriteFile(filepath.Join(wt.Path, "scratch.txt"), []byte("x"), 0o644)

	loc, _ := b.Locations.Get(ctx, "app")
	st := b.worktreeStatus(ctx, loc, Worktree{Name: "feature", Path: wt.Path, Branch: "feature"}, nil)
	if st.Base != "origin/main" || st.Ahead != 1 || st.Behind != 1 || st.Upstream != "" || st.Published || st.Outgoing != 1 || st.Incoming != 0 || st.Untrack != 1 || st.Last == nil || st.Last.Subject != "Add the feature" {
		t.Fatalf("status = %+v", st)
	}
	commits, err := gitLog(ctx, wt.Path, st.Base, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(commits) != 2 || commits[0].OnBase || !commits[1].OnBase || commits[0].Author != "t" {
		t.Fatalf("log = %+v", commits)
	}
}

func TestWorktreeStatusSeparatesPushPullFromBaseDrift(t *testing.T) {
	ctx := context.Background()
	b, _, wt := cloneWithWorktree(t)
	gitIn(t, wt.Path, "push", "-q", "-u", "origin", "feature")
	loc, _ := b.Locations.Get(ctx, "app")
	st := b.worktreeStatus(ctx, loc, Worktree{Name: "feature", Path: wt.Path, Branch: "feature"}, nil)
	if st.Upstream != "origin/feature" || !st.Published || st.Outgoing != 0 || st.Incoming != 0 {
		t.Fatalf("published status = %+v", st)
	}

	if err := os.WriteFile(filepath.Join(wt.Path, "another.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, wt.Path, "add", ".")
	gitIn(t, wt.Path, "commit", "-q", "-m", "Another local change")
	st = b.worktreeStatus(ctx, loc, Worktree{Name: "feature", Path: wt.Path, Branch: "feature"}, nil)
	if st.Outgoing != 1 || st.Incoming != 0 {
		t.Fatalf("outgoing status = %+v", st)
	}
}

func TestSyncRebasesAndBacksOutOfAConflict(t *testing.T) {
	ctx := context.Background()
	b, origin, wt := cloneWithWorktree(t)
	os.WriteFile(filepath.Join(origin, "upstream.txt"), []byte("theirs"), 0o644)
	gitIn(t, origin, "add", ".")
	gitIn(t, origin, "commit", "-q", "-m", "Upstream change")

	res, err := b.SyncWorktree(ctx, "app", "feature", "rebase")
	if err != nil || !res.OK || res.Behind != 0 || res.Ahead != 1 {
		t.Fatalf("clean rebase: %+v %v", res, err)
	}

	// Both sides change the same file: the rebase must stop and undo itself.
	os.WriteFile(filepath.Join(origin, "feature.txt"), []byte("theirs too"), 0o644)
	gitIn(t, origin, "add", ".")
	gitIn(t, origin, "commit", "-q", "-m", "Conflicting change")
	res, err = b.SyncWorktree(ctx, "app", "feature", "rebase")
	if err != nil || res.OK || len(res.Conflicts) != 1 || res.Conflicts[0] != "feature.txt" {
		t.Fatalf("conflicting rebase: %+v %v", res, err)
	}
	if b, _ := os.ReadFile(filepath.Join(wt.Path, "feature.txt")); string(b) != "mine" {
		t.Fatalf("the worktree was left mid-rebase: feature.txt = %q", b)
	}
	if _, err := os.Stat(filepath.Join(wt.Path, ".git")); err != nil {
		t.Fatal(err)
	}
}

func TestPausedAgentsStopAndCarryOnWhereTheyWere(t *testing.T) {
	ctx := context.Background()
	b, _, wt := cloneWithWorktree(t)
	// A stand-in agent that counts five times a second.
	fake := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(fake, []byte("#!/bin/sh\ni=0; while true; do i=$((i+1)); echo tick-$i; sleep 0.2; done\n"), 0o755)
	if _, err := b.Sessions.Create(ctx, "counter", "app/feature", wt.Path, fake, nil); err != nil {
		t.Fatal(err)
	}
	time.Sleep(600 * time.Millisecond)
	st, err := b.PauseWorktree(ctx, "app", "feature")
	if err != nil || !st.Paused {
		t.Fatalf("pause: %+v %v", st, err)
	}
	screen := func() string { s, _ := b.Sessions.Screen(ctx, "counter", 200); return strings.TrimSpace(s) }
	// A tick printed just before the stop may reach tmux's screen a moment
	// later, more so on a loaded machine: wait until it has held still for
	// half a second before taking it as frozen.
	frozen := screen()
	for still, deadline := time.Now(), time.Now().Add(5*time.Second); time.Since(still) < 500*time.Millisecond && time.Now().Before(deadline); {
		time.Sleep(100 * time.Millisecond)
		if s := screen(); s != frozen {
			frozen, still = s, time.Now()
		}
	}
	time.Sleep(800 * time.Millisecond)
	if screen() != frozen {
		t.Fatal("a paused session kept running")
	}
	if st, err := b.ResumeWorktree(ctx, "app", "feature"); err != nil || st.Paused {
		t.Fatalf("resume: %+v %v", st, err)
	}
	// It prints every 0.2s once resumed; a loaded machine may take a while
	// to schedule it and to draw what it printed.
	for deadline := time.Now().Add(5 * time.Second); screen() == frozen; time.Sleep(100 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("a resumed session did not carry on")
		}
	}
}

func TestTheGraphHistoryShowsMergesAndTheBase(t *testing.T) {
	ctx := context.Background()
	b, origin, wt := cloneWithWorktree(t)
	os.WriteFile(filepath.Join(origin, "upstream.txt"), []byte("theirs"), 0o644)
	gitIn(t, origin, "add", ".")
	gitIn(t, origin, "commit", "-q", "-m", "Upstream change")
	gitIn(t, wt.Path, "fetch", "-q", "origin")
	gitIn(t, wt.Path, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "origin/main")
	loc, _ := b.Locations.Get(ctx, "app")
	base := baseOf(ctx, Worktree{Path: wt.Path, Branch: "feature"}, loc)
	commits, err := gitLog(ctx, wt.Path, base, 20, true)
	if err != nil {
		t.Fatal(err)
	}
	merges := 0
	for _, c := range commits {
		if len(c.Parents) == 2 {
			merges++
		}
	}
	if merges != 1 || len(commits) != 4 {
		t.Fatalf("%d commits, %d merges: %+v", len(commits), merges, commits)
	}
}
