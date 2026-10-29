package agent

import (
	"os/exec"
	"syscall"
)

func hideBackgroundCommand(cmd *exec.Cmd) {
	// The agent is a background process. Without CREATE_NO_WINDOW, every
	// short-lived berth command it runs is handed to the user's default
	// terminal app and flashes a new window.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000, HideWindow: true}
}
