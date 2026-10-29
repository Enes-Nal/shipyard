package box

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The forge view is what a project's GitLab knows that its checkout does
// not: open and recently merged merge requests with their pipelines, the
// latest pipelines, and origin's branches. Project activity shows it.
//
// GitLab is asked through glab, signed in on this box (`glab auth login`),
// so no token passes through Shipyard. glab finds the project, on
// gitlab.com or a GitLab of one's own, from the checkout's origin.
// Branches come from git itself, after a fetch.

// ForgeView answers GET /v1/locations/{name}/forge.
type ForgeView struct {
	// Kind is "gitlab", "github" or "git" (anything else, or no origin).
	Kind          string         `json:"kind"`
	Host          string         `json:"host,omitempty"`
	Project       *ForgeProject  `json:"project,omitempty"`
	MergeRequests []MergeRequest `json:"merge_requests"`
	Pipelines     []Pipeline     `json:"pipelines"`
	Branches      []RemoteBranch `json:"branches"`
	// Problem says why GitLab couldn't be asked: "glab_missing",
	// "signed_out" or "failed"; Detail is what glab said. Branches are
	// still listed.
	Problem string    `json:"problem,omitempty"`
	Detail  string    `json:"detail,omitempty"`
	Fetched time.Time `json:"fetched"`
}

type ForgeProject struct {
	Path          string `json:"path"`
	URL           string `json:"url"`
	DefaultBranch string `json:"default_branch,omitempty"`
}

type MergeRequest struct {
	IID     int       `json:"iid"`
	Title   string    `json:"title"`
	State   string    `json:"state"`
	Draft   bool      `json:"draft,omitempty"`
	Source  string    `json:"source_branch"`
	Target  string    `json:"target_branch"`
	Author  string    `json:"author,omitempty"`
	URL     string    `json:"url"`
	SHA     string    `json:"sha,omitempty"`
	Updated time.Time `json:"updated"`
	// Pipeline is the latest one for the merge request's head.
	Pipeline *Pipeline `json:"pipeline,omitempty"`
}

type Pipeline struct {
	ID      int       `json:"id"`
	Status  string    `json:"status"`
	Ref     string    `json:"ref"`
	SHA     string    `json:"sha"`
	URL     string    `json:"url"`
	Updated time.Time `json:"updated"`
}

// RemoteBranch is one of origin's branches, against origin's default one.
type RemoteBranch struct {
	Name    string  `json:"name"`
	Default bool    `json:"default,omitempty"`
	Ahead   int     `json:"ahead"`
	Behind  int     `json:"behind"`
	Last    *Commit `json:"last_commit,omitempty"`
}

const (
	forgeFresh      = time.Minute
	forgeFetchStale = 5 * time.Minute
	forgeBranches   = 30
)

var errGlabMissing = errors.New("glab is not installed on this box")

// These are replaced in tests.
var (
	// glabAPI runs `glab api endpoint` in dir and returns what GitLab said.
	glabAPI = func(ctx context.Context, dir, endpoint string) ([]byte, error) {
		bin, err := toolPath("glab")
		if err != nil {
			return nil, errGlabMissing
		}
		ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, "api", endpoint)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		out, err := cmd.Output()
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) && len(ee.Stderr) > 0 {
				return nil, errors.New(strings.TrimSpace(string(ee.Stderr)))
			}
			return nil, err
		}
		return out, nil
	}
	// glabKnows is whether glab is signed in to host, for a GitLab whose
	// name doesn't say so.
	glabKnows = func(ctx context.Context, host string) bool {
		bin, err := toolPath("glab")
		if err != nil {
			return false
		}
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return exec.CommandContext(ctx, bin, "auth", "status", "--hostname", host).Run() == nil
	}
	// forgeFetch brings origin's branches up to date in dir.
	forgeFetch = func(ctx context.Context, dir string) {
		git(ctx, "-C", dir, "fetch", "--quiet", "--prune", "origin")
	}
	forgeNow = time.Now
)

