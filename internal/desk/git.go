package desk

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// git runs git in dir and returns its trimmed output; an error carries what
// git said.
func git(dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	hide(cmd)
	out, err := cmd.CombinedOutput()
	s := strings.TrimSpace(string(out))
	if err != nil {
		if s == "" {
			s = err.Error()
		}
		return "", errors.New(s)
	}
	return s, nil
}

func isRepo(dir string) bool {
	out, err := git(dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && out == "true"
}

// currentBranch is the branch dir has checked out, or "" when it has none
// (not a repository, or a detached HEAD).
func currentBranch(dir string) string {
	out, err := git(dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return ""
	}
	return out
}

// dirty is whether dir has changes that a branch switch could trip over.
// Files git doesn't track yet carry over a switch, so they don't count.
func dirty(dir string) bool {
	out, err := git(dir, "status", "--porcelain", "--untracked-files=no")
	return err == nil && out != ""
}

func branchExists(dir, name string) bool {
	_, err := git(dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+name)
	return err == nil
}

// ErrDirty is a branch switch refused because of uncommitted changes.
var ErrDirty = errors.New("dirty")

// switchTo checks out branch in dir unless it already is; uncommitted
// changes stop it, so nobody's work is carried onto another branch.
func switchTo(dir, branch string) error {
	if branch == "" || currentBranch(dir) == branch {
		return nil
	}
	if dirty(dir) {
		return fmt.Errorf("%w: the folder has uncommitted changes on %s; commit or stash them to switch to %s", ErrDirty, currentBranch(dir), branch)
	}
	_, err := git(dir, "switch", branch)
	return err
}

// createBranch makes a new branch from what dir has checked out and
// switches to it. Uncommitted changes come along, as `git switch -c` does.
func createBranch(dir, name string) error {
	if !validBranch(name) {
		return fmt.Errorf("%q isn't a branch name git takes", name)
	}
	if branchExists(dir, name) {
		return fmt.Errorf("a branch called %s already exists", name)
	}
	_, err := git(dir, "switch", "-c", name)
	return err
}

var badBranch = regexp.MustCompile(`[\x00-\x20~^:?*\[\\]|\.\.|@\{|//|^/|/$|\.$|\.lock$|^-`)

func validBranch(name string) bool { return name != "" && name != "@" && !badBranch.MatchString(name) }

var nonWord = regexp.MustCompile(`[^a-z0-9]+`)

// BranchFor suggests a branch for a chat from its first message: "Add rate
// limiting to the API" → "add-rate-limiting-to-the". Mirrors branchFor in
// app/src/lib/desk/branch.ts, which suggests it as you type.
func BranchFor(text string) string {
	s := strings.Trim(nonWord.ReplaceAllString(strings.ToLower(text), "-"), "-")
	words := strings.Split(s, "-")
	if len(words) > 5 {
		words = words[:5]
	}
	s = strings.Join(words, "-")
	if len(s) > 40 {
		s = strings.TrimRight(s[:40], "-")
	}
	if s == "" {
		return "chat"
	}
	return s
}
