package service

import (
	"os/exec"
	"syscall"
)

func isolateCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200, HideWindow: true}
}
