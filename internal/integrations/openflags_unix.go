//go:build !windows

package integrations

import "syscall"

const openNoFollow = syscall.O_NOFOLLOW
