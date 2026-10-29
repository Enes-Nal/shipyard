package sshsetup

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Real OpenSSH stderr, as ssh -v prints it for each failure.
const (
	refused = `debug1: Connecting to dev-box.example [203.0.113.7] port 22.
debug1: connect to address 203.0.113.7 port 22: Connection refused
ssh: connect to host dev-box.example port 22: Connection refused
`
	timedOut = `ssh: connect to host 203.0.113.9 port 22: Operation timed out
`
	timedOutLinux = `ssh: connect to host 203.0.113.9 port 22: Connection timed out
`
	noRoute = `ssh: connect to host 10.9.9.9 port 22: No route to host
`
	unresolved = `ssh: Could not resolve hostname nohost.example: nodename nor servname provided, or not known
`
	unresolvedLinux = `ssh: Could not resolve hostname nohost.example: Name or service not known
`
	denied = `debug1: connect to address ::1 port 22: Connection refused
debug1: Connection established.
debug1: Authentications that can continue: publickey
debug1: Next authentication method: publickey
debug1: Will attempt key: me@laptop ED25519 SHA256:q2lQb3ZhbmRvbWtleWZvcnRlc3RzMTIzNDU2Nzg5MA agent
debug1: Will attempt key: /Users/me/.ssh/id_ed25519 ED25519 SHA256:aW52ZW50ZWRrZXlmb3J0ZXN0aW5ndGhpczEyMzQ1
debug1: Offering public key: me@laptop ED25519 SHA256:q2lQb3ZhbmRvbWtleWZvcnRlc3RzMTIzNDU2Nzg5MA agent
debug1: Authentications that can continue: publickey
debug1: Offering public key: /Users/me/.ssh/id_ed25519 ED25519 SHA256:aW52ZW50ZWRrZXlmb3J0ZXN0aW5ndGhpczEyMzQ1
debug1: Authentications that can continue: publickey
debug1: No more authentication methods to try.
me@dev-box.example: Permission denied (publickey).
`
	deniedNoKeys = `me@dev-box.example: Permission denied (publickey,password).
`
	passwordOnly = `me@dev-box.example: Permission denied (password,keyboard-interactive).
`
	unknownKey = `No ED25519 host key is known for dev-box.example and you have requested strict checking.
Host key verification failed.
`
	changedKey = `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
Someone could be eavesdropping on you right now (man-in-the-middle attack)!
It is also possible that a host key has just been changed.
The fingerprint for the ED25519 key sent by the remote host is
SHA256:bmV3a2V5Zm9ydGVzdGluZ3RoaXNpc25vdHJlYWwxMjM.
Please contact your system administrator.
Add correct host key in /Users/me/.ssh/known_hosts to get rid of this message.
Offending ED25519 key in /Users/me/.ssh/known_hosts:12
Host key for dev-box.example has changed and you have requested strict checking.
Host key verification failed.
`
)

