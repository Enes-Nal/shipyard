package agent

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Use this PC: on Windows, this computer's box is a berthd inside WSL2.
// berthd needs tmux and a Unix shell, which Windows has only there. The
// app carries a Linux berthd (berthd-linux beside berth.exe); setting up
// copies it into the default WSL distro at ~/.berth/bin/berthd and pairs
// with it over loopback, which WSL2 forwards to Windows.
//
// WSL has no launchd, and its systemd (when enabled at all) stops with the
// distro, which WSL shuts down once nothing from Windows is attached. So
// the agent runs berthd itself (`berthd serve`, through wsl.exe) and starts
// it again when it stops: the attached wsl.exe is also what keeps the
// distro, and the agents' tmux server in it, running. The agent already
// runs in the background from login, which is when the box is wanted.

// These are replaced in tests.
var (
	// wslRun runs a command in the default WSL distro and returns its
	// standard output.
	wslRun = func(ctx context.Context, args ...string) ([]byte, error) {
		return wslCommand(ctx, args...).Output()
	}
	// wslServe starts one run of berthd serve in WSL.
	wslServe = func(ctx context.Context, prog, home, listen string) (wslProcess, error) {
		cmd := wslCommand(ctx, "env", "BERTH_HOME="+home, prog, "serve", "--listen", listen)
		out, err := cmd.StdoutPipe()
		if err != nil {
			return nil, err
		}
		cmd.Stderr = cmd.Stdout
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		return &execProcess{cmd: cmd, out: out}, nil
	}
	// wslDialable is whether a berthd answers at addr. WSL2 relays a
	// loopback listener in the distro to the same port on Windows.
	wslDialable = func(addr string) bool {
		c, err := net.DialTimeout("tcp", addr, time.Second)
		if err != nil {
			return false
		}
		c.Close()
		return true
	}
	wslRestartAfter = 3 * time.Second
)

const wslInstallHint = "WSL isn't installed. In PowerShell as administrator run: wsl --install -d Ubuntu, restart Windows, then run bash scripts/setup-wsl.sh inside Ubuntu"

func wslCommand(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "wsl.exe", append([]string{"--exec"}, args...)...)
	hideBackgroundCommand(cmd)
	return cmd
}

type wslProcess interface {
	Output() io.Reader
	Wait() error
}

type execProcess struct {
	cmd *exec.Cmd
	out io.Reader
}

func (p *execProcess) Output() io.Reader { return p.out }
func (p *execProcess) Wait() error       { return p.cmd.Wait() }

