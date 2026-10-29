package desk

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosscom/shipyard/internal/transcript"
)

// The test binary stands in for Claude Code when DESK_FAKE_AGENT is set: it
// writes the prompt and a reply to the transcript Claude Code would, then
// prints a stream-json result. "sleep" in the prompt makes it take a while,
// "fail" makes the turn fail, and "branch:NAME" switches to a new branch.
func TestMain(m *testing.M) {
	if os.Getenv("DESK_FAKE_AGENT") == "1" {
		fakeAgent()
		return
	}
	os.Exit(m.Run())
}

func fakeAgent() {
	var session string
	for i, a := range os.Args {
		if (a == "--session-id" || a == "--resume") && i+1 < len(os.Args) {
			session = os.Args[i+1]
		}
	}
	in, _ := io.ReadAll(os.Stdin)
	prompt := string(in)
	cwd, _ := os.Getwd()
	dir := transcript.ClaudeDir(cwd)
	_ = os.MkdirAll(dir, 0o700)
	f, _ := os.OpenFile(filepath.Join(dir, session+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	line := func(v any) { b, _ := json.Marshal(v); f.Write(append(b, '\n')) }
	line(map[string]any{"type": "user", "timestamp": "2026-10-28T12:00:00Z", "message": map[string]any{"role": "user", "content": prompt}})
	if strings.Contains(prompt, "sleep") {
		time.Sleep(1500 * time.Millisecond)
	}
	if _, name, ok := strings.Cut(prompt, "branch:"); ok {
		_ = exec.Command("git", "switch", "-q", "-c", strings.Fields(name)[0]).Run()
	}
	line(map[string]any{"type": "assistant", "timestamp": "2026-10-28T12:00:01Z", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Done: " + prompt}}}})
	f.Close()
	fail := strings.Contains(prompt, "fail")
	b, _ := json.Marshal(map[string]any{"type": "result", "is_error": fail, "result": map[bool]string{true: "it broke", false: "ok"}[fail]})
	fmt.Println(string(b))
}

func fakeDesk(t *testing.T) (*Desk, string) {
	t.Helper()
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	t.Setenv("DESK_FAKE_AGENT", "1")
	d, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	exe, _ := os.Executable()
	d.findAgent = func() (string, error) { return exe, nil }
	repo := t.TempDir()
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"config", "user.email", "t@example.com"}, {"config", "user.name", "t"}, {"commit", "-q", "--allow-empty", "-m", "first"}} {
		if _, err := git(repo, args...); err != nil {
			t.Fatal(err)
		}
	}
	return d, repo
}

func waitIdle(t *testing.T, d *Desk, chat string) ChatView {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, c := range d.State().Chats {
			if c.ID == chat && c.Status == "idle" {
				return c
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("chat %s never went idle", chat)
	return ChatView{}
}

func TestChatRunsAndResumes(t *testing.T) {
	d, repo := fakeDesk(t)
	p, err := d.AddProject(repo)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := d.NewChat(p.ID, "")
	if _, err := d.Send(c.ID, "Add rate limiting\nto the API", ""); err != nil {
		t.Fatal(err)
	}
	v := waitIdle(t, d, c.ID)
	if v.Title != "Add rate limiting" || !v.Started || v.Branch != "main" || v.Error != "" {
		t.Fatalf("after the first turn: %+v", v)
	}
	if _, err := d.Send(c.ID, "and tests", ""); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, d, c.ID)
	res, err := d.Items(c.ID, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, it := range res.Items {
		texts = append(texts, it.Kind+":"+it.Text)
	}
	got := strings.Join(texts, " | ")
	for _, want := range []string{"user:Add rate limiting", "text:Done: and tests"} {
		if !strings.Contains(got, want) {
			t.Fatalf("items %q lack %q", got, want)
		}
	}
}

func TestOneChatPerProjectAtATime(t *testing.T) {
	d, repo := fakeDesk(t)
	p, _ := d.AddProject(repo)
	a, _ := d.NewChat(p.ID, "")
	b, _ := d.NewChat(p.ID, "")
	if q, err := d.Send(a.ID, "sleep a while", ""); err != nil || q {
		t.Fatalf("first send: queued=%v err=%v", q, err)
	}
	q, err := d.Send(b.ID, "then me", "")
	if err != nil || !q {
		t.Fatalf("second send should wait: queued=%v err=%v", q, err)
	}
	for _, c := range d.State().Chats {
		if c.ID == b.ID && (c.Status != "queued" || len(c.Queued) != 1) {
			t.Fatalf("waiting chat: %+v", c)
		}
	}
	waitIdle(t, d, a.ID)
	if v := waitIdle(t, d, b.ID); !v.Started {
		t.Fatalf("the waiting chat never ran: %+v", v)
	}
}

func TestBranches(t *testing.T) {
	d, repo := fakeDesk(t)
	p, _ := d.AddProject(repo)
	c, _ := d.NewChat(p.ID, "")
	if _, err := d.Send(c.ID, "start", "feat/limits"); err != nil {
		t.Fatal(err)
	}
	v := waitIdle(t, d, c.ID)
	if v.Branch != "feat/limits" || len(v.Moves) != 1 || v.Moves[0].Kind != "created" || v.Moves[0].From != "main" {
		t.Fatalf("new branch: %+v", v)
	}
	// The agent moving to another branch is noted, and the chat follows it.
	d.Send(c.ID, "branch:feat/other please", "")
	v = waitIdle(t, d, c.ID)
	if v.Branch != "feat/other" || len(v.Moves) != 2 || v.Moves[1].Kind != "switched" {
		t.Fatalf("agent's switch: %+v", v)
	}
	// Another chat on main switches the folder back before it runs, but
	// not over uncommitted changes.
	other, _ := d.NewChat(p.ID, "")
	if _, err := git(repo, "switch", "-q", "main"); err != nil {
		t.Fatal(err)
	}
	d.Send(other.ID, "hi", "")
	waitIdle(t, d, other.ID)
	os.WriteFile(filepath.Join(repo, "f.txt"), []byte("x"), 0o600)
	git(repo, "add", "f.txt")
	if _, err := d.Send(c.ID, "more", ""); err == nil || !strings.Contains(err.Error(), "uncommitted") {
		t.Fatalf("switching over uncommitted changes: %v", err)
	}
	if currentBranch(repo) != "main" {
		t.Fatalf("the folder moved to %s", currentBranch(repo))
	}
}

func TestFailedTurn(t *testing.T) {
	d, repo := fakeDesk(t)
	p, _ := d.AddProject(repo)
	c, _ := d.NewChat(p.ID, "")
	d.Send(c.ID, "fail now", "")
	if v := waitIdle(t, d, c.ID); v.Error != "it broke" {
		t.Fatalf("error: %q", v.Error)
	}
}

func TestBranchFor(t *testing.T) {
	for in, want := range map[string]string{
		"Add rate limiting to the API":    "add-rate-limiting-to-the",
		"  fix: Login *breaks* on Safari": "fix-login-breaks-on-safari",
		"???":                             "chat",
	} {
		if got := BranchFor(in); got != want {
			t.Errorf("BranchFor(%q) = %q, want %q", in, got, want)
		}
	}
	for name, want := range map[string]bool{"feat/x": true, "a..b": false, "-x": false, "x.lock": false, "has space": false} {
		if validBranch(name) != want {
			t.Errorf("validBranch(%q) = %v", name, !want)
		}
	}
}

func TestGuard(t *testing.T) {
	d, _ := fakeDesk(t)
	srv := httptest.NewServer(d.Handler("tok"))
	defer srv.Close()
	do := func(origin, auth string) int {
		req, _ := http.NewRequest("GET", srv.URL+"/v1/state", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if c := do("", "tok"); c != 200 {
		t.Errorf("with the token: %d", c)
	}
	if c := do("http://tauri.localhost", "tok"); c != 200 {
		t.Errorf("from the app: %d", c)
	}
	if c := do("", "nope"); c != 401 {
		t.Errorf("wrong token: %d", c)
	}
	if c := do("https://evil.example", "tok"); c != 403 {
		t.Errorf("another site: %d", c)
	}
}

func TestEventsStream(t *testing.T) {
	d, repo := fakeDesk(t)
	srv := httptest.NewServer(d.Handler("tok"))
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL+"/v1/events", nil)
	req.Header.Set("Authorization", "Bearer tok")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	sc := bufio.NewScanner(res.Body)
	sc.Scan() // ": hello"
	go d.AddProject(repo)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "data: ") {
			if !strings.Contains(sc.Text(), `"state"`) {
				t.Fatalf("event: %s", sc.Text())
			}
			return
		}
	}
	t.Fatal("no event")
}

func TestShimTarget(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
	os.MkdirAll(filepath.Dir(exe), 0o700)
	os.WriteFile(exe, nil, 0o700)
	shim := filepath.Join(dir, "claude.cmd")
	os.WriteFile(shim, []byte("@ECHO off\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n"), 0o600)
	if got := shimTarget(shim); got != exe {
		t.Fatalf("shimTarget = %q, want %q", got, exe)
	}
}
