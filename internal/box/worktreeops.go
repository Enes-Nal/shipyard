package box

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/cosscom/shipyard/internal/statefile"
)

// Managing worktrees in bulk: where each stands against its base, its
// commits, bringing it up to date, and pausing it so it costs nothing until
// it is wanted again.

// Commit is one commit in a worktree's history.
type Commit struct {
	SHA     string    `json:"sha"`
	Short   string    `json:"short"`
	Subject string    `json:"subject"`
	Author  string    `json:"author"`
	Time    time.Time `json:"time"`
	Refs    string    `json:"refs,omitempty"`
	// Parents are the commits this one follows; two or more for a merge.
	// With them a client can draw the history as a graph.
	Parents []string `json:"parents"`
	// OnBase is false for commits the base branch does not have yet.
	OnBase bool `json:"on_base"`
}

// WorktreeStatus is where a worktree stands.
type WorktreeStatus struct {
	Location string  `json:"location"`
	Name     string  `json:"name"`
	Title    string  `json:"title,omitempty"`
	Path     string  `json:"path"`
	Remote   string  `json:"remote,omitempty"`
	Branch   string  `json:"branch,omitempty"`
	Main     bool    `json:"main,omitempty"`
	Port     int     `json:"port,omitempty"`
	Base     string  `json:"base,omitempty"`
	Ahead    int     `json:"ahead"`
	Behind   int     `json:"behind"`
	Upstream string  `json:"upstream,omitempty"`
	Outgoing int     `json:"outgoing"`
	Incoming int     `json:"incoming"`
	Published bool   `json:"published"`
	Changed  int     `json:"changed"`
	Untrack  int     `json:"untracked"`
	Last     *Commit `json:"last_commit,omitempty"`
	Paused   bool    `json:"paused,omitempty"`
	Sessions int     `json:"sessions"`
	Error    string  `json:"error,omitempty"`
}

// baseOf is what a worktree is compared and synced against: its upstream,
// else origin's default branch, else the local default branch.
func baseOf(ctx context.Context, wt Worktree, loc Location) string {
	if out, err := git(ctx, "-C", wt.Path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"); err == nil {
		if u := strings.TrimSpace(string(out)); u != "" && u != wt.Branch {
			return u
		}
	}
	def := loc.DefaultBranch
	if def == "" {
		def = "main"
	}
	if wt.Branch == def {
		if branchExists(ctx, loc.Path, "refs/remotes/origin/"+def) {
			return "origin/" + def
		}
		return ""
	}
	if branchExists(ctx, loc.Path, "refs/remotes/origin/"+def) {
		return "origin/" + def
	}
	return def
}

func (b *Box) worktreeStatus(ctx context.Context, loc Location, wt Worktree, sessions []Session) WorktreeStatus {
	st := WorktreeStatus{Location: loc.Name, Name: wt.Name, Title: wt.Title, Path: wt.Path, Remote: loc.Remote, Branch: wt.Branch, Main: wt.Main, Port: wt.Port}
	st.Base = baseOf(ctx, wt, loc)
	if st.Base != "" {
		if out, err := git(ctx, "-C", wt.Path, "rev-list", "--left-right", "--count", st.Base+"...HEAD"); err == nil {
			f := strings.Fields(string(out))
			if len(f) == 2 {
				st.Behind, _ = strconv.Atoi(f[0])
				st.Ahead, _ = strconv.Atoi(f[1])
			}
		}
	}
	// Base drift answers "what changed from main?" while upstream drift
	// answers the everyday push/pull question. Keep them separate: a feature
	// branch can be fully pushed and still be several commits ahead of main.
	if out, err := git(ctx, "-C", wt.Path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"); err == nil {
		st.Upstream = strings.TrimSpace(string(out))
	}
	if st.Upstream == "" && wt.Branch != "" && branchExists(ctx, wt.Path, "refs/remotes/origin/"+wt.Branch) {
		st.Upstream = "origin/" + wt.Branch
	}
	if st.Upstream != "" {
		st.Published = true
		if out, err := git(ctx, "-C", wt.Path, "rev-list", "--left-right", "--count", st.Upstream+"...HEAD"); err == nil {
			f := strings.Fields(string(out))
			if len(f) == 2 {
				st.Incoming, _ = strconv.Atoi(f[0])
				st.Outgoing, _ = strconv.Atoi(f[1])
			}
		}
	} else if !wt.Main {
		// An unpublished branch has no remote comparison yet. Its commits
		// beyond the base are exactly what the first push will publish.
		st.Outgoing = st.Ahead
	}
	if out, err := git(ctx, "-C", wt.Path, "status", "--porcelain=v1"); err == nil {
		for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
			switch {
			case line == "":
			case strings.HasPrefix(line, "??"):
				st.Untrack++
			default:
				st.Changed++
			}
		}
	} else {
		st.Error = strings.TrimSpace(string(out))
	}
	if commits, err := gitLog(ctx, wt.Path, "", 1); err == nil && len(commits) == 1 {
		st.Last = &commits[0]
	}
	st.Paused = b.Paused.has(wt.Path)
	for _, s := range sessions {
		if samePath(s.Dir, wt.Path) && !s.Exited {
			st.Sessions++
		}
	}
	return st
}

