package agenthost

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"

	"golang.org/x/sys/windows"
)

func descendants(_ int) []int { return nil }

func isolateCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200, HideWindow: true}
}

func terminateTree(pid int) {
	if process, err := os.FindProcess(pid); err == nil {
		_ = process.Kill()
	}
}

func killTree(pid int) {
	if exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run() != nil {
		terminateTree(pid)
	}
}

func processAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return err == windows.ERROR_ACCESS_DENIED
	}
	_ = windows.CloseHandle(handle)
	return true
}
