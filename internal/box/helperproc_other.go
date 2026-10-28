//go:build windows

package box

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// Helpers run on Linux and macOS boxes.
func helperPlatformOK() bool { return false }

func helperSysProcAttr() *syscall.SysProcAttr { return nil }

func terminateHelper(pid int, exited <-chan error, timeout time.Duration) {}

func signalProcess(pid int, sig syscall.Signal) {
	if p, err := os.FindProcess(pid); err == nil {
		_ = p.Signal(sig)
	}
}

func processAlive(pid int) bool { return false }

func currentUID() int { return 0 }

func ownedByUID(os.FileInfo, int) bool { return true }

func configureProcessGroup(*exec.Cmd) {}

func killProcessGroup(process *os.Process) error { return process.Kill() }

func detachProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200, HideWindow: true}
}

func signalProcessGroup(pid int, sig syscall.Signal) { signalProcess(pid, sig) }

func freezeProcessTree([]int, bool) {}
