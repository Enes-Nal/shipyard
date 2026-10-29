package box

import (
	"slices"
	"testing"
)

// A repository on a Windows drive (this PC's box in WSL) gets worktrees
// that Windows can use too, and the box never prunes its worktrees: the
// ones Windows tools made can look lost from WSL.
func TestWorktreesOnAWindowsDriveWorkFromBothSides(t *testing.T) {
	for repo, want := range map[string]bool{
		"/mnt/e/Code/shop":      true,
		"/mnt/c":                true,
		"/mnt/wsl/shop":         false,
		"/home/me/code/shop":    false,
		"/mnt/data/shop":        false,
		"/Users/me/Developer/x": false,
	} {
		if got := onWindowsDrive(repo); got != want {
			t.Errorf("onWindowsDrive(%q) = %v", repo, got)
		}
		opts := worktreeOptions(repo)
		if want != slices.Contains(opts, "worktree.useRelativePaths=true") {
			t.Errorf("worktreeOptions(%q) = %v", repo, opts)
		}
	}
}