const logFormat = "%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1f%P%x1e"

// gitLog lists commits from HEAD, newest first. With withBase, the base's
// own recent commits come too, in graph order, so the history shows where
// the branch left its base and what the base has done since.
func gitLog(ctx context.Context, dir, base string, limit int, withBase ...bool) ([]Commit, error) {
	args := []string{"-C", dir, "log", "-n", strconv.Itoa(limit), "--format=" + logFormat}
	if len(withBase) > 0 && withBase[0] && base != "" {
		args = append(args, "--topo-order", "HEAD", base)
	}
	out, err := git(ctx, args...)
	if err != nil {
		return nil, fmt.Errorf("git log: %s", strings.TrimSpace(string(out)))
	}
	notOnBase := map[string]bool{}
	if base != "" {
		if ahead, err := git(ctx, "-C", dir, "rev-list", base+"..HEAD"); err == nil {
			for _, sha := range strings.Fields(string(ahead)) {
				notOnBase[sha] = true
			}
		}
	}
	commits := []Commit{}
	for _, rec := range strings.Split(string(out), "\x1e") {
		f := strings.Split(strings.TrimSpace(rec), "\x1f")
		if len(f) != 7 {
			continue
		}
		t, _ := time.Parse(time.RFC3339, f[4])
		parents := strings.Fields(f[6])
		if parents == nil {
			parents = []string{}
		}
		commits = append(commits, Commit{SHA: f[0], Short: f[1], Subject: f[2], Author: f[3], Time: t, Refs: f[5], Parents: parents, OnBase: base == "" || !notOnBase[f[0]]})
	}
	return commits, nil
}

func (b *Box) listWorktreeStatuses(w http.ResponseWriter, r *http.Request) error {
	locs, err := b.Locations.List(r.Context())
	if err != nil {
		return err
	}
	only := r.URL.Query().Get("location")
	sessions, _ := b.Sessions.List(r.Context())
	type job struct {
		loc Location
		wt  Worktree
	}
	var jobs []job
	for _, l := range locs {
		if !l.Repo || (only != "" && l.Name != only) {
			continue
		}
		for _, wt := range l.Worktrees {
			jobs = append(jobs, job{l, wt})
		}
	}
	out := make([]WorktreeStatus, len(jobs))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			out[i] = b.worktreeStatus(r.Context(), j.loc, j.wt, sessions)
		}()
	}
	wg.Wait()
	writeJSON(w, out)
	return nil
}

