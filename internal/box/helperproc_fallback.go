//go:build !linux && !darwin && !windows

package box

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

func helperPlatformOK() bool                           { return false }
func helperSysProcAttr() *syscall.SysProcAttr          { return nil }
func terminateHelper(int, <-chan error, time.Duration) {}
func signalProcess(int, syscall.Signal)                {}
func processAlive(int) bool                            { return false }
func currentUID() int                                  { return 0 }
func ownedByUID(os.FileInfo, int) bool                 { return true }
func configureProcessGroup(*exec.Cmd)                  {}
func killProcessGroup(process *os.Process) error       { return process.Kill() }
func detachProcess(*exec.Cmd)                          {}
func signalProcessGroup(int, syscall.Signal)           {}
func freezeProcessTree([]int, bool)                    {}
