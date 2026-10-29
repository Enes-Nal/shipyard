package box

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEachMergeRequestGetsTheLatestPipelineOfItsHead(t *testing.T) {
	at := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	pipelines := []gitlabPipeline{
		{ID: 30, Status: "running", Ref: "refs/merge-requests/7/head", SHA: "bbb", Updated: at},
		{ID: 29, Status: "failed", Ref: "feature", SHA: "bbb", Updated: at.Add(-time.Hour)},
		{ID: 28, Status: "success", Ref: "main", SHA: "aaa", Updated: at.Add(-2 * time.Hour)},
	}
	mrs := []gitlabMR{
		{IID: 7, Title: "Feature", State: "opened", Source: "feature", Target: "main", SHA: "bbb"},
		{IID: 6, Title: "Draft: spike", State: "opened", WIP: true, Source: "spike", Target: "main", SHA: "ccc"},
	}
	mrs[0].Author.Username = "me"
	ps, out := fromGitLab(pipelines, mrs)
	if len(ps) != 3 || ps[0].ID != 30 {
		t.Fatalf("pipelines %+v", ps)
	}
	if out[0].Pipeline == nil || out[0].Pipeline.ID != 30 || out[0].Author != "me" {
		t.Fatalf("!7 has %+v", out[0])
	}
	if out[1].Pipeline != nil || !out[1].Draft {
		t.Fatalf("!6 is a draft without a pipeline: %+v", out[1])
	}
}

func TestWhatKeptGlabFromAnswering(t *testing.T) {
	for err, want := range map[error]string{
		errGlabMissing: "glab_missing",
		errors.New("glab: 401 Unauthorized (HTTP 401)"):               "signed_out",
		errors.New("none of the git remotes ... run glab auth login"): "signed_out",
		errors.New("404 Project Not Found"):                           "failed",
		errors.New("dial tcp: lookup gitlab.acme.dev: no such host"):  "failed",
	} {
		if got := glabProblem(err); got != want {
			t.Errorf("%v: %s, want %s", err, got, want)
		}
	}
}

func fakeGitLab(t *testing.T, answers map[string]string, fail error) *[]string {
	t.Helper()
	var asked []string
	old := glabAPI
	glabAPI = func(_ context.Context, _ string, endpoint string) ([]byte, error) {
		asked = append(asked, endpoint)
		if fail != nil {
			return nil, fail
		}
		// The longest prefix answers: projects/:fullpath is the project,
		// not its pipelines.
		best := ""
		for prefix := range answers {
			if strings.HasPrefix(endpoint, prefix) && len(prefix) > len(best) {
				best = prefix
			}
		}
		if best == "" {
			return []byte("[]"), nil
		}
		return []byte(answers[best]), nil
	}
	t.Cleanup(func() { glabAPI = old })
	return &asked
}

func TestGitLabIsAskedForTheProjectItsMergeRequestsAndPipelines(t *testing.T) {
	asked := fakeGitLab(t, map[string]string{
		"projects/:fullpath/pipelines":                   `[{"id":5,"status":"success","ref":"fix","sha":"f1","web_url":"https://gitlab.com/acme/shop/-/pipelines/5","updated_at":"2026-10-01T12:00:00Z"}]`,
		"projects/:fullpath/merge_requests?state=opened": `[{"iid":3,"title":"Fix checkout","state":"opened","source_branch":"fix","target_branch":"main","author":{"username":"me"},"web_url":"https://gitlab.com/acme/shop/-/merge_requests/3","sha":"f1","updated_at":"2026-10-01T12:00:00Z"}]`,
		"projects/:fullpath/merge_requests?state=merged": `[{"iid":2,"title":"Old","state":"merged","source_branch":"old","target_branch":"main","sha":"o1"}]`,
		"projects/:fullpath":                             `{"path_with_namespace":"acme/shop","web_url":"https://gitlab.com/acme/shop","default_branch":"main"}`,
	}, nil)
	v := &ForgeView{}
	askGitLab(context.Background(), t.TempDir(), v)
	if v.Problem != "" {
		t.Fatalf("problem %s: %s", v.Problem, v.Detail)
	}
	if v.Project == nil || v.Project.Path != "acme/shop" || v.Project.DefaultBranch != "main" {
		t.Fatalf("project %+v", v.Project)
	}
	if len(v.MergeRequests) != 2 || v.MergeRequests[0].IID != 3 || v.MergeRequests[0].Pipeline == nil || v.MergeRequests[1].State != "merged" {
		t.Fatalf("merge requests %+v", v.MergeRequests)
	}
	if len(*asked) != 4 {
		t.Fatalf("asked %v", *asked)
	}
}

func TestASignedOutGlabIsSaidOnce(t *testing.T) {
	asked := fakeGitLab(t, nil, errors.New("glab: 401 Unauthorized"))
	v := &ForgeView{}
	askGitLab(context.Background(), t.TempDir(), v)
	if v.Problem != "signed_out" || v.Project != nil || len(*asked) != 1 {
		t.Fatalf("view %+v after %v", v, *asked)
	}
}

func TestOriginsBranchesAreListedAgainstItsDefault(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("needs git")
	}
	root := t.TempDir()
	origin, clone := filepath.Join(root, "origin"), filepath.Join(root, "clone")
	gitIn(t, root, "init", "-q", "-b", "main", origin)
	gitIn(t, origin, "commit", "-q", "--allow-empty", "-m", "first")
	gitIn(t, origin, "checkout", "-q", "-b", "feature")
	gitIn(t, origin, "commit", "-q", "--allow-empty", "-m", "on feature")
	gitIn(t, origin, "commit", "-q", "--allow-empty", "-m", "more on feature")
	gitIn(t, origin, "checkout", "-q", "main")
	gitIn(t, origin, "commit", "-q", "--allow-empty", "-m", "on main")
	gitIn(t, root, "clone", "-q", origin, clone)

	fetched := false
	old := forgeFetch
	forgeFetch = func(context.Context, string) { fetched = true }
	t.Cleanup(func() { forgeFetch = old })

	v := forgeViewOf(context.Background(), Location{Name: "shop", Path: clone, Repo: true}, true)
	if v.Kind != "git" || len(v.MergeRequests) != 0 {
		t.Fatalf("a folder origin is plain git: %+v", v)
	}
	if fetched {
		t.Fatal("a folder origin was fetched as if it were a forge")
	}
	byName := map[string]RemoteBranch{}
	for _, b := range v.Branches {
		byName[b.Name] = b
	}
	if !byName["main"].Default || byName["main"].Last == nil || byName["main"].Last.Subject != "on main" {
		t.Fatalf("main: %+v", byName["main"])
	}
	if f := byName["feature"]; f.Ahead != 2 || f.Behind != 1 || f.Last.Subject != "more on feature" {
		t.Fatalf("feature: %+v (last %+v)", f, f.Last)
	}
	if _, ok := byName["HEAD"]; ok {
		t.Fatal("origin/HEAD is not a branch")
	}
}
