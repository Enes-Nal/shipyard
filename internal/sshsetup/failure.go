package sshsetup

import (
	"fmt"
	"regexp"
	"strings"
)

// FailureEnv set to 1 asks `berth add ssh` to also print a Failure as JSON
// on one stderr line starting FailurePrefix, for the laptop agent to pass to
// the app with the error.
const (
	FailureEnv    = "BERTH_FAILURE_JSON"
	FailurePrefix = "berth-failure: "
)

// Failure is an ssh failure in plain words, with what the app needs to offer
// the next step: the install command when nothing answers, a key file when
// keys were refused, a trust button for a new host key.
type Failure struct {
	// Kind is one of refused, timeout, unreachable, resolve, auth, password,
	// host-key-unknown, host-key-changed, other.
	Kind    string `json:"kind"`
	Host    string `json:"host"`
	Port    string `json:"port,omitempty"`
	Message string `json:"message"`
	// Fingerprint is the host key's, for host-key-unknown and -changed.
	Fingerprint string `json:"fingerprint,omitempty"`
	// Tried names the agent and keys offered, for auth.
	Tried []string `json:"tried,omitempty"`
	// Detail is ssh's own last words, for anyone who wants them.
	Detail string `json:"detail,omitempty"`
}

func (f *Failure) Error() string { return f.Message }

var (
	fingerprintRe = regexp.MustCompile(`SHA256:[A-Za-z0-9+/=]+`)
	offeringRe    = regexp.MustCompile(`(?m)^debug1: Offering public key: (\S+)(?: (\S+))?(?: (SHA256:\S+))?(.*)$`)
	deniedRe      = regexp.MustCompile(`Permission denied \(([^)]*)\)`)
	noKeyKnownRe  = regexp.MustCompile(`No (\S+) host key is known for`)
)

// Classify explains ssh's stderr for a failed connection to host. agent and
// keys are what berth arranged for ssh to offer, used when ssh's own output
// does not list them (it does only with -v).
func Classify(stderr, host, port string, agent *Agent, keys []string) *Failure {
	if port == "" {
		port = "22"
	}
	f := &Failure{Host: host, Port: port, Detail: lastSSHLine(stderr)}
	// ssh -v's debug lines tell what was offered, not what failed: an IPv6
	// address refused before IPv4 connected is not "nothing is listening".
	verbose := stderr
	stderr = withoutDebug(stderr)
	where := host
	if port != "22" {
		where = fmt.Sprintf("%s (port %s)", host, port)
	} else {
		where = host + " (port 22)"
	}
	install := "Run the install command on the box instead, or check the address."
	switch {
	case strings.Contains(stderr, "REMOTE HOST IDENTIFICATION HAS CHANGED"):
		f.Kind = "host-key-changed"
		f.Fingerprint = fingerprintRe.FindString(stderr)
		f.Message = fmt.Sprintf("%s's host key has changed since this computer last connected, so Terminal did not log in. If the box was rebuilt, remove the old key with `ssh-keygen -R %s` and try again; if not, someone may be in the way, so don't connect.", host, host)
	case strings.Contains(stderr, "Host key verification failed"):
		f.Kind = "host-key-unknown"
		f.Fingerprint = fingerprintRe.FindString(stderr)
		f.Message = fmt.Sprintf("This computer hasn't connected to %s before. Check its host key fingerprint, then trust it to continue.", host)
	case strings.Contains(stderr, "Could not resolve hostname") || strings.Contains(stderr, "Name or service not known") || strings.Contains(stderr, "nodename nor servname"):
		f.Kind = "resolve"
		f.Message = fmt.Sprintf("Could not resolve %s: no machine by that name is reachable from this computer. Check the spelling, or use its IP or tailnet address.", host)
	case strings.Contains(stderr, "Connection refused"):
		f.Kind = "refused"
		f.Message = fmt.Sprintf("Nothing is accepting SSH on %s: the machine answered, but refused the connection. %s", where, install)
	case strings.Contains(stderr, "timed out") || strings.Contains(stderr, "Connection timeout"):
		f.Kind = "timeout"
		f.Message = fmt.Sprintf("Nothing is accepting SSH on %s: the connection timed out. The machine may be off, or a firewall drops SSH. %s", where, install)
	case strings.Contains(stderr, "No route to host") || strings.Contains(stderr, "Network is unreachable") || strings.Contains(stderr, "Host is down"):
		f.Kind = "unreachable"
		f.Message = fmt.Sprintf("Nothing is accepting SSH on %s: this computer has no route to it. Is it on a network (or tailnet) this computer is on? %s", where, install)
	case deniedRe.MatchString(stderr) || strings.Contains(stderr, "Too many authentication failures"):
		methods := ""
		if m := deniedRe.FindStringSubmatch(stderr); m != nil {
			methods = m[1]
		}
		f.Tried = tried(verbose, agent, keys)
		if methods != "" && !strings.Contains(methods, "publickey") {
			f.Kind = "password"
			f.Message = fmt.Sprintf("%s only accepts passwords, and the login failed. Terminal logs in with SSH keys: add your public key to ~/.ssh/authorized_keys on the box, or run the install command on the box instead.", host)
			break
		}
		return AuthFailure(host, port, f.Tried, f.Detail)
	default:
		f.Kind = "other"
		detail := f.Detail
		if detail == "" {
			detail = "ssh failed without saying why"
		}
		f.Message = fmt.Sprintf("Could not log in to %s over SSH: %s", host, detail)
	}
	return f
}

