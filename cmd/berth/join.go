package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/box"
	"github.com/cosscom/shipyard/internal/identity"
	"github.com/cosscom/shipyard/internal/network"
	"github.com/cosscom/shipyard/internal/pairing"
	"github.com/cosscom/shipyard/internal/terminal"
	"github.com/cosscom/shipyard/internal/trust"
	"github.com/cosscom/shipyard/internal/wire"
)

// berth invite asks each paired box for a fresh pairing code and bundles
// them into one join link; berth join, on another computer of yours, pairs
// with every box in it. Both computers stay paired. The link holds only
// what `berthd pair` would print for each box (address, key fingerprint,
// single-use code) plus names: never this computer's key or any token.

const (
	inviteUsage = "usage: berth invite [--boxes a,b] [--for NAME] [--yes] [--json]"
	joinUsage   = "usage: berth join '<link>'|- [--check] [--yes] [--json]"
	// How long one box gets to answer an invite.
	inviteTimeout = 10 * time.Second
	// How long a direct attempt gets when another tailnet could reach the
	// box instead.
	directTimeout = 8 * time.Second
	// Clocks on two computers of one person are close; this much slack
	// keeps a link from looking expired a moment early. The box decides.
	expirySkew = time.Minute
)

// InvitedBox is a box in an invite, as the inviting computer reports it:
// never the code.
type InvitedBox struct {
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
	Network   string   `json:"network,omitempty"`
	Tailnet   string   `json:"tailnet,omitempty"`
}

// SkippedBox is a box left out of an invite, and why.
type SkippedBox struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

// InviteOutput is what berth invite --json prints.
type InviteOutput struct {
	Link    string       `json:"link"`
	From    string       `json:"from"`
	Expires time.Time    `json:"expires"`
	Boxes   []InvitedBox `json:"boxes"`
	Skipped []SkippedBox `json:"skipped"`
}

func thisComputerName() string {
	hostname, _ := os.Hostname()
	return trust.NameFromHostname(hostname, "laptop")
}

func invite(l laptop, args []string) error {
	var only, forName *string
	var yes *bool
	fs, asJSON, err := flags("invite", args, func(fs *flag.FlagSet) {
		only = fs.String("boxes", "", "comma-separated boxes to include (default: every paired box)")
		forName = fs.String("for", "", "name of the computer being invited, for the boxes' logs and hooks")
		yes = fs.Bool("yes", false, "do not ask before making the link")
	})
	if err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return errors.New(inviteUsage)
	}
	peers, err := selectBoxes(l, *only)
	if err != nil {
		return err
	}
	if !*yes && !asJSON && terminal.IsTerminal(os.Stdin.Fd()) {
		fmt.Printf("The link lets another computer pair with %s, and do anything on them you can:\n", joinNames(names(peers)))
		fmt.Println("run commands, read code, open terminals. Open it only on a computer of yours, and don't post it anywhere.")
		if !confirm("Make the link?", false) {
			return errors.New("no link made")
		}
	}
	ctx, stop := signalContext()
	defer stop()
	out, err := makeInvite(ctx, l, peers, *forName)
	if err != nil {
		return err
	}
	if asJSON {
		return printLinkJSON(out)
	}
	fmt.Printf("Join link (each box's code works once, until %s):\n\n  %s\n\n", out.Expires.Local().Format("15:04"), out.Link)
	fmt.Printf("On the other computer:  berth join '%s'\n", out.Link)
	fmt.Println("or in the Terminal app there: I already use Terminal on another computer.")
	fmt.Println()
	var in []string
	for _, b := range out.Boxes {
		in = append(in, b.Name)
	}
	fmt.Println("Included: " + strings.Join(in, ", "))
	for _, s := range out.Skipped {
		fmt.Printf("Skipped:  %s (%s)\n", s.Name, s.Error)
	}
	fmt.Println("\nAnyone with this link can pair with these boxes until it expires. Keep it to yourself.")
	return nil
}

