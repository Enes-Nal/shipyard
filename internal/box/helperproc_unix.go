//go:build linux || darwin

package box

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// helperPlatformOK says this box can run helpers.
func helperPlatformOK() bool { return true }

// helperSysProcAttr starts a helper in a process group of its own, so that
// stopping it stops what it started too, and a Ctrl-C meant for berthd in a
// terminal does not reach it first.
func helperSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// terminateHelper asks a helper and its process group to stop, and kills
// them if they have not within timeout. exited yields when the helper's own
// process has ended.
func terminateHelper(pid int, exited <-chan error, timeout time.Duration) {
	syscall.Kill(-pid, syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(timeout):
		syscall.Kill(-pid, syscall.SIGKILL)
		<-exited
		return
	}
	// What it started and did not take with it.
	syscall.Kill(-pid, syscall.SIGKILL)
}

func signalProcess(pid int, sig syscall.Signal) { syscall.Kill(pid, sig) }

// processAlive reports whether a process is still there.
func processAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func currentUID() int { return os.Getuid() }

func ownedByUID(info os.FileInfo, uid int) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	return !ok || int(st.Uid) == uid
}

func configureProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessGroup(process *os.Process) error {
	return syscall.Kill(-process.Pid, syscall.SIGKILL)
}

func detachProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func signalProcessGroup(pid int, sig syscall.Signal) { _ = syscall.Kill(-pid, sig) }

func freezeProcessTree(tree []int, freeze bool) {
	if !freeze {
		for _, pid := range tree {
			_ = syscall.Kill(pid, syscall.SIGCONT)
		}
		return
	}
	for i := len(tree) - 1; i > 0; i-- {
		_ = syscall.Kill(tree[i], syscall.SIGSTOP)
	}
	if len(tree) > 0 {
		_ = syscall.Kill(tree[0], syscall.SIGTTIN)
	}
}
