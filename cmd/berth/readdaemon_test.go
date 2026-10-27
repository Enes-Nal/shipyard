package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// berth on the PATH is often a link to the copy inside Terminal.app
// (Settings → General → Command line); the daemons are in the app's
// Contents/Resources, beside the file the link points at.
func TestReadDaemonThroughALink(t *testing.T) {
	dir := t.TempDir()
	contents := filepath.Join(dir, "Berth.app", "Contents")
	for _, d := range []string{"MacOS", "Resources"} {
		if err := os.MkdirAll(filepath.Join(contents, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cli := filepath.Join(contents, "MacOS", "berth-cli")
	if err := os.WriteFile(cli, []byte("cli"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(contents, "Resources", "berthd-linux-amd64"), []byte("daemon"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "bin", "berth")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(cli, link); err != nil {
		t.Fatal(err)
	}
	b, err := readDaemon(link, "berthd-linux-amd64")
	if err != nil || string(b) != "daemon" {
		t.Fatalf("readDaemon through a link = %q, %v", b, err)
	}
}

// On a Mac, a Mac box is served by the universal berthd Terminal.app carries
// for Use this Mac, or the one make build put beside berth.
func TestReadDaemonFindsTheMacBerthd(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("the universal berthd is looked for on a Mac")
	}
	dir := t.TempDir()
	cli := filepath.Join(dir, "MacOS", "berth-cli")
	resources := filepath.Join(dir, "Resources")
	for _, d := range []string{filepath.Dir(cli), resources} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(cli, []byte("cli"), 0o755)
	fat := []byte{0xca, 0xfe, 0xba, 0xbe, 1}
	os.WriteFile(filepath.Join(resources, "berthd"), fat, 0o755)
	other := map[string]string{"arm64": "amd64", "amd64": "arm64"}[runtime.GOARCH]
	for _, arch := range []string{runtime.GOARCH, other} {
		if b, err := readDaemon(cli, "berthd-darwin-"+arch); err != nil || string(b) != string(fat) {
			t.Fatalf("berthd-darwin-%s = %q, %v", arch, b, err)
		}
	}
	// One that runs only here serves only this Mac's architecture.
	os.WriteFile(filepath.Join(resources, "berthd"), []byte("thin"), 0o755)
	if _, err := readDaemon(cli, "berthd-darwin-"+other); err == nil {
		t.Fatal("a single-architecture berthd was offered for the other architecture")
	}
	if _, err := readDaemon(cli, "berthd-linux-amd64"); err == nil {
		t.Fatal("the Mac berthd was offered for Linux")
	}
}