func TestClassify(t *testing.T) {
	for _, tc := range []struct {
		stderr, kind, says string
	}{
		{refused, "refused", "Nothing is accepting SSH on dev-box.example (port 22)"},
		{timedOut, "timeout", "timed out"},
		{timedOutLinux, "timeout", "timed out"},
		{noRoute, "unreachable", "no route"},
		{unresolved, "resolve", "Could not resolve dev-box.example"},
		{unresolvedLinux, "resolve", "Could not resolve"},
		{denied, "auth", "Terminal offered me@laptop (1Password's SSH agent), /Users/me/.ssh/id_ed25519"},
		{deniedNoKeys, "auth", "the keys in 1Password's SSH agent, ~/.ssh/id_ed25519"},
		{passwordOnly, "password", "only accepts passwords"},
		{unknownKey, "host-key-unknown", "hasn't connected to dev-box.example before"},
		{changedKey, "host-key-changed", "ssh-keygen -R dev-box.example"},
		{"kex_exchange_identification: read: Connection reset by peer\n", "other", "Connection reset by peer"},
	} {
		f := Classify(tc.stderr, "dev-box.example", "22", &Agent{Name: "1Password"}, []string{"~/.ssh/id_ed25519"})
		if f.Kind != tc.kind || !strings.Contains(f.Message, tc.says) {
			t.Errorf("%q:\n got %s: %s\nwant %s containing %q", firstLine(tc.stderr), f.Kind, f.Message, tc.kind, tc.says)
		}
		if strings.Contains(f.Message, "debug1") || strings.Contains(f.Message, "exit status") {
			t.Errorf("%s: the message carries ssh's raw output: %s", tc.kind, f.Message)
		}
	}
	if f := Classify(changedKey, "dev-box.example", "22", nil, nil); f.Fingerprint != "SHA256:bmV3a2V5Zm9ydGVzdGluZ3RoaXNpc25vdHJlYWwxMjM" {
		t.Errorf("changed key fingerprint = %q", f.Fingerprint)
	}
	if f := Classify(refused, "dev-box.example", "2222", nil, nil); !strings.Contains(f.Message, "(port 2222)") {
		t.Errorf("a custom port is not named: %s", f.Message)
	}
	if UnknownKeyType(unknownKey) != "ED25519" {
		t.Errorf("UnknownKeyType = %q", UnknownKeyType(unknownKey))
	}
	if f := Classify(deniedNoKeys, "h", "22", nil, nil); !strings.Contains(f.Message, "no keys at all") {
		t.Errorf("nothing offered: %s", f.Message)
	}
}

func firstLine(s string) string { return strings.SplitN(s, "\n", 2)[0] }

func TestParseG(t *testing.T) {
	c := ParseG([]byte(`user me
hostname 100.64.0.12
port 2222
identityagent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
identityfile ~/.ssh/id_rsa
identityfile ~/.ssh/id_ed25519
proxyjump bastion
stricthostkeychecking ask
userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2
`))
	if c.User != "me" || c.HostName != "100.64.0.12" || c.Port != "2222" || c.ProxyJump != "bastion" || c.StrictHostKeyChecking != "ask" {
		t.Errorf("config = %+v", c)
	}
	if c.IdentityAgent != `"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"` || len(c.IdentityFiles) != 2 || len(c.KnownHosts) != 2 {
		t.Errorf("config = %+v", c)
	}
}

// listen makes a socket an agent could answer on. Unix socket paths are
// short on macOS, so these live under /tmp with home linked to them.
func listen(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
}

func shortHome(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "bh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func finder(home, goos string, env map[string]string, launchd string) Finder {
	return Finder{Home: home, GOOS: goos, Getenv: func(k string) string { return env[k] }, Launchd: func() string { return launchd }, Alive: Alive}
}

func TestFindPrefersConfigThenEnvironmentThenLaunchdThenKeyManagers(t *testing.T) {
	home := shortHome(t)
	bitwarden := filepath.Join(home, ".bitwarden-ssh-agent.sock")
	shell := filepath.Join(home, "shell.sock")
	system := filepath.Join(home, "launchd.sock")
	listen(t, bitwarden)
	listen(t, shell)
	listen(t, system)

	// ~/.ssh/config's IdentityAgent wins; ssh finds it itself.
	a, inject, missing := finder(home, "darwin", map[string]string{"SSH_AUTH_SOCK": shell}, system).Find("~/.bitwarden-ssh-agent.sock")
	if a == nil || a.Source != "ssh-config" || a.Name != "Bitwarden" || inject || missing != "" {
		t.Errorf("config: %+v %v %q", a, inject, missing)
	}
	// One that names a dead agent is reported, not swapped for another.
	a, _, missing = finder(home, "darwin", map[string]string{"SSH_AUTH_SOCK": shell}, system).Find(filepath.Join(home, "gone.sock"))
	if a != nil || missing != filepath.Join(home, "gone.sock") {
		t.Errorf("dead config agent: %+v %q", a, missing)
	}
	// IdentityAgent none means none.
	if a, _, _ := finder(home, "darwin", map[string]string{"SSH_AUTH_SOCK": shell}, system).Find("none"); a != nil {
		t.Errorf("none: %+v", a)
	}
	// The process's own SSH_AUTH_SOCK next, which ssh also finds itself.
	a, inject, _ = finder(home, "darwin", map[string]string{"SSH_AUTH_SOCK": shell}, system).Find("")
	if a == nil || a.Socket != shell || a.Source != "environment" || inject || a.Name != "your SSH agent" {
		t.Errorf("environment: %+v %v", a, inject)
	}
	// Started by launchd without one: launchd's, handed to ssh.
	a, inject, _ = finder(home, "darwin", map[string]string{"SSH_AUTH_SOCK": filepath.Join(home, "stale.sock")}, system).Find("SSH_AUTH_SOCK")
	if a == nil || a.Socket != system || a.Source != "launchd" || !inject {
		t.Errorf("launchd: %+v %v", a, inject)
	}
	// Then a key manager's socket that answers.
	a, inject, _ = finder(home, "darwin", nil, "").Find("")
	if a == nil || a.Socket != bitwarden || a.Source != "discovered" || !inject {
		t.Errorf("discovered: %+v %v", a, inject)
	}
	// launchd is a macOS thing.
	a, _, _ = finder(home, "linux", nil, system).Find("")
	if a == nil || a.Socket != bitwarden {
		t.Errorf("linux: %+v", a)
	}
}

