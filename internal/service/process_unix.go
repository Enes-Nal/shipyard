//go:build !windows

package service

import (
	"os/exec"
	"syscall"
)

func isolateCommand(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
