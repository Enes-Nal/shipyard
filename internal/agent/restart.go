package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/version"
)

// Restarting the agent cleanly, for an update. The app's updater replaces
// Terminal.app under a running agent, which goes on running the old code (and
// keeps this computer's box on the old berthd) until it restarts. The
// updated app asks `berth agent restart --if-stale`, which reads what the
// agent runs (GET /v1/agent), and when it is older than the berth asking,
// stops it with ?drain=1 and starts the new one.
//
// Draining: the agent takes no new long work (adding or upgrading a box,
// setting up this computer's box, a queued prompt's send) and waits for
// what is under way to finish, for up to drainLimit, before it stops. Its
// other answers go on meanwhile. Agents' sessions live in tmux on the boxes
// and are never the agent's to stop; the app and terminals reconnect to the
// new agent by themselves.

const drainLimit = 2 * time.Minute

// AgentInfo is what a running agent is, from GET /v1/agent.
type AgentInfo struct {
	Version string `json:"version"`
	// Build is the build ID of the program it started from, read when it
	// started: the file at Exe may have been replaced since.
	Build   string    `json:"build"`
	Exe     string    `json:"exe"`
	PID     int       `json:"pid"`
	Started time.Time `json:"started"`
	// Busy is the long work under way, which a drain waits for.
	Busy     []string `json:"busy,omitempty"`
	Draining bool     `json:"draining,omitempty"`
}

// ErrNoAgentInfo means the agent answers but has no GET /v1/agent: it is
// from a release before this one.
var ErrNoAgentInfo = errors.New("the running agent is from an older release")

// Info asks the running agent what it is.
func (c *Client) Info(ctx context.Context) (AgentInfo, error) {
	var info AgentInfo
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://agent/v1/agent", nil)
	if err != nil {
		return info, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return info, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return info, ErrNoAgentInfo
	}
	if resp.StatusCode != http.StatusOK {
		return info, fmt.Errorf("agent replied %s", resp.Status)
	}
	return info, json.NewDecoder(resp.Body).Decode(&info)
}

// StopDrained asks the agent to finish its work under way and stop. It
// answers at once; Stopped says when it is gone. An agent from before
// draining stops at once.
func (c *Client) StopDrained(ctx context.Context) error {
	return c.call(ctx, http.MethodPost, "/v1/stop?drain=1", nil, nil)
}

// WaitStopped waits for the agent on this socket, with its state in dir, to
// have stopped: nothing answers, and its lock is free for the next one.
func (c *Client) WaitStopped(ctx context.Context, dir string) error {
	for {
		if !c.Running(ctx) && lockFree(dir) {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("the berth agent did not stop: %w", ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// lockFree says whether no agent holds dir's agent lock.
func lockFree(dir string) bool {
	f, err := os.OpenFile(filepath.Join(dir, "agent.lock"), os.O_RDWR, 0)
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	if err != nil {
		return false
	}
	defer f.Close()
	unlock, ok := tryAgentLock(f)
	if !ok {
		return false
	}
	unlock()
	return true
}

// startedAs is the program this agent started from, read once at start.
type startedAs struct {
	exe     string
	build   string
	started time.Time
}

func readStartedAs(now time.Time) startedAs {
	s := startedAs{started: now}
	exe, err := os.Executable()
	if err != nil {
		return s
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	s.exe = exe
	s.build = agentBuild()
	return s
}

// workSet is the long work under way, by what it is.
type workSet struct {
	mu       sync.Mutex
	draining bool
	running  map[string]int
	wg       sync.WaitGroup
}

var errDraining = errors.New("the berth agent is restarting; try again in a moment")

// begin starts a piece of work, unless the agent is draining.
func (w *workSet) begin(what string) (done func(), err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.draining {
		return nil, errDraining
	}
	if w.running == nil {
		w.running = map[string]int{}
	}
	w.running[what]++
	w.wg.Add(1)
	return sync.OnceFunc(func() {
		w.mu.Lock()
		if w.running[what]--; w.running[what] <= 0 {
			delete(w.running, what)
		}
		w.mu.Unlock()
		w.wg.Done()
	}), nil
}

func (w *workSet) busy() (list []string, draining bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for k := range w.running {
		list = append(list, k)
	}
	sort.Strings(list)
	return list, w.draining
}

// drain refuses new work and waits for what is under way, until ctx ends.
func (w *workSet) drain(ctx context.Context) {
	w.mu.Lock()
	w.draining = true
	w.mu.Unlock()
	waitFor(ctx, w.wg.Wait)
}

// waitFor runs f, which blocks, and returns when it does or ctx ends.
func waitFor(ctx context.Context, f func()) bool {
	done := make(chan struct{})
	go func() {
		f()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	}
}

// drain lets the work under way finish before the agent stops: CLI
// commands the app started, this computer's box being set up or updated,
// a chat background being made, and queued prompts being sent. Prompts
// still waiting stay queued for the next agent.
func (a *Agent) drain(ctx context.Context) {
	start := time.Now()
	if busy, _ := a.work.busy(); len(busy) > 0 {
		a.cfg.Log.Printf("restarting: waiting for %v", busy)
	}
	a.work.drain(ctx)
	waitFor(ctx, a.imageGenBusy.Lock)
	waitFor(ctx, a.queue.hold)
	if ctx.Err() != nil {
		busy, _ := a.work.busy()
		a.cfg.Log.Printf("restarting: gave up waiting after %s for %v", time.Since(start).Round(time.Second), busy)
		return
	}
	a.cfg.Log.Printf("restarting: work under way finished in %s", time.Since(start).Round(time.Millisecond))
}

func (a *Agent) restartRoutes(mux *http.ServeMux, stop context.CancelFunc) {
	mux.HandleFunc("GET /v1/agent", func(w http.ResponseWriter, r *http.Request) {
		busy, draining := a.work.busy()
		writeJSON(w, http.StatusOK, AgentInfo{Version: version.Version, Build: a.startedAs.build, Exe: a.startedAs.exe, PID: os.Getpid(), Started: a.startedAs.started, Busy: busy, Draining: draining})
	})
	mux.HandleFunc("POST /v1/stop", func(w http.ResponseWriter, r *http.Request) {
		drain := r.URL.Query().Get("drain") != ""
		busy, _ := a.work.busy()
		writeJSON(w, http.StatusOK, map[string]any{"stopping": true, "busy": busy})
		// Reply before stopping, or the caller would see a dropped connection.
		go func() {
			if drain {
				ctx, cancel := context.WithTimeout(a.ctx, drainLimit)
				a.drain(ctx)
				cancel()
			}
			time.Sleep(50 * time.Millisecond)
			stop()
		}()
	})
}

// Stale says whether the running agent (info, or infoErr when it couldn't
// say) is older than the berth at exe, of build and version, which asks,
// and why. An agent running exe itself is stale once exe was replaced (an
// app update does that); one running another berth only when that is an
// older release. An agent that can't tell is from before GET /v1/agent.
func Stale(info AgentInfo, infoErr error, exe, build, ver string) (bool, string) {
	switch {
	case errors.Is(infoErr, ErrNoAgentInfo):
		return true, "it is from an older release"
	case infoErr != nil:
		return false, ""
	case info.Exe == exe:
		if info.Build != "" && build != "" && info.Build != build {
			return true, fmt.Sprintf("its program was replaced (build %s, now %s)", info.Build, build)
		}
		return false, ""
	case newerRelease(ver, info.Version):
		return true, fmt.Sprintf("it runs berth %s, older than %s", info.Version, ver)
	}
	return false, ""
}
