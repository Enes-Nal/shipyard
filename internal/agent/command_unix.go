//go:build !windows

package agent

import "os/exec"

func hideBackgroundCommand(*exec.Cmd) {}
