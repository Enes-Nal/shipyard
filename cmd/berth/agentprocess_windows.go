package main

import (
	"os/exec"
	"syscall"
)

func detachAgentCommand(cmd *exec.Cmd) {
	// DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP lets the agent outlive the
	// short `berth agent start` process without opening a console window.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200, HideWindow: true}
}