func TestOnlyLiveKeyManagerSocketsCount(t *testing.T) {
	home := shortHome(t)
	onePassword := filepath.Join(home, "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock")
	secretive := filepath.Join(home, "Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh")
	if len(onePassword) > 100 {
		t.Skip("socket path too long for this system")
	}
	listen(t, onePassword)
	// A file where Secretive's socket would be is not an agent.
	os.MkdirAll(filepath.Dir(secretive), 0o700)
	os.WriteFile(secretive, nil, 0o600)
	f := finder(home, "darwin", nil, "")
	a, _, _ := f.Find("")
	if a == nil || a.Name != "1Password" {
		t.Fatalf("found %+v", a)
	}
	if others := f.Others(onePassword); len(others) != 0 {
		t.Errorf("others = %+v", others)
	}
	linux := filepath.Join(home, ".1password/agent.sock")
	listen(t, linux)
	if a, _, _ := finder(home, "linux", nil, "").Find(""); a == nil || a.Socket != linux || a.Name != "1Password" {
		t.Errorf("linux 1Password: %+v", a)
	}
	if others := f.Others(""); len(others) != 1 || others[0].Name != "1Password" {
		t.Errorf("others = %+v", others)
	}
}

func TestPlanSummaries(t *testing.T) {
	home := shortHome(t)
	os.MkdirAll(filepath.Join(home, ".ssh"), 0o700)
	os.WriteFile(filepath.Join(home, ".ssh", "id_ed25519"), []byte("key"), 0o600)
	sock := filepath.Join(home, ".bitwarden-ssh-agent.sock")
	cfg := Config{User: "me", HostName: "dev-box", Port: "22", IdentityFiles: []string{"~/.ssh/id_rsa", "~/.ssh/id_ed25519"}}

	p := finder(home, "linux", nil, "").MakePlan("me@dev-box", cfg, "")
	if p.Summary != "Using keys from ~/.ssh (id_ed25519)" || len(p.IdentityFiles) != 1 || p.Agent != nil {
		t.Errorf("keys only: %+v", p)
	}
	listen(t, sock)
	p = finder(home, "linux", nil, "").MakePlan("me@dev-box", Config{User: "me"}, "")
	if p.Summary != "Using Bitwarden's SSH agent" || p.Inject != sock {
		t.Errorf("agent only: %+v", p)
	}
	p = finder(home, "linux", nil, "").MakePlan("me@dev-box", cfg, "")
	if p.Summary != "Using Bitwarden's SSH agent and keys from ~/.ssh (id_ed25519)" {
		t.Errorf("both: %q", p.Summary)
	}
	p = finder(shortHome(t), "linux", nil, "").MakePlan("me@dev-box", Config{IdentityAgent: "~/agent.sock"}, "")
	if !strings.Contains(p.Summary, "isn't answering") {
		t.Errorf("dead agent: %q", p.Summary)
	}
	p = finder(shortHome(t), "linux", nil, "").MakePlan("me@dev-box", Config{}, "")
	if !strings.HasPrefix(p.Summary, "No SSH agent or keys found") || p.IdentityFiles == nil {
		t.Errorf("nothing: %+v", p)
	}
}