// selectBoxes resolves --boxes to paired boxes, or every paired box.
func selectBoxes(l laptop, only string) ([]trust.Peer, error) {
	all, err := l.boxes().List()
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return nil, errors.New("no paired boxes to invite another computer to")
	}
	if strings.TrimSpace(only) == "" {
		return all, nil
	}
	var out []trust.Peer
	seen := map[string]bool{}
	for _, name := range strings.Split(only, ",") {
		name = strings.TrimSpace(name)
		if name == "" || seen[strings.ToLower(name)] {
			continue
		}
		seen[strings.ToLower(name)] = true
		p, ok, err := l.boxes().ByName(name)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("no paired box named %q; see berth boxes", name)
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return nil, errors.New("--boxes names no box")
	}
	if len(out) > pairing.MaxInviteBoxes {
		return nil, fmt.Errorf("one link holds at most %d boxes", pairing.MaxInviteBoxes)
	}
	return out, nil
}

// makeInvite asks every box for a code at once. A box that does not answer,
// or refuses, is skipped rather than failing the whole link.
func makeInvite(ctx context.Context, l laptop, peers []trust.Peer, forName string) (InviteOutput, error) {
	if len(peers) > pairing.MaxInviteBoxes {
		peers = peers[:pairing.MaxInviteBoxes]
	}
	id, err := l.identity()
	if err != nil {
		return InviteOutput{}, err
	}
	tailnets := map[string]string{}
	for _, p := range peers {
		if p.Network != "" {
			tailnets = networkTailnets(l)
			break
		}
	}
	type answer struct {
		box InvitedBox
		ib  pairing.InviteBox
		exp time.Time
		err error
	}
	answers := make([]answer, len(peers))
	var wg sync.WaitGroup
	for i, p := range peers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := mintOne(ctx, l, id, p, forName)
			if err != nil {
				answers[i] = answer{err: err}
				return
			}
			code, err := parseCode(got.Code)
			if err != nil {
				answers[i] = answer{err: errors.New("the box answered with a malformed code")}
				return
			}
			// The connection was pinned to p's key, so that is the key the
			// new computer pins too, whatever the answer says.
			addrs := []string{p.Address}
			for _, a := range got.Addresses {
				if a != p.Address && pairing.ValidAddress(a) && len(addrs) < 4 {
					addrs = append(addrs, a)
				}
			}
			ib := pairing.InviteBox{Name: p.Name, Addresses: addrs, Fingerprint: p.Fingerprint, Code: code, Network: p.Network, Tailnet: tailnets[p.Network]}
			answers[i] = answer{
				box: InvitedBox{Name: p.Name, Addresses: addrs, Network: p.Network, Tailnet: ib.Tailnet},
				ib:  ib,
				exp: got.Expires,
			}
		}()
	}
	wg.Wait()
	out := InviteOutput{From: thisComputerName(), Boxes: []InvitedBox{}, Skipped: []SkippedBox{}}
	inv := pairing.Invite{From: out.From}
	for i, a := range answers {
		if a.err != nil {
			out.Skipped = append(out.Skipped, SkippedBox{Name: peers[i].Name, Error: a.err.Error()})
			continue
		}
		out.Boxes = append(out.Boxes, a.box)
		inv.Boxes = append(inv.Boxes, a.ib)
		if inv.Expires.IsZero() || a.exp.Before(inv.Expires) {
			inv.Expires = a.exp
		}
	}
	if len(inv.Boxes) == 0 {
		var why []string
		for _, s := range out.Skipped {
			why = append(why, s.Name+": "+s.Error)
		}
		return InviteOutput{}, errors.New("no box could make an invite (" + strings.Join(why, "; ") + ")")
	}
	if limit := time.Now().Add(time.Hour); inv.Expires.After(limit) {
		inv.Expires = limit
	}
	if err := inv.Valid(); err != nil {
		return InviteOutput{}, err
	}
	out.Expires = inv.Expires.UTC()
	out.Link = inv.String()
	return out, nil
}

