package box

// The box daemon is not available on Windows; keep the shared laptop-agent
// build free of Unix filesystem syscalls.
func platformDisks() []Disk { return nil }
