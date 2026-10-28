package agent

import (
	"context"
	"errors"
	"io"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeWSL stands in for wsl.exe: each run is answered by answer, and
// recorded.
type fakeWSL struct {
	mu     sync.Mutex
	runs   [][]string
	answer func(args []string) ([]byte, error)
}

func (f *fakeWSL) install(t *testing.T) {
	old := wslRun
	wslRun = func(_ context.Context, args ...string) ([]byte, error) {
		f.mu.Lock()
		f.runs = append(f.runs, args)
		f.mu.Unlock()
		return f.answer(args)
	}
	t.Cleanup(func() { wslRun = old })
}

func (f *fakeWSL) scripts() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.runs {
		out = append(out, strings.Join(r, " "))
	}
	return strings.Join(out, "\n")
}

func wslTestAgent(t *testing.T) *Agent {
	dir := t.TempDir()
	bundled := filepath.Join(dir, "berthd-linux")
	writeFile(t, bundled, "linux berthd", 0o755)
	return &Agent{cfg: Config{Dir: filepath.Join(dir, "client"), Berthd: bundled, Log: log.New(io.Discard, "", 0)}}
}

func TestWSLStatusSaysHowToInstallWSL(t *testing.T) {
	f := &fakeWSL{answer: func([]string) ([]byte, error) { return nil, errors.New("exit status 1") }}
	f.install(t)
	st := wslTestAgent(t).wslBoxStatus()
	if st.Supported || st.Available {
		t.Fatalf("supported without WSL: %+v", st)
	}
	if !strings.Contains(st.Reason, "wsl --install") {
		t.Fatalf("reason %q doesn't say how to install WSL", st.Reason)
	}
}

func TestWSLStatusWithWSL(t *testing.T) {
	f := &fakeWSL{answer: func([]string) ([]byte, error) { return []byte("/home/me"), nil }}
	f.install(t)
	st := wslTestAgent(t).wslBoxStatus()
	if !st.Supported || !st.Available || st.Installed {
		t.Fatalf("status %+v", st)
	}
}

func TestWSLCopyOnlyWhenChanged(t *testing.T) {
	a := wslTestAgent(t)
	same := true
	f := &fakeWSL{answer: func(args []string) ([]byte, error) {
		if args[0] == "wslpath" {
			return []byte("/mnt/c/app/berthd-linux\n"), nil
		}
		if strings.HasPrefix(args[2], "cmp") && !same {
			return nil, errors.New("exit status 1")
		}
		return nil, nil
	}}
	f.install(t)
	say := func(string, ...any) {}
	if updated, err := a.copyWSLBerthd(context.Background(), a.cfg.Berthd, "/home/me/.berth/bin/berthd", say); err != nil || updated {
		t.Fatalf("same build: updated %v, %v", updated, err)
	}
	same = false
	if updated, err := a.copyWSLBerthd(context.Background(), a.cfg.Berthd, "/home/me/.berth/bin/berthd", say); err != nil || !updated {
		t.Fatalf("new build: updated %v, %v", updated, err)
	}
	if got := f.scripts(); !strings.Contains(got, "/mnt/c/app/berthd-linux /home/me/.berth/bin/berthd") || !strings.Contains(got, "mv -f") {
		t.Fatalf("didn't copy from the Windows path into WSL:\n%s", got)
	}
}

type stoppedProcess struct{}

func (stoppedProcess) Output() io.Reader { return strings.NewReader("berthd: listening\n") }
func (stoppedProcess) Wait() error       { return errors.New("exit status 1") }

func TestWSLBerthdIsStartedAgainUntilStopped(t *testing.T) {
	a := wslTestAgent(t)
	var runs atomic.Int32
	var last atomic.Value
	old, oldAfter := wslServe, wslRestartAfter
	wslServe = func(_ context.Context, prog, home, listen string) (wslProcess, error) {
		runs.Add(1)
		last.Store(prog + " " + home + " " + listen)
		return stoppedProcess{}, nil
	}
	wslRestartAfter = 10 * time.Millisecond
	t.Cleanup(func() { wslServe, wslRestartAfter = old, oldAfter })

	a.keepWSLBerthd("/h/.berth/bin/berthd", "/h/.berth", "127.0.0.1:7445")
	a.keepWSLBerthd("/h/.berth/bin/berthd", "/h/.berth", "127.0.0.1:7445") // the same: no second one
	deadline := time.Now().Add(5 * time.Second)
	for runs.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if runs.Load() < 3 {
		t.Fatalf("berthd was started %d times, not again after it stopped", runs.Load())
	}
	if !a.wslRunning() {
		t.Fatal("not running")
	}
	a.stopWSLBerthd()
	if a.wslRunning() {
		t.Fatal("still running after stop")
	}
	n := runs.Load()
	time.Sleep(50 * time.Millisecond)
	if runs.Load() != n {
		t.Fatal("started again after stop")
	}
	if got := last.Load(); got != "/h/.berth/bin/berthd /h/.berth 127.0.0.1:7445" {
		t.Fatalf("ran %v", got)
	}
}
