package agent

import (
	"os"

	"golang.org/x/sys/windows"
)

func tryAgentLock(f *os.File) (func(), bool) {
	var overlapped windows.Overlapped
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY)
	if windows.LockFileEx(windows.Handle(f.Fd()), flags, 0, 1, 0, &overlapped) != nil {
		return nil, false
	}
	return func() {
		_ = windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlapped)
	}, true
}
