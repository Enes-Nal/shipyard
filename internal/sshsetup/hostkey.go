package sshsetup

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Runner runs a command and returns its combined output; tests replace it.
type Runner func(ctx context.Context, env []string, name string, args ...string) ([]byte, error)

// Exec runs commands for real.
func Exec(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = env
	return cmd.CombinedOutput()
}

// HostKey is the host key a box presents, as ssh recorded it.
type HostKey struct {
	// Fingerprints are "SHA256:…", one per line of Lines.
	Fingerprints []string
	// Lines are known_hosts lines, written by ssh for this host and port, so
	// they match however ssh looks the host up.
	Lines []string
}

// FetchHostKey asks the box for its host key without logging in: ssh
// records it into a scratch known_hosts (accept-new), then gives up before
// authenticating. It goes the same way as the real connection (sshArgs
// carry any ProxyCommand), so it works where ssh-keyscan cannot reach.
func FetchHostKey(ctx context.Context, run Runner, env, sshArgs []string, target string) (HostKey, error) {
	dir, err := os.MkdirTemp("", "berth-hostkey")
	if err != nil {
		return HostKey{}, err
	}
	defer os.RemoveAll(dir)
	scratch := filepath.Join(dir, "known_hosts")
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	args := append([]string{
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "UserKnownHostsFile=" + scratch,
		"-o", "GlobalKnownHostsFile=/dev/null",
		"-o", "UpdateHostKeys=no",
		"-o", "BatchMode=yes",
		"-o", "PubkeyAuthentication=no",
		"-o", "PasswordAuthentication=no",
		"-o", "KbdInteractiveAuthentication=no",
		"-o", "GSSAPIAuthentication=no",
		"-o", "ControlMaster=no",
		"-o", "ControlPath=none",
		"-o", "ConnectTimeout=20",
	}, sshArgs...)
	args = append(args, target, "true")
	// It is meant to fail at authentication; only the recorded key matters.
	out, _ := run(ctx, env, "ssh", args...)
	data, err := os.ReadFile(scratch)
	if err != nil || len(bytes.TrimSpace(data)) == 0 {
		return HostKey{}, fmt.Errorf("could not read %s's host key: %s", target, lastSSHLine(string(out)))
	}
	var hk HostKey
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fp, err := fingerprintLine(ctx, run, dir, line)
		if err != nil {
			return HostKey{}, err
		}
		hk.Lines = append(hk.Lines, line)
		hk.Fingerprints = append(hk.Fingerprints, fp)
	}
	if len(hk.Lines) == 0 {
		return HostKey{}, fmt.Errorf("could not read %s's host key", target)
	}
	return hk, nil
}

// fingerprintLine is ssh-keygen's SHA256 fingerprint of one known_hosts line.
func fingerprintLine(ctx context.Context, run Runner, dir, line string) (string, error) {
	path := filepath.Join(dir, "line")
	if err := os.WriteFile(path, []byte(line+"\n"), 0o600); err != nil {
		return "", err
	}
	out, err := run(ctx, os.Environ(), "ssh-keygen", "-l", "-E", "sha256", "-f", path)
	if err != nil {
		return "", fmt.Errorf("ssh-keygen: %v: %s", err, strings.TrimSpace(string(out)))
	}
	fp := fingerprintRe.FindString(string(out))
	if fp == "" {
		return "", errors.New("ssh-keygen printed no fingerprint")
	}
	return fp, nil
}

// TrustHostKey adds the box's host key to known_hosts, but only the key
// whose fingerprint the person approved, and only if the box still presents
// it. A host with a known key that differs is never touched: that is
// host-key-changed, and needs a person at a terminal.
func TrustHostKey(hk HostKey, want, knownHosts string) error {
	want = strings.TrimSpace(want)
	if !strings.HasPrefix(want, "SHA256:") {
		return fmt.Errorf("%q is not a SHA256 host key fingerprint", want)
	}
	var line string
	for i, fp := range hk.Fingerprints {
		if fp == want {
			line = hk.Lines[i]
		}
	}
	if line == "" {
		return fmt.Errorf("the box now presents a different host key (%s) from the one you approved (%s), so Terminal did not trust it", strings.Join(hk.Fingerprints, ", "), want)
	}
	if err := os.MkdirAll(filepath.Dir(knownHosts), 0o700); err != nil {
		return err
	}
	if existing, err := os.ReadFile(knownHosts); err == nil {
		sc := bufio.NewScanner(bytes.NewReader(existing))
		for sc.Scan() {
			if strings.TrimSpace(sc.Text()) == line {
				return nil
			}
		}
		if len(existing) > 0 && !bytes.HasSuffix(existing, []byte("\n")) {
			line = "\n" + line
		}
	}
	f, err := os.OpenFile(knownHosts, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(line + "\n"); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// KnownHostsFile is the known_hosts ssh writes to for a host (ssh -G's first
// UserKnownHostsFile), with ~ expanded.
func (f Finder) KnownHostsFile(c Config) string {
	if len(c.KnownHosts) > 0 && c.KnownHosts[0] != "none" {
		return f.expand(c.KnownHosts[0])
	}
	return filepath.Join(f.Home, ".ssh", "known_hosts")
}

// PickFingerprint is the fingerprint to show for an unknown host: the key of
// the type ssh asked about, when it said, else the first.
func (hk HostKey) PickFingerprint(keyType string) string {
	keyType = strings.ToLower(keyType)
	for i, line := range hk.Lines {
		if keyType != "" && strings.Contains(strings.ToLower(line), keyType) {
			return hk.Fingerprints[i]
		}
	}
	if len(hk.Fingerprints) > 0 {
		return hk.Fingerprints[0]
	}
	return ""
}