type forgeCached struct {
	mu      sync.Mutex
	view    *ForgeView
	at      time.Time
	fetched time.Time
}

var forgeCache sync.Map // location path → *forgeCached

func (b *Box) getForgeView(w http.ResponseWriter, r *http.Request) error {
	loc, err := b.Locations.Get(r.Context(), r.PathValue("name"))
	if err != nil {
		return err
	}
	if !loc.Repo {
		return badRequest("%s is not a git repository", loc.Name)
	}
	v, _ := forgeCache.LoadOrStore(loc.Path, &forgeCached{})
	c := v.(*forgeCached)
	c.mu.Lock()
	defer c.mu.Unlock()
	now := forgeNow()
	refresh := r.URL.Query().Get("refresh") == "1"
	if c.view == nil || refresh || now.Sub(c.at) > forgeFresh {
		fetch := refresh || now.Sub(c.fetched) > forgeFetchStale
		c.view = forgeViewOf(r.Context(), loc, fetch)
		c.at = now
		if fetch {
			c.fetched = now
		}
	}
	writeJSON(w, c.view)
	return nil
}

// forgeViewOf reads the forge view of loc; with fetch, origin is fetched
// first so its branches are current.
func forgeViewOf(ctx context.Context, loc Location, fetch bool) *ForgeView {
	v := &ForgeView{Kind: "git", MergeRequests: []MergeRequest{}, Pipelines: []Pipeline{}, Branches: []RemoteBranch{}, Fetched: forgeNow()}
	f := originForge(ctx, loc.Path)
	v.Host = f.Host
	switch {
	case f.Host != "" && (strings.Contains(f.Host, "gitlab") || glabKnows(ctx, f.Host)):
		v.Kind = "gitlab"
	case f.Host != "" && f.GitHub:
		v.Kind = "github"
	}
	if fetch && f.Host != "" {
		forgeFetch(ctx, loc.Path)
	}
	def := defaultBranch(ctx, loc.Path)
	v.Branches = remoteBranches(ctx, loc.Path, def)
	if v.Kind == "gitlab" {
		askGitLab(ctx, loc.Path, v)
	}
	return v
}

// askGitLab fills in the project, its merge requests and pipelines.
func askGitLab(ctx context.Context, dir string, v *ForgeView) {
	var project struct {
		Path          string `json:"path_with_namespace"`
		URL           string `json:"web_url"`
		DefaultBranch string `json:"default_branch"`
	}
	if err := glabJSON(ctx, dir, "projects/:fullpath", &project); err != nil {
		v.Problem, v.Detail = glabProblem(err), err.Error()
		return
	}
	v.Project = &ForgeProject{Path: project.Path, URL: project.URL, DefaultBranch: project.DefaultBranch}
	var pipelines []gitlabPipeline
	var open, merged []gitlabMR
	for _, q := range []struct {
		endpoint string
		into     any
	}{
		{"projects/:fullpath/pipelines?per_page=30", &pipelines},
		{"projects/:fullpath/merge_requests?state=opened&order_by=updated_at&per_page=30", &open},
		{"projects/:fullpath/merge_requests?state=merged&order_by=updated_at&per_page=10", &merged},
	} {
		if err := glabJSON(ctx, dir, q.endpoint, q.into); err != nil {
			v.Problem, v.Detail = glabProblem(err), err.Error()
			return
		}
	}
	v.Pipelines, v.MergeRequests = fromGitLab(pipelines, append(open, merged...))
}

func glabJSON(ctx context.Context, dir, endpoint string, into any) error {
	out, err := glabAPI(ctx, dir, endpoint)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(out, into); err != nil {
		return fmt.Errorf("GitLab answered %s with something other than JSON", endpoint)
	}
	return nil
}

