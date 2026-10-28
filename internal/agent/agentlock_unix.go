//go:build !windows

package agent

import (
	"os"
	"syscall"
)

func tryAgentLock(f *os.File) (func(), bool) {
	if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return nil, false
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }, true
}