func TestHostsFollowsIncludesAndSkipsPatterns(t *testing.T) {
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".ssh", "berth"), 0o700)
	os.WriteFile(filepath.Join(home, ".ssh", "config"), []byte(`# comment
Include berth/*.conf ~/.ssh/extra
Host dev-box hetzner
  User me
Host *.internal !bastion gpu-?
Host=pi
Match host foo
`), 0o600)
	os.WriteFile(filepath.Join(home, ".ssh", "berth", "boxes.conf"), []byte("Host berth-devl\nHost homelab\n"), 0o600)
	os.WriteFile(filepath.Join(home, ".ssh", "extra"), []byte("Host \"quoted\" dev-box\n"), 0o600)
	got := strings.Join(Hosts(home), " ")
	if got != "dev-box hetzner homelab pi quoted" {
		t.Errorf("hosts = %q", got)
	}
	if len(Hosts(t.TempDir())) != 0 {
		t.Error("no config means no hosts")
	}
}

func TestTrustHostKeyOnlyTheApprovedKey(t *testing.T) {
	known := filepath.Join(t.TempDir(), ".ssh", "known_hosts")
	hk := HostKey{Fingerprints: []string{"SHA256:aaa"}, Lines: []string{"dev-box.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIinvented"}}
	if err := TrustHostKey(hk, "SHA256:bbb", known); err == nil || !strings.Contains(err.Error(), "different host key") {
		t.Fatalf("a different key was trusted: %v", err)
	}
	if _, err := os.Stat(known); err == nil {
		t.Fatal("known_hosts was written for a key nobody approved")
	}
	if err := TrustHostKey(hk, "yes", known); err == nil {
		t.Fatal("trusted without a fingerprint")
	}
	if err := TrustHostKey(hk, "SHA256:aaa", known); err != nil {
		t.Fatal(err)
	}
	if err := TrustHostKey(hk, "SHA256:aaa", known); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(known)
	if strings.Count(string(data), "ssh-ed25519") != 1 {
		t.Errorf("known_hosts = %q", data)
	}
}

func TestFetchHostKeyReadsWhatSSHRecorded(t *testing.T) {
	var sshArgs []string
	run := func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
		switch name {
		case "ssh":
			sshArgs = args
			for _, a := range args {
				if path, ok := strings.CutPrefix(a, "UserKnownHostsFile="); ok {
					os.WriteFile(path, []byte("dev-box.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIinvented\n"), 0o600)
				}
			}
			return []byte("me@dev-box.example: Permission denied (publickey).\n"), os.ErrPermission
		case "ssh-keygen":
			return []byte("256 SHA256:aaa dev-box.example (ED25519)\n"), nil
		}
		t.Fatalf("ran %s", name)
		return nil, nil
	}
	hk, err := FetchHostKey(context.Background(), run, nil, []string{"-o", "ProxyCommand=berth network proxy personal %h %p"}, "me@dev-box.example")
	if err != nil {
		t.Fatal(err)
	}
	if hk.PickFingerprint("ED25519") != "SHA256:aaa" || len(hk.Lines) != 1 {
		t.Errorf("host key = %+v", hk)
	}
	joined := strings.Join(sshArgs, " ")
	for _, want := range []string{"StrictHostKeyChecking=accept-new", "PubkeyAuthentication=no", "BatchMode=yes", "ProxyCommand=berth network proxy", "me@dev-box.example true"} {
		if !strings.Contains(joined, want) {
			t.Errorf("ssh args miss %q: %s", want, joined)
		}
	}
	// ssh's own known_hosts is never the scratch file's place.
	if strings.Contains(joined, "UserKnownHostsFile="+filepath.Join(os.Getenv("HOME"), ".ssh")) {
		t.Errorf("fetching wrote to the real known_hosts: %s", joined)
	}
}