func (b *Box) worktreeLog(w http.ResponseWriter, r *http.Request) error {
	loc, wt, err := b.worktreeRef(r.Context(), r.PathValue("name"), r.PathValue("worktree"))
	if err != nil {
		return err
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	base := baseOf(r.Context(), wt, loc)
	commits, err := gitLog(r.Context(), wt.Path, base, limit, r.URL.Query().Get("graph") == "1")
	if err != nil {
		return badRequest("%v", err)
	}
	writeJSON(w, map[string]any{"base": base, "commits": commits})
	return nil
}

// SyncResult reports bringing a worktree up to date with its base.
type SyncResult struct {
	Mode      string   `json:"mode"`
	Base      string   `json:"base"`
	OK        bool     `json:"ok"`
	Output    string   `json:"output"`
	Conflicts []string `json:"conflicts,omitempty"`
	Ahead     int      `json:"ahead"`
	Behind    int      `json:"behind"`
}

// SyncWorktree fetches, then rebases onto, merges, or fast-forwards to the
// worktree's base. A conflict is backed out, leaving the worktree as it was.
func (b *Box) SyncWorktree(ctx context.Context, location, worktree, mode string) (SyncResult, error) {
	loc, wt, err := b.worktreeRef(ctx, location, worktree)
	if err != nil {
		return SyncResult{}, err
	}
	if mode == "" {
		mode = "rebase"
	}
	res := SyncResult{Mode: mode, Base: baseOf(ctx, wt, loc)}
	var out strings.Builder
	run := func(args ...string) error {
		o, err := git(ctx, append([]string{"-C", wt.Path}, args...)...)
		out.Write(o)
		return err
	}
	run("fetch", "--quiet", "origin")
	if res.Base == "" {
		return res, badRequest("%s has nothing to sync with", worktree)
	}
	var err2 error
	switch mode {
	case "rebase":
		// Uncommitted work is set aside and put back afterwards.
		err2 = run("rebase", "--autostash", res.Base)
	case "merge":
		err2 = run("merge", "--no-edit", "--autostash", res.Base)
	case "pull":
		err2 = run("merge", "--ff-only", res.Base)
	default:
		return res, badRequest("mode must be rebase, merge or pull")
	}
	if err2 != nil {
		if c, err := git(ctx, "-C", wt.Path, "diff", "--name-only", "--diff-filter=U"); err == nil {
			res.Conflicts = strings.Fields(string(c))
		}
		switch mode {
		case "rebase":
			git(ctx, "-C", wt.Path, "rebase", "--abort")
		case "merge":
			git(ctx, "-C", wt.Path, "merge", "--abort")
		}
	}
	res.OK = err2 == nil
	res.Output = tail(out.String(), 8000)
	st := b.worktreeStatus(ctx, loc, wt, nil)
	res.Ahead, res.Behind = st.Ahead, st.Behind
	return res, nil
}

func (b *Box) syncWorktree(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mode string `json:"mode"`
	}
	decode(r, &req)
	loc, name := r.PathValue("name"), r.PathValue("worktree")
	if err := b.before(r, "worktree.sync", map[string]any{"location": loc, "name": name, "mode": req.Mode}); err != nil {
		return err
	}
	res, err := b.SyncWorktree(r.Context(), loc, name, req.Mode)
	if err != nil {
		return err
	}
	data := map[string]any{"location": loc, "name": name, "mode": res.Mode, "ok": res.OK, "base": res.Base}
	if !res.OK {
		data["conflicts"] = len(res.Conflicts)
	}
	b.publish(r, "worktree.synced", data)
	writeJSON(w, res)
	return nil
}

// Pausing: an agent's processes are stopped where they are (SIGSTOP), so
// it uses no CPU and carries on exactly where it was when resumed, and the
// worktree's services are stopped and remembered to be started again.

// PauseStore remembers paused worktrees across daemon restarts.
type PauseStore struct {
	Path string
	mu   sync.Mutex
}

type pausedWorktree struct {
	Sessions []string  `json:"sessions"`
	Services []string  `json:"services"`
	At       time.Time `json:"at"`
}

func (p *PauseStore) load() map[string]pausedWorktree {
	m := map[string]pausedWorktree{}
	if p == nil {
		return m
	}
	if b, err := os.ReadFile(p.Path); err == nil {
		json.Unmarshal(b, &m)
	}
	return m
}

func (p *PauseStore) save(m map[string]pausedWorktree) error {
	b, _ := json.MarshalIndent(m, "", "  ")
	return statefile.Write(p.Path, b)
}

func (p *PauseStore) has(path string) bool {
	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	_, ok := p.load()[path]
	return ok
}

// samePath compares directories as the filesystem sees them: tmux reports
// /private/var where git says /var on macOS.
func samePath(a, b string) bool {
	if a == b {
		return true
	}
	ra, err1 := filepath.EvalSymlinks(a)
	rb, err2 := filepath.EvalSymlinks(b)
	return err1 == nil && err2 == nil && ra == rb
}

// processTree is pid and every process under it.
func processTree(pid int) []int {
	out, err := exec.Command("ps", "-A", "-o", "pid=,ppid=").Output()
	if err != nil {
		return []int{pid}
	}
	children := map[int][]int{}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		c, _ := strconv.Atoi(f[0])
		p, _ := strconv.Atoi(f[1])
		children[p] = append(children[p], c)
	}
	tree := []int{pid}
	for i := 0; i < len(tree); i++ {
		tree = append(tree, children[tree[i]]...)
	}
	return tree
}

