//go:build !windows

package agentpath

import (
	"os"
	"os/exec"
	"syscall"
)

func isolateCommand(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

func killCommandTree(process *os.Process) error { return syscall.Kill(-process.Pid, syscall.SIGKILL) }