// glabProblem names what kept glab from answering.
func glabProblem(err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case errors.Is(err, errGlabMissing):
		return "glab_missing"
	case strings.Contains(msg, "401"), strings.Contains(msg, "unauthorized"), strings.Contains(msg, "auth login"), strings.Contains(msg, "not logged in"), strings.Contains(msg, "no token"):
		return "signed_out"
	}
	return "failed"
}

type gitlabPipeline struct {
	ID      int       `json:"id"`
	Status  string    `json:"status"`
	Ref     string    `json:"ref"`
	SHA     string    `json:"sha"`
	URL     string    `json:"web_url"`
	Updated time.Time `json:"updated_at"`
}

type gitlabMR struct {
	IID    int    `json:"iid"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Draft  bool   `json:"draft"`
	WIP    bool   `json:"work_in_progress"`
	Source string `json:"source_branch"`
	Target string `json:"target_branch"`
	Author struct {
		Username string `json:"username"`
	} `json:"author"`
	URL     string    `json:"web_url"`
	SHA     string    `json:"sha"`
	Updated time.Time `json:"updated_at"`
}

// fromGitLab is GitLab's pipelines and merge requests as the view lists
// them: each merge request with the latest pipeline for its head.
func fromGitLab(pipelines []gitlabPipeline, mrs []gitlabMR) ([]Pipeline, []MergeRequest) {
	ps := make([]Pipeline, 0, len(pipelines))
	bySHA := map[string]*Pipeline{}
	for _, p := range pipelines {
		ps = append(ps, Pipeline{ID: p.ID, Status: p.Status, Ref: p.Ref, SHA: p.SHA, URL: p.URL, Updated: p.Updated})
	}
	for i := range ps {
		// GitLab lists the newest first; the first for a commit is its latest.
		if _, seen := bySHA[ps[i].SHA]; !seen && ps[i].SHA != "" {
			bySHA[ps[i].SHA] = &ps[i]
		}
	}
	out := make([]MergeRequest, 0, len(mrs))
	for _, m := range mrs {
		mr := MergeRequest{IID: m.IID, Title: m.Title, State: m.State, Draft: m.Draft || m.WIP, Source: m.Source, Target: m.Target, Author: m.Author.Username, URL: m.URL, SHA: m.SHA, Updated: m.Updated}
		if p := bySHA[m.SHA]; p != nil {
			c := *p
			mr.Pipeline = &c
		}
		out = append(out, mr)
	}
	return ps, out
}

// remoteBranches lists origin's branches, most recently committed first,
// with how far each is ahead of and behind origin's default branch.
func remoteBranches(ctx context.Context, dir, def string) []RemoteBranch {
	out, err := git(ctx, "-C", dir, "for-each-ref", "--sort=-committerdate", "--count="+strconv.Itoa(forgeBranches+1),
		"--format=%(refname:lstrip=3)%1f%(objectname)%1f%(objectname:short)%1f%(subject)%1f%(authorname)%1f%(committerdate:iso-strict)%1e", "refs/remotes/origin")
	branches := []RemoteBranch{}
	if err != nil {
		return branches
	}
	for _, rec := range strings.Split(string(out), "\x1e") {
		f := strings.Split(strings.TrimSpace(rec), "\x1f")
		if len(f) != 6 || f[0] == "HEAD" || f[0] == "" || len(branches) == forgeBranches {
			continue
		}
		t, _ := time.Parse(time.RFC3339, f[5])
		rb := RemoteBranch{Name: f[0], Default: f[0] == def, Last: &Commit{SHA: f[1], Short: f[2], Subject: f[3], Author: f[4], Time: t, Parents: []string{}}}
		if def != "" && !rb.Default {
			if counts, err := git(ctx, "-C", dir, "rev-list", "--left-right", "--count", "origin/"+def+"...origin/"+f[0]); err == nil {
				if n := strings.Fields(string(counts)); len(n) == 2 {
					rb.Behind, _ = strconv.Atoi(n[0])
					rb.Ahead, _ = strconv.Atoi(n[1])
				}
			}
		}
		branches = append(branches, rb)
	}
	return branches
}