// wslSh runs a POSIX shell script in WSL with args as $1, $2, …
func wslSh(ctx context.Context, script string, args ...string) (string, error) {
	out, err := wslRun(ctx, append([]string{"sh", "-c", script, "sh"}, args...)...)
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return "", errors.New(strings.TrimSpace(string(ee.Stderr)))
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// wslHome is the box's BERTH_HOME in WSL: ~/.berth, as on any Linux box.
func wslHome(ctx context.Context) (string, error) {
	home, err := wslSh(ctx, `printf %s "$HOME"`)
	if err != nil || !strings.HasPrefix(home, "/") {
		return "", errors.New(wslInstallHint)
	}
	return strings.TrimRight(home, "/") + "/.berth", nil
}

// wslPath is where WSL sees a Windows path: C:\x is /mnt/c/x.
func wslPath(ctx context.Context, windows string) (string, error) {
	out, err := wslRun(ctx, "wslpath", "-a", "-u", windows)
	if err != nil {
		return "", fmt.Errorf("finding %s from WSL: %w", windows, err)
	}
	return strings.TrimSpace(string(out)), nil
}

// wslSupervisor keeps one berthd serve running in WSL.
type wslSupervisor struct {
	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
	key    string
}

// keepWSLBerthd runs berthd until stopWSLBerthd, starting it again when it
// stops. Asked again with the same program and address it does nothing;
// with others, it restarts berthd with them.
func (a *Agent) keepWSLBerthd(prog, home, listen string) {
	s := &a.local.wsl
	key := prog + "|" + home + "|" + listen
	s.mu.Lock()
	if s.cancel != nil && s.key == key {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	a.stopWSLBerthd()
	parent := a.ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	s.mu.Lock()
	s.cancel, s.done, s.key = cancel, done, key
	s.mu.Unlock()
	go func() {
		defer close(done)
		for {
			p, err := wslServe(ctx, prog, home, listen)
			if err == nil {
				sc := bufio.NewScanner(p.Output())
				for sc.Scan() {
					a.cfg.Log.Printf("this computer's box (WSL): %s", strings.TrimRight(sc.Text(), "\r"))
				}
				err = p.Wait()
			}
			if ctx.Err() != nil {
				return
			}
			a.cfg.Log.Printf("this computer's box (WSL): berthd stopped (%v); starting it again", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(wslRestartAfter):
			}
		}
	}()
}

func (a *Agent) stopWSLBerthd() {
	s := &a.local.wsl
	s.mu.Lock()
	cancel, done := s.cancel, s.done
	s.cancel, s.done, s.key = nil, nil, ""
	s.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

func (a *Agent) wslRunning() bool {
	s := &a.local.wsl
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cancel != nil
}

func (a *Agent) wslBoxStatus() LocalBoxStatus {
	st := LocalBoxStatus{Name: localName()}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := wslHome(ctx); err != nil {
		st.Reason = err.Error()
	} else {
		st.Supported = true
	}
	if _, err := a.bundledBerthd(); err != nil {
		if st.Reason == "" {
			st.Reason = err.Error()
		}
	} else {
		st.Available = st.Supported
	}
	if r := a.localRecord(); r != nil && r.WSL {
		st.Installed, st.Owned = true, true
		st.Program, st.Listen = r.Program, r.Listen
		st.Running = a.wslRunning() && wslDialable(r.Listen)
		if peer, ok := a.localPeer(r); ok {
			st.Box = peer
		}
	}
	return st
}

// setUpWSLBox is setUpLocalBox for Windows.
func (a *Agent) setUpWSLBox(ctx context.Context, say sayFunc) (string, error) {
	src, err := a.bundledBerthd()
	if err != nil {
		return "", err
	}
	say("Checking WSL…")
	home, err := wslHome(ctx)
	if err != nil {
		return "", err
	}
	if _, err := wslSh(ctx, "command -v tmux"); err != nil {
		return "", errors.New("tmux isn't installed in WSL. Run bash scripts/setup-wsl.sh inside Ubuntu (or: sudo apt install -y tmux git), then try again")
	}
	prog := home + "/bin/berthd"
	updated, err := a.copyWSLBerthd(ctx, src, prog, say)
	if err != nil {
		return "", err
	}
	listen := ""
	if r := a.localRecord(); r != nil && r.WSL && r.Listen != "" {
		listen = r.Listen
	}
	if listen == "" {
		if listen, err = freeLoopbackPort(a.localPort()); err != nil {
			return "", err
		}
	}
	if updated {
		a.stopWSLBerthd()
	}
	say("Starting berthd in WSL, listening on %s: this computer only…", listen)
	a.keepWSLBerthd(prog, home, listen)
	if err := waitDialable(ctx, listen, 30*time.Second); err != nil {
		return "", fmt.Errorf("berthd didn't start in WSL; agent.log has what it said: %w", err)
	}
	name, err := a.pairLocalAt(ctx, prog, home, listen, true, true, say)
	if err != nil {
		return "", err
	}
	a.sync()
	a.checkAll(ctx)
	return name, nil
}

// copyWSLBerthd puts the bundled berthd at prog in WSL when it is missing
// or another build, and says whether it changed anything.
func (a *Agent) copyWSLBerthd(ctx context.Context, src, prog string, say sayFunc) (bool, error) {
	from, err := wslPath(ctx, src)
	if err != nil {
		return false, err
	}
	if _, err := wslSh(ctx, `cmp -s "$1" "$2"`, from, prog); err == nil {
		return false, nil
	}
	say("Copying berthd to %s in WSL…", prog)
	_, err = wslSh(ctx, `mkdir -p "$(dirname "$2")" && cp "$1" "$2.new" && chmod 755 "$2.new" && mv -f "$2.new" "$2"`, from, prog)
	if err != nil {
		return false, fmt.Errorf("copying berthd into WSL: %w", err)
	}
	return true, nil
}

func waitDialable(ctx context.Context, addr string, within time.Duration) error {
	deadline := time.Now().Add(within)
	for {
		if wslDialable(addr) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("nothing answers on %s", addr)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// removeWSLBox is removeLocalBox for Windows.
func (a *Agent) removeWSLBox(ctx context.Context, rec *localBoxRecord, removeData bool, say sayFunc) error {
	if err := a.forgetLocalPeer(ctx, rec, say); err != nil {
		return err
	}
	say("Stopping berthd in WSL…")
	a.stopWSLBerthd()
	if _, err := wslSh(ctx, `rm -f "$1"`, rec.Program); err == nil {
		say("Removed %s from WSL.", rec.Program)
	}
	dir := rec.Home + "/box"
	if removeData {
		say("Deleting %s in WSL…", dir)
		if _, err := wslSh(ctx, `rm -rf "$1"`, dir); err != nil {
			return err
		}
	} else {
		say("Kept its data in %s in WSL; setting this computer up again uses it.", dir)
	}
	return a.saveLocalRecord(nil)
}

// refreshWSLBox keeps berthd running in WSL once this computer is set up,
// and current with the berthd the app carries.
func (a *Agent) refreshWSLBox(ctx context.Context, rec *localBoxRecord) {
	src, err := a.bundledBerthd()
	if err != nil {
		return
	}
	say := func(format string, args ...any) { a.cfg.Log.Printf("this computer's box (WSL): "+format, args...) }
	updated, err := a.copyWSLBerthd(ctx, src, rec.Program, say)
	if err != nil {
		say("%v", err)
	}
	if updated {
		a.stopWSLBerthd()
	}
	a.keepWSLBerthd(rec.Program, rec.Home, rec.Listen)
	a.checkSoon()
}