// mintOne asks one box for a pairing code over this laptop's own pinned
// connection to it.
func mintOne(ctx context.Context, l laptop, id *identity.Identity, p trust.Peer, forName string) (box.PairingInvite, error) {
	var out box.PairingInvite
	dial, err := networkDialer(l, p.Network)
	if err != nil {
		return out, err
	}
	c := wire.NewClientVia(id, p, dial)
	defer c.Reset()
	ctx, cancel := context.WithTimeout(ctx, inviteTimeout)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"for": forName})
	resp, err := c.DoWithHeader(ctx, http.MethodPost, "/v1/pairing/invite", bytes.NewReader(body), http.Header{"Content-Type": {"application/json"}})
	if errors.Is(err, wire.ErrUntrusted) {
		return out, errors.New("it no longer trusts this computer")
	}
	if err != nil {
		if wire.Unsent(err) {
			return out, errors.New("offline")
		}
		return out, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		err := json.NewDecoder(io.LimitReader(resp.Body, 16<<10)).Decode(&out)
		return out, err
	case http.StatusNotFound:
		return out, fmt.Errorf("its berthd is too old to make invites; run berth upgrade %s", p.Name)
	}
	var e struct {
		Error string `json:"error"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&e) == nil && e.Error != "" {
		return out, errors.New(e.Error)
	}
	return out, fmt.Errorf("box replied %s", resp.Status)
}

// printLinkJSON is printJSON with a link's & left as it is.
func printLinkJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func parseCode(s string) (pairing.Code, error) {
	var c pairing.Code
	err := c.UnmarshalText([]byte(s))
	return c, err
}

func names(peers []trust.Peer) []string {
	out := make([]string, len(peers))
	for i, p := range peers {
		out[i] = p.Name
	}
	return out
}

// joinNames reads "devl, build and homelab".
func joinNames(n []string) string {
	switch len(n) {
	case 0:
		return "no boxes"
	case 1:
		return n[0]
	}
	return strings.Join(n[:len(n)-1], ", ") + " and " + n[len(n)-1]
}

func confirm(question string, yesByDefault bool) bool {
	hint := "[y/N]"
	if yesByDefault {
		hint = "[Y/n]"
	}
	fmt.Printf("%s %s ", question, hint)
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	case "":
		return yesByDefault
	}
	return false
}

// networkTailnets maps this computer's Terminal networks to their tailnets'
// names, from the agent.
func networkTailnets(l laptop) map[string]string {
	out := map[string]string{}
	for _, n := range listAgentNetworks(l) {
		out[n.Name] = n.Tailnet
	}
	return out
}

func listAgentNetworks(l laptop) []network.Info {
	c, err := ensureAgent(l)
	if err != nil {
		return nil
	}
	var nets []network.Info
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c.Call(ctx, "GET", "/v1/networks", nil, &nets)
	return nets
}

// JoinResult is what happened with one box of a join link.
type JoinResult struct {
	Name string `json:"name"`
	// Status is ready (--check only), paired, already (this computer was
	// paired with it before), needs-network (it is on a tailnet this
	// computer has not signed in to) or failed.
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	Address string `json:"address,omitempty"`
	// Network is the Terminal network the box is (or would be) reached
	// through, Tailnet that network's tailnet.
	Network string `json:"network,omitempty"`
	Tailnet string `json:"tailnet,omitempty"`
	// SignIn, with --check, says the box is reached through a network this
	// computer has not signed in to, so joining may ask for that first.
	SignIn bool `json:"sign_in,omitempty"`
}

// JoinOutput is what berth join --json prints.
type JoinOutput struct {
	From    string       `json:"from"`
	Expires time.Time    `json:"expires"`
	Boxes   []JoinResult `json:"boxes"`
}

const (
	joinReady        = "ready"
	joinPaired       = "paired"
	joinAlready      = "already"
	joinNeedsNetwork = "needs-network"
	joinFailed       = "failed"
)

func join(l laptop, args []string) error {
	var check, yes *bool
	fs, asJSON, err := flags("join", args, func(fs *flag.FlagSet) {
		check = fs.Bool("check", false, "only say what the link holds and what joining would do")
		yes = fs.Bool("yes", false, "do not ask before pairing")
	})
	if err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New(joinUsage)
	}
	text := fs.Arg(0)
	// "-" reads the link from stdin, which keeps the codes out of the
	// process list: the app passes it that way.
	if text == "-" {
		b, err := io.ReadAll(io.LimitReader(os.Stdin, 64<<10))
		if err != nil {
			return err
		}
		text = string(b)
	}
	inv, err := readInvite(text, time.Now())
	if err != nil {
		return err
	}
	networks := localNetworks(l, inv)
	if *check {
		out := JoinOutput{From: inv.From, Expires: inv.Expires, Boxes: checkJoin(l, inv, networks)}
		if asJSON {
			return printJSON(out)
		}
		printJoin(out)
		return nil
	}
	if !*yes && !asJSON && terminal.IsTerminal(os.Stdin.Fd()) {
		var n []string
		for _, b := range inv.Boxes {
			n = append(n, b.Name)
		}
		fmt.Printf("Pair this computer with %s (invited by %s)?\n", joinNames(n), inv.From)
		if !confirm("Pair?", true) {
			return errors.New("not paired")
		}
	}
	ctx, stop := signalContext()
	defer stop()
	results := joinInvite(ctx, l, inv, networks)
	// On a terminal, a box behind a tailnet this computer is not on can be
	// fixed now: sign in, then try that box again.
	if !asJSON && terminal.IsTerminal(os.Stdin.Fd()) {
		for i, r := range results {
			if r.Status != joinNeedsNetwork || ctx.Err() != nil {
				continue
			}
			where := r.Network
			if r.Tailnet != "" {
				where = r.Tailnet + " (" + r.Network + ")"
			}
			fmt.Printf("%s is on the tailnet %s, which this computer has not signed in to.\n", r.Name, where)
			if !confirm("Sign in now?", true) {
				continue
			}
			if err := networkLogin(l, r.Network); err != nil {
				results[i].Error = err.Error()
				continue
			}
			networks = localNetworks(l, inv)
			one := pairing.Invite{From: inv.From, Expires: inv.Expires, Boxes: []pairing.InviteBox{inv.Boxes[i]}}
			results[i] = joinInvite(ctx, l, one, networks)[0]
		}
	}
	if c := agentIfRunning(l); c != nil {
		c.Refresh(context.Background())
	}
	out := JoinOutput{From: inv.From, Expires: inv.Expires, Boxes: results}
	if asJSON {
		return printLinkJSON(out)
	}
	printJoin(out)
	failed := 0
	for _, r := range results {
		if r.Status == joinFailed || r.Status == joinNeedsNetwork {
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d boxes not paired", failed, len(results))
	}
	return nil
}

// readInvite finds and parses the link in text, and refuses one whose codes
// have expired: the boxes would refuse them anyway.
func readInvite(text string, now time.Time) (pairing.Invite, error) {
	link := pairing.FindJoinLink(text)
	if link == "" {
		if _, err := pairing.ParseToken(strings.TrimSpace(text)); err == nil {
			return pairing.Invite{}, errors.New("that is a pairing link for one box; use berth pair")
		}
		return pairing.Invite{}, errors.New("no join link found; it starts with berth://join? (make one with berth invite)")
	}
	inv, err := pairing.ParseInvite(link)
	if err != nil {
		return pairing.Invite{}, err
	}
	if now.After(inv.Expires.Add(expirySkew)) {
		return pairing.Invite{}, fmt.Errorf("this join link expired at %s; make a new one on %s with berth invite", inv.Expires.Local().Format("15:04"), inv.From)
	}
	return inv, nil
}

// localNetworks is the state of this computer's Terminal networks the link's
// boxes are reached through, by name; nothing when none is named.
func localNetworks(l laptop, inv pairing.Invite) map[string]network.Info {
	out := map[string]network.Info{}
	for _, b := range inv.Boxes {
		if b.Network == "" {
			continue
		}
		for _, n := range listAgentNetworks(l) {
			out[n.Name] = n
		}
		break
	}
	return out
}

func checkJoin(l laptop, inv pairing.Invite, networks map[string]network.Info) []JoinResult {
	out := make([]JoinResult, len(inv.Boxes))
	for i, b := range inv.Boxes {
		r := JoinResult{Name: b.Name, Status: joinReady, Network: b.Network, Tailnet: b.Tailnet, Address: b.Addresses[0]}
		if p, ok, _ := l.boxes().Trusted(b.Fingerprint); ok {
			r.Status, r.Name, r.Address, r.Network = joinAlready, p.Name, p.Address, p.Network
		} else if b.Network != "" && networks[b.Network].State != "Running" {
			r.SignIn = true
		}
		out[i] = r
	}
	return out
}

// joinInvite pairs with every box in inv at once. Each box is tried on its
// addresses in turn, through the named network when this computer has it,
// then directly (its own Tailscale may be on that tailnet already). Only an
// attempt that never reached a box moves on to the next; a box that answered
// and refused (a used or expired code, a key that does not match the link)
// is a failure.
func joinInvite(ctx context.Context, l laptop, inv pairing.Invite, networks map[string]network.Info) []JoinResult {
	results := make([]JoinResult, len(inv.Boxes))
	id, err := l.identity()
	if err != nil {
		for i, b := range inv.Boxes {
			results[i] = JoinResult{Name: b.Name, Status: joinFailed, Error: err.Error()}
		}
		return results
	}
	me := thisComputerName()
	var wg sync.WaitGroup
	for i, b := range inv.Boxes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = joinOne(ctx, l, id, me, b, networks)
		}()
	}
	wg.Wait()
	return results
}

type joinRoute struct {
	network string
	dial    wire.DialFunc
	timeout time.Duration
}

func joinOne(ctx context.Context, l laptop, id *identity.Identity, me string, b pairing.InviteBox, networks map[string]network.Info) JoinResult {
	r := JoinResult{Name: b.Name, Network: b.Network, Tailnet: b.Tailnet}
	if p, ok, err := l.boxes().Trusted(b.Fingerprint); err != nil {
		r.Status, r.Error = joinFailed, err.Error()
		return r
	} else if ok {
		r.Status, r.Name, r.Address, r.Network = joinAlready, p.Name, p.Address, p.Network
		return r
	}
	var routes []joinRoute
	ready := b.Network != "" && networks[b.Network].State == "Running"
	if ready {
		dial, err := networkDialer(l, b.Network)
		if err == nil {
			routes = append(routes, joinRoute{network: b.Network, dial: dial})
		}
	}
	direct := joinRoute{}
	if b.Network != "" {
		direct.timeout = directTimeout
	}
	routes = append(routes, direct)
	var lastErr error
	for _, rt := range routes {
		for _, addr := range b.Addresses {
			tok := pairing.Token{Address: addr, Fingerprint: b.Fingerprint, Code: b.Code}
			attempt := ctx
			cancel := func() {}
			if rt.timeout > 0 {
				attempt, cancel = context.WithTimeout(ctx, rt.timeout)
			}
			_, err := wire.PairVia(attempt, id, tok, me, rt.dial)
			cancel()
			if err == nil {
				peer := trust.Peer{Name: b.Name, Address: addr, Network: rt.network, Fingerprint: b.Fingerprint, PairedAt: time.Now().UTC()}
				name, err := l.boxes().AddWithFreeName(peer)
				if err != nil {
					r.Status, r.Error = joinFailed, "the box accepted this computer, but saving it here failed: "+err.Error()
					return r
				}
				r.Status, r.Name, r.Address, r.Network = joinPaired, name, addr, rt.network
				if rt.network == "" {
					r.Tailnet = ""
				}
				return r
			}
			lastErr = err
			if errors.Is(err, wire.ErrPairingRefused) {
				r.Status, r.Error = joinFailed, "the box refused the code: this link was used already or has expired; make a new one with berth invite"
				return r
			}
			if !wire.Unsent(err) || ctx.Err() != nil {
				r.Status, r.Error = joinFailed, err.Error()
				return r
			}
		}
	}
	if b.Network != "" && !ready {
		r.Status = joinNeedsNetwork
		r.Error = "sign in to the " + b.Network + " network to reach it"
		return r
	}
	r.Status, r.Error = joinFailed, fmt.Sprintf("could not reach it at %s: %v", strings.Join(b.Addresses, ", "), lastErr)
	return r
}

func networkLogin(l laptop, name string) error {
	c, err := ensureAgent(l)
	if err != nil {
		return err
	}
	_, err = c.Login(context.Background(), name, func(url string) {
		fmt.Printf("Sign in to the tailnet for %q:\n  %s\n", name, url)
		opener := "xdg-open"
		if runtime.GOOS == "darwin" {
			opener = "open"
		}
		exec.Command(opener, url).Start()
	})
	return err
}

func printJoin(out JoinOutput) {
	fmt.Printf("From %s, until %s:\n", out.From, out.Expires.Local().Format("15:04"))
	for _, r := range out.Boxes {
		var what string
		switch r.Status {
		case joinReady:
			what = "ready to pair"
			if r.SignIn {
				what += fmt.Sprintf(" (may need a sign-in to the %s network first)", r.Network)
			}
		case joinPaired:
			what = "paired at " + r.Address
			if r.Network != "" {
				what += " through " + r.Network
			}
		case joinAlready:
			what = "already paired"
		case joinNeedsNetwork:
			what = fmt.Sprintf("needs the %s network: run berth network login %s, then berth join again", r.Network, r.Network)
		default:
			what = "not paired: " + r.Error
		}
		fmt.Printf("  %-16s %s\n", r.Name, what)
	}
}
