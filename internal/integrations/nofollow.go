package integrations

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// writeNoFollow writes data to rel, a path below root, making the folders it
// needs. It refuses to pass through or replace a symbolic link anywhere below
// root, and opens everything through an os.Root so nothing escapes root even
// if a folder is swapped for a link part way through.
func writeNoFollow(root, rel string, data []byte, perm fs.FileMode) error {
	parts, err := splitRel(rel)
	if err != nil {
		return err
	}
	r, err := os.OpenRoot(root)
	if err != nil {
		return err
	}
	defer r.Close()
	cur := ""
	for _, p := range parts[:len(parts)-1] {
		cur = path.Join(cur, p)
		fi, err := r.Lstat(cur)
		if errors.Is(err, fs.ErrNotExist) {
			if err := r.Mkdir(cur, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if err := plainDir(root, cur, fi); err != nil {
			return err
		}
	}
	name := path.Join(parts...)
	if fi, err := r.Lstat(name); err == nil && !fi.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file; refusing to write through it", filepath.Join(root, name))
	}
	f, err := r.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|openNoFollow, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// noLinks reports an error if any existing part of rel below root is a
// symbolic link.
func noLinks(root, rel string) error {
	parts, err := splitRel(rel)
	if err != nil {
		return err
	}
	cur := ""
	for i, p := range parts {
		cur = path.Join(cur, p)
		fi, err := os.Lstat(filepath.Join(root, cur))
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if i < len(parts)-1 {
			if err := plainDir(root, cur, fi); err != nil {
				return err
			}
		} else if fi.Mode()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%s is a symbolic link; refusing to follow it", filepath.Join(root, cur))
		}
	}
	return nil
}

func plainDir(root, rel string, fi fs.FileInfo) error {
	if fi.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symbolic link; refusing to follow it", filepath.Join(root, rel))
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a folder", filepath.Join(root, rel))
	}
	return nil
}

func splitRel(rel string) ([]string, error) {
	rel = filepath.ToSlash(filepath.Clean(rel))
	if rel == "." || path.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, "../") {
		return nil, fmt.Errorf("%s is not below the folder", rel)
	}
	return strings.Split(rel, "/"), nil
}
