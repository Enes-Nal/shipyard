//go:build !windows

package desk

import (
	"os"
	"os/exec"
	"syscall"
)

// hide puts a child in its own process group, so killTree can end it and
// what it started together.
func hide(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// killTree ends p and everything it started.
func killTree(p *os.Process) {
	if p == nil {
		return
	}
	if syscall.Kill(-p.Pid, syscall.SIGKILL) != nil {
		_ = p.Kill()
	}
}
