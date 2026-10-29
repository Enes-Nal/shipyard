package agentpath

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

func isolateCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200, HideWindow: true}
}

func killCommandTree(process *os.Process) error {
	if err := exec.Command("taskkill", "/PID", strconv.Itoa(process.Pid), "/T", "/F").Run(); err == nil {
		return nil
	}
	return process.Kill()
}