// AuthFailure is "every key was refused", naming what was offered.
func AuthFailure(host, port string, tried []string, detail string) *Failure {
	offered := "no keys at all: no agent answered and no key file was found"
	if len(tried) > 0 {
		offered = strings.Join(tried, ", ")
	}
	return &Failure{
		Kind: "auth", Host: host, Port: port, Tried: tried, Detail: detail,
		Message: fmt.Sprintf("%s refused the login. Terminal offered %s. Make the right key available: unlock your key manager's SSH agent, name it with IdentityAgent for this host in ~/.ssh/config, or choose the key file. Or add this computer's public key to ~/.ssh/authorized_keys on the box.", host, offered),
	}
}

// UnknownKeyType is the key type ssh wanted to verify ("ED25519"), from
// "No ED25519 host key is known for …".
func UnknownKeyType(stderr string) string {
	if m := noKeyKnownRe.FindStringSubmatch(stderr); m != nil {
		return m[1]
	}
	return ""
}

// tried lists what was offered: from ssh -v's "Offering public key" lines
// when present, otherwise from what berth arranged.
func tried(stderr string, agent *Agent, keys []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range offeringRe.FindAllStringSubmatch(stderr, -1) {
		what := m[1]
		if strings.Contains(m[4], "agent") && agent != nil {
			what += " (" + agentPhrase(agent.Name) + ")"
		} else if strings.Contains(m[4], "agent") {
			what += " (from an agent)"
		}
		if !seen[what] {
			seen[what] = true
			out = append(out, what)
		}
	}
	if len(out) > 0 {
		return out
	}
	if agent != nil {
		out = append(out, "the keys in "+agentPhrase(agent.Name))
	}
	out = append(out, keys...)
	return out
}

func withoutDebug(stderr string) string {
	var b strings.Builder
	for _, l := range strings.Split(stderr, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(l), "debug") {
			b.WriteString(l + "\n")
		}
	}
	return b.String()
}

// lastSSHLine is ssh's last meaningful line, without debug output.
func lastSSHLine(stderr string) string {
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if l == "" || strings.HasPrefix(l, "debug") || strings.HasPrefix(l, "@") || strings.HasPrefix(l, "Warning: Permanently added") {
			continue
		}
		return l
	}
	return ""
}