// freezeSession stops every process of a session where it is, or lets them
// carry on. tmux resumes a pane's own process when it is stopped with
// SIGSTOP, but leaves one stopped by SIGTTIN, so the pane's process gets that
// and everything under it SIGSTOP.
func (s *Sessions) freezeSession(ctx context.Context, name string, freeze bool) error {
	out, err := s.tmux(ctx, "list-panes", "-t", "="+name+":", "-F", "#{pane_pid}")
	if err != nil {
		return tmuxError("list-panes", out, err)
	}
	for _, f := range strings.Fields(string(out)) {
		pid, err := strconv.Atoi(f)
		if err != nil || pid <= 1 {
			continue
		}
		tree := processTree(pid)
		if !freeze {
			for _, p := range tree {
				syscall.Kill(p, syscall.SIGCONT)
			}
			continue
		}
		// Children first, so none is left running by a parent that stopped.
		for i := len(tree) - 1; i > 0; i-- {
			syscall.Kill(tree[i], syscall.SIGSTOP)
		}
		syscall.Kill(pid, syscall.SIGTTIN)
	}
	return nil
}

// PauseWorktree stops a worktree's agents where they are and its services.
// Plain shells are left alone: they cost nothing while idle, and freezing a
// command under an interactive shell would confuse its job control.
func (b *Box) PauseWorktree(ctx context.Context, location, worktree string) (WorktreeStatus, error) {
	loc, wt, err := b.worktreeRef(ctx, location, worktree)
	if err != nil {
		return WorktreeStatus{}, err
	}
	b.Paused.mu.Lock()
	m := b.Paused.load()
	if _, already := m[wt.Path]; already {
		b.Paused.mu.Unlock()
		return b.worktreeStatus(ctx, loc, wt, nil), nil
	}
	rec := pausedWorktree{At: time.Now().UTC(), Sessions: []string{}, Services: []string{}}
	sessions, _ := b.Sessions.List(ctx)
	for _, s := range sessions {
		if samePath(s.Dir, wt.Path) && !s.Exited && s.Service == "" && agentOf(s.Command) != "" {
			if err := b.Sessions.freezeSession(ctx, s.Name, true); err == nil {
				rec.Sessions = append(rec.Sessions, s.Name)
			}
		}
	}
	if svcs, err := b.WorktreeServices(ctx, loc.Name, wt.Name); err == nil {
		for _, s := range svcs {
			if s.State != "stopped" {
				b.haltService(ctx, s)
				rec.Services = append(rec.Services, s.Name)
			}
		}
	}
	m[wt.Path] = rec
	err = b.Paused.save(m)
	// worktreeStatus reads the store too; the lock is not re-entrant.
	b.Paused.mu.Unlock()
	if err != nil {
		return WorktreeStatus{}, err
	}
	return b.worktreeStatus(ctx, loc, wt, sessions), nil
}

// ResumeWorktree lets a paused worktree's agents carry on and starts the
// services it had running.
func (b *Box) ResumeWorktree(ctx context.Context, location, worktree string) (WorktreeStatus, error) {
	loc, wt, err := b.worktreeRef(ctx, location, worktree)
	if err != nil {
		return WorktreeStatus{}, err
	}
	b.Paused.mu.Lock()
	m := b.Paused.load()
	rec, ok := m[wt.Path]
	delete(m, wt.Path)
	saveErr := b.Paused.save(m)
	b.Paused.mu.Unlock()
	if saveErr != nil {
		return WorktreeStatus{}, saveErr
	}
	if ok {
		for _, s := range rec.Sessions {
			b.Sessions.freezeSession(ctx, s, false)
		}
		for _, s := range rec.Services {
			b.StartService(ctx, loc.Name, wt.Name, s)
		}
	}
	return b.worktreeStatus(ctx, loc, wt, nil), nil
}

func (b *Box) pauseAction(w http.ResponseWriter, r *http.Request) error {
	loc, name, action := r.PathValue("name"), r.PathValue("worktree"), r.PathValue("action")
	if b.Paused == nil {
		return httpError{http.StatusNotImplemented, "this box cannot pause worktrees"}
	}
	if err := b.before(r, "worktree."+action, map[string]any{"location": loc, "name": name}); err != nil {
		return err
	}
	var st WorktreeStatus
	var err error
	switch action {
	case "pause":
		st, err = b.PauseWorktree(r.Context(), loc, name)
	case "resume":
		st, err = b.ResumeWorktree(r.Context(), loc, name)
	default:
		return badRequest("use pause or resume")
	}
	if err != nil {
		return err
	}
	b.publish(r, "worktree."+action+"d", map[string]any{"location": loc, "name": name, "path": st.Path})
	writeJSON(w, st)
	return nil
}
