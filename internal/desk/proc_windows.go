package desk

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

// hide keeps a child from opening a console window of its own.
func hide(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000 /* CREATE_NO_WINDOW */, HideWindow: true}
}

// killTree ends p and everything it started: an agent's own tool calls
// (a test run, a dev server) would outlive it otherwise.
func killTree(p *os.Process) {
	if p == nil {
		return
	}
	kill := exec.Command("taskkill", "/PID", strconv.Itoa(p.Pid), "/T", "/F")
	hide(kill)
	if kill.Run() != nil {
		_ = p.Kill()
	}
}
