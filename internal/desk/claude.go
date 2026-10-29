package desk

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// findClaude is the Claude Code executable to run: BERTH_DESK_CLAUDE when
// set, otherwise claude on PATH. On Windows npm installs claude.cmd, a shim
// around a real claude.exe; the shim is read for it, so the agent runs with
// no cmd.exe between, which would mangle its arguments.
func findClaude() (string, error) {
	if p := os.Getenv("BERTH_DESK_CLAUDE"); p != "" {
		return p, nil
	}
	p, err := exec.LookPath("claude")
	if err != nil {
		return "", errors.New("Claude Code isn't installed, or isn't on PATH: install it with `npm i -g @anthropic-ai/claude-code`")
	}
	if strings.EqualFold(filepath.Ext(p), ".cmd") {
		if exe := shimTarget(p); exe != "" {
			return exe, nil
		}
	}
	return p, nil
}

var shimExe = regexp.MustCompile(`(?i)"%dp0%\\([^"]+\.exe)"`)

// shimTarget is the .exe an npm .cmd shim starts, when it starts one.
func shimTarget(cmdPath string) string {
	b, err := os.ReadFile(cmdPath)
	if err != nil {
		return ""
	}
	m := shimExe.FindSubmatch(b)
	if m == nil {
		return ""
	}
	exe := filepath.Join(filepath.Dir(cmdPath), filepath.FromSlash(strings.ReplaceAll(string(m[1]), `\`, "/")))
	if _, err := os.Stat(exe); err != nil {
		return ""
	}
	return exe
}

// claudeArgs are the arguments for one turn of c. The prompt goes on stdin,
// never on the command line.
func claudeArgs(c Chat) []string {
	args := []string{"-p", "--output-format", "stream-json", "--verbose"}
	if c.Started {
		args = append(args, "--resume", c.Session)
	} else {
		args = append(args, "--session-id", c.Session)
	}
	if c.Access == "edits" {
		args = append(args, "--permission-mode", "acceptEdits")
	} else {
		args = append(args, "--permission-mode", "bypassPermissions")
	}
	return args
}

// nested are variables a Claude Code session sets for what it runs. Shipyard
// started from inside one (a dev build run by an agent) would otherwise pass
// them on, and the chat's agent would take itself for that session's child.
var nested = []string{"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
	"CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_EXECPATH", "CLAUDE_PID", "CLAUDE_AGENT_SDK_VERSION"}

func agentEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		skip := false
		for _, n := range nested {
			if strings.EqualFold(name, n) {
				skip = true
				break
			}
		}
		if !skip {
			env = append(env, kv)
		}
	}
	return env
}

// turn is one run of the agent: started with the prompt on stdin, it reads
// the agent's stream for how the turn ended.
type turn struct {
	cmd    *exec.Cmd
	done   chan struct{}
	mu     sync.Mutex
	failed string // what went wrong, when the turn didn't finish well
}

func startTurn(exe, dir string, c Chat, prompt string) (*turn, error) {
	cmd := exec.Command(exe, claudeArgs(c)...)
	cmd.Dir = dir
	cmd.Env = agentEnv()
	hide(cmd)
	cmd.Stdin = strings.NewReader(prompt)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &tail{max: 2000}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	t := &turn{cmd: cmd, done: make(chan struct{})}
	go func() {
		defer close(t.done)
		result := readStream(stdout)
		err := cmd.Wait()
		t.mu.Lock()
		defer t.mu.Unlock()
		switch {
		case result.ok:
		case result.text != "":
			t.failed = result.text
		case err != nil:
			t.failed = firstNonEmpty(strings.TrimSpace(stderr.String()), err.Error())
		}
	}()
	return t, nil
}

// stop ends the turn and whatever the agent started.
func (t *turn) stop() { killTree(t.cmd.Process) }

func (t *turn) failure() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.failed
}

type streamResult struct {
	ok   bool
	text string
}

// readStream reads Claude Code's stream-json to its result line. Only how
// the turn ended is taken from it; what was said is read from the agent's
// transcript, where it is kept.
func readStream(r io.Reader) streamResult {
	var res streamResult
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for sc.Scan() {
		var line struct {
			Type    string `json:"type"`
			IsError bool   `json:"is_error"`
			Result  string `json:"result"`
		}
		if json.Unmarshal(sc.Bytes(), &line) != nil || line.Type != "result" {
			continue
		}
		res = streamResult{ok: !line.IsError, text: line.Result}
		if line.IsError && res.text == "" {
			res.text = "the agent stopped with an error"
		}
	}
	_, _ = io.Copy(io.Discard, r)
	return res
}

// tail keeps the last max bytes written to it.
type tail struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = t.b[len(t.b)-t.max:]
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.b)
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
