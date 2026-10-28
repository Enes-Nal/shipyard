//go:build !windows

package box

import (
	"os"
	"syscall"
)

func platformDisks() []Disk {
	var out []Disk
	seen := map[uint64]bool{}
	home, _ := os.UserHomeDir()
	for _, mount := range []string{"/", home} {
		var st syscall.Statfs_t
		if mount == "" || syscall.Statfs(mount, &st) != nil {
			continue
		}
		id := uint64(st.Blocks)<<16 ^ uint64(st.Bsize)
		if seen[id] {
			continue
		}
		seen[id] = true
		bs := uint64(st.Bsize)
		total := uint64(st.Blocks) * bs
		out = append(out, Disk{Mount: mount, Usage: Usage{Total: total, Used: total - uint64(st.Bavail)*bs}})
	}
	return out
}
