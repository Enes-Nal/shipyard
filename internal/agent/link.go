package agent

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"

	"tailscale.com/ipn/ipnstate"

	"github.com/cosscom/shipyard/internal/doctor"
	"github.com/cosscom/shipyard/internal/network"
	"github.com/cosscom/shipyard/internal/trust"
	"github.com/cosscom/shipyard/internal/wire"
)

// A link to a box can be slow without being gone: a box reached through a
// Tailscale relay on another continent answers in 80 ms, then in 1.9 s,
// then in 80 ms again. The agent rides that out. One health check that is
// slow or gets no answer marks the box slow, and requests to it still go
// through; only two failed checks in a row, or one that can only mean the
// box is gone (the connection refused, a key other than its pairing's, the
// box saying it is stopping), take it away. One good check makes it online
// again.

const (
	// slowCheck is how long a health check may take before the link is
	// called slow.
	slowCheck = 1500 * time.Millisecond
	// awayAfter is how many health checks in a row must fail before a box
	// is away (a hard failure needs one).
	awayAfter = 2
	// linkSamples is how many recent checks the latency's max and jitter
	// cover: a minute at the default interval.
	linkSamples = 6
	// pathEvery is how often the agent asks Tailscale how it reaches a box
	// (direct or relayed): `tailscale status` is cheap, but not free.
	pathEvery = 2 * time.Minute
)

// Link is how well the laptop reaches a box, in its status.
type Link struct {
	// Slow: the last health check took over 1.5 s, or got no answer while
	// the one before did. Requests still go through.
	Slow bool `json:"slow,omitempty"`
	// Reason says why the link is slow, or why the box went away.
	Reason string `json:"reason,omitempty"`
	// MaxMs is the slowest of the recent checks that answered, and JitterMs
	// how much one check's latency differs from the next on average.
	MaxMs    int64 `json:"max_ms,omitempty"`
	JitterMs int64 `json:"jitter_ms,omitempty"`
	// Path is how the box is reached over Tailscale, when that can be told.
	Path *network.Path `json:"path,omitempty"`
}

// linkStep is a box's state after one health check.
type linkStep struct {
	State string
	Slow  bool
	// Fails is how many checks in a row have failed, this one included.
	Fails int
	// Reason is why, for the log and the status.
	Reason string
}

// stepLink is the state machine: where a box in state prev, with fails
// failed checks behind it, goes after a check that took took and ended
// with err.
func stepLink(prev string, fails int, took, timeout time.Duration, err error) linkStep {
	if err == nil {
		s := linkStep{State: StateOnline, Reason: "health check took " + roundDur(took)}
		s.Slow = took >= slowCheck
		return s
	}
	fails++
	why := shortErr(err, timeout)
	switch {
	case errors.Is(err, wire.ErrUntrusted):
		return linkStep{State: StateUntrusted, Fails: fails, Reason: why}
	case hardFailure(err):
		return linkStep{State: StateOffline, Fails: fails, Reason: why}
	case fails >= awayAfter:
		return linkStep{State: StateOffline, Fails: fails, Reason: fmt.Sprintf("%d checks failed: %s", fails, why)}
	case prev == StateOnline:
		return linkStep{State: StateOnline, Slow: true, Fails: fails, Reason: "health check failed: " + why}
	case prev == StateConnecting:
		return linkStep{State: StateConnecting, Fails: fails, Reason: why}
	}
	return linkStep{State: StateOffline, Fails: fails, Reason: why}
}

// hardFailure reports whether err can only mean the box is gone, rather
// than a slow link: the connection refused (nothing listens there), a key
// other than the pairing's, or the box saying it is stopping.
func hardFailure(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED) ||
		// Another tailnet's node (gVisor) says it in words.
		strings.Contains(err.Error(), "connection refused") ||
		strings.Contains(err.Error(), "connection was refused") ||
		errors.Is(err, wire.ErrPinMismatch) ||
		wire.Stopping(err)
}

// shortErr is err without the request around it: "i/o timeout", not
// `Get "https://…/v1/ping": dial tcp …: i/o timeout`.
func shortErr(err error, timeout time.Duration) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "no answer in " + roundDur(timeout)
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection refused"
	case errors.Is(err, wire.ErrPinMismatch):
		return "the box answered with a key other than its pairing's"
	case wire.Stopping(err):
		return "the box is stopping"
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	var op *net.OpError
	if errors.As(err, &op) && op.Err != nil {
		err = op.Err
	}
	return err.Error()
}

// roundDur is d as people say it: 80ms, 1.9s, 12s.
func roundDur(d time.Duration) string {
	switch {
	case d < time.Second:
		return max(d.Round(time.Millisecond), time.Millisecond).String()
	case d < 10*time.Second:
		return d.Round(100 * time.Millisecond).String()
	}
	return d.Round(time.Second).String()
}

// linkLabel is a box's state in the log's words: online, slow, away,
// connecting, untrusted.
func linkLabel(state string, slow bool) string {
	switch {
	case state == StateOnline && slow:
		return "slow"
	case state == StateOffline:
		return "away"
	}
	return state
}

// noteSample records a check's latency and returns the recent max and
// jitter (the mean difference between one check and the next).
func noteSample(samples []time.Duration, d time.Duration) ([]time.Duration, int64, int64) {
	samples = append(samples, d)
	if len(samples) > linkSamples {
		samples = samples[len(samples)-linkSamples:]
	}
	var hi, diff time.Duration
	for i, s := range samples {
		hi = max(hi, s)
		if i > 0 {
			diff += (s - samples[i-1]).Abs()
		}
	}
	jitter := time.Duration(0)
	if len(samples) > 1 {
		jitter = diff / time.Duration(len(samples)-1)
	}
	return samples, hi.Milliseconds(), jitter.Milliseconds()
}

