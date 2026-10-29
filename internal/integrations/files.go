package integrations

import (
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"

	"github.com/cosscom/shipyard/internal/statefile"
)

// files reads and writes an agent's settings below root.
//
// The agent's own folder in the user's home (~/.claude, ~/.codex, and the
// home itself for ~/.claude.json) is the user's, and a link they made
// there is followed, as it always was. Any other account folder (one
// under ~/.berth/accounts, or one a project's config names) is strict:
// nothing below it is read or written through a symbolic link, the way
// project skills are (nofollow.go), so a folder a repository controls
// cannot steer a write to ~/.ssh.
type files struct {
	root   string
	strict bool
}

// fileAt is the non-strict files for the file at p, for the install
// functions that take a path.
func fileAt(p string) (files, string) {
	return files{root: filepath.Dir(p)}, filepath.Base(p)
}

func (f files) path(rel string) string { return filepath.Join(f.root, rel) }

// read returns rel's contents; an error satisfying os.IsNotExist when it
// is not there.
func (f files) read(rel string) ([]byte, error) {
	if !f.strict {
		return os.ReadFile(f.path(rel))
	}
	if err := noLinks(f.root, rel); err != nil {
		return nil, err
	}
	r, err := os.OpenRoot(f.root)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	file, err := r.OpenFile(path.Clean(filepath.ToSlash(rel)), os.O_RDONLY|openNoFollow, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(file)
}

// write replaces rel with data. A file that is there keeps its mode; a new
// one gets mode.
func (f files) write(rel string, data []byte, mode fs.FileMode) error {
	if f.strict {
		// Truncated in place, so the file keeps its mode.
		return writeNoFollow(f.root, rel, data, mode)
	}
	p := f.path(rel)
	if info, err := os.Stat(p); err == nil {
		mode = info.Mode().Perm()
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if err := statefile.Write(p, data); err != nil {
		return err
	}
	return os.Chmod(p, mode)
}

// backup keeps rel's previous contents at rel+".berth-backup".
func (f files) backup(rel string, before []byte) error {
	if f.strict {
		return writeNoFollow(f.root, rel+".berth-backup", before, 0o600)
	}
	if err := os.MkdirAll(filepath.Dir(f.path(rel)), 0o755); err != nil {
		return err
	}
	return os.WriteFile(f.path(rel)+".berth-backup", before, 0o600)
}