// learnPath asks Tailscale, in the background and at most every couple of
// minutes, how the laptop reaches a box: directly, or through a relay.
func (a *Agent) learnPath(name string, st *boxState) {
	a.mu.Lock()
	if st.learning || (!st.pathAt.IsZero() && time.Since(st.pathAt) < pathEvery) {
		a.mu.Unlock()
		return
	}
	st.learning, st.pathAt = true, time.Now()
	peer := st.peer
	a.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
		defer cancel()
		path := a.pathOf(ctx, peer)
		a.mu.Lock()
		st.learning = false
		old := st.status.Link.Path
		changed := a.clients[name] == st && !samePath(old, path)
		if changed {
			st.status.Link.Path = path
		}
		a.mu.Unlock()
		if !changed {
			return
		}
		switch {
		case path != nil && path.Relayed():
			a.cfg.Log.Printf("box %s: %s", name, describePath(*path))
		case path != nil && old != nil && old.Relayed():
			a.cfg.Log.Printf("box %s: direct connection over Tailscale", name)
		}
		a.publish(Event{Type: EventBoxLink, Box: name})
	}()
}

func samePath(a, b *network.Path) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// describePath says how a box is reached, in the words Settings › Boxes
// uses: "relayed through Tailscale's New York server: no direct connection".
func describePath(p network.Path) string {
	switch p.Via {
	case "relay":
		s := "relayed through Tailscale's " + p.RelayName + " server: no direct connection"
		if p.Nearest != "" && p.Nearest != p.RelayName {
			s += " (this computer's nearest is " + p.Nearest + ")"
		}
		return s
	case "peer-relay":
		return "relayed through a peer relay (" + p.Endpoint + "): no direct connection"
	}
	return "direct connection over Tailscale"
}

// pathOf finds how peer is reached: through the agent's own network for a
// box on another tailnet, or this computer's Tailscale for a box at a
// Tailscale address. nil when it can't tell, or the box isn't on a tailnet.
func (a *Agent) pathOf(ctx context.Context, peer trust.Peer) *network.Path {
	host, _, err := net.SplitHostPort(peer.Address)
	if err != nil {
		host = peer.Address
	}
	var ips []netip.Addr
	if ip, err := netip.ParseAddr(host); err == nil {
		ips = append(ips, ip.Unmap())
	}
	var st *ipnstate.Status
	if peer.Network != "" {
		st, err = a.cfg.Networks.Status(ctx, peer.Network)
	} else {
		if len(ips) == 0 {
			// A name: whatever it resolves to, the system's Tailscale is
			// asked only about a Tailscale address.
			found, _ := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
			for _, ip := range found {
				ips = append(ips, ip.Unmap())
			}
		}
		onTailnet := false
		for _, ip := range ips {
			onTailnet = onTailnet || network.IsTailscaleIP(ip)
		}
		if !onTailnet {
			return nil
		}
		st, err = a.systemTailscale(ctx)
	}
	if err != nil {
		return nil
	}
	p, ok := network.PathTo(st, host, ips)
	if !ok {
		return nil
	}
	p.Tailnet = peer.Network
	return &p
}

// systemTailscale is this computer's `tailscale status`, read at most every
// couple of minutes however many boxes ask.
func (a *Agent) systemTailscale(ctx context.Context) (*ipnstate.Status, error) {
	a.tsMu.Lock()
	defer a.tsMu.Unlock()
	if !a.tsAt.IsZero() && time.Since(a.tsAt) < pathEvery {
		return a.tsStatus, a.tsErr
	}
	a.tsStatus, a.tsErr = a.cfg.TailscaleStatus(ctx)
	a.tsAt = time.Now()
	return a.tsStatus, a.tsErr
}

// relayedDoc is where a relayed link is explained, with what fixes it.
const relayedDoc = "https://docs.berthd.app/concepts/laptop-agent#a-relayed-link"

// LinkChecks is `berth doctor`'s word on how this laptop reaches a box:
// its latency, whether it is slow and why, and whether Tailscale relays it.
func LinkChecks(area string, b BoxStatus) []doctor.Check {
	if b.State != StateOnline {
		return nil
	}
	var checks []doctor.Check
	lat := doctor.Check{Area: area, Name: "latency", Status: doctor.OK, Detail: fmt.Sprintf("%dms", b.LatencyMs)}
	if b.Link.MaxMs > 0 {
		lat.Detail += fmt.Sprintf(", up to %dms lately (±%dms)", b.Link.MaxMs, b.Link.JitterMs)
	}
	if b.Link.Slow {
		lat.Status, lat.Detail = doctor.Warn, "slow: "+b.Link.Reason+"; Terminal stays connected and requests still go through"
	}
	checks = append(checks, lat)
	if p := b.Link.Path; p != nil {
		path := doctor.Check{Area: area, Name: "path", Status: doctor.OK, Detail: describePath(*p)}
		if p.Endpoint != "" && p.Via == "direct" {
			path.Detail += " (" + p.Endpoint + ")"
		}
		if p.Relayed() {
			path.Status = doctor.Warn
			path.Fix = "Allow inbound UDP 41641 to " + b.Name + " (or forward it on the NAT in front of its VM): " + relayedDoc
		}
		checks = append(checks, path)
	}
	return checks
}
