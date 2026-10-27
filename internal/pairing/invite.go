package pairing

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/identity"
)

// A join link carries one pairing code per box, so another computer of
// yours can pair with all of them at once:
//
//	berth://join?v=1&d=<payload>
//
// The payload is base64url (no padding) of a small binary record, which
// keeps the link short enough for a QR code:
//
//	expires   uint32  unix seconds
//	from      str     the inviting computer's name, for display
//	count     uint8
//	per box:
//	  fingerprint [32]byte  the key the box must present (pinned)
//	  code        [32]byte  its single-use pairing code
//	  name        str       what the inviting computer calls it
//	  network     str       the Terminal network it is reached through, or ""
//	  tailnet     str       that network's tailnet, for the sign-in prompt
//	  addresses   uint8 count, then str each (host:port)
//
// where str is a uint8 length then that many bytes. Nothing else is in it:
// no key, no token, no app data. Each code is the same as one `berthd pair`
// prints: single use, ten minutes, and proven over the TLS session rather
// than sent (see Proof).

const (
	JoinHost    = "join"
	JoinVersion = "1"
	// MaxInviteBoxes bounds a link, so a QR code of it stays scannable.
	MaxInviteBoxes = 16
	maxStr         = 255
	maxAddresses   = 4
)

// InviteBox is one box in a join link.
type InviteBox struct {
	Name        string               `json:"name"`
	Addresses   []string             `json:"addresses"`
	Fingerprint identity.Fingerprint `json:"fingerprint"`
	Code        Code                 `json:"-"`
	// Network is the name of the Terminal network (an embedded tailnet node)
	// the inviting computer reaches the box through; empty for its own
	// network. Tailnet is that network's tailnet name.
	Network string `json:"network,omitempty"`
	Tailnet string `json:"tailnet,omitempty"`
}

// Invite is a join link's content.
type Invite struct {
	From    string      `json:"from"`
	Expires time.Time   `json:"expires"`
	Boxes   []InviteBox `json:"boxes"`
}

var errMalformedInvite = errors.New("malformed join link; copy it again from the computer that made it (berth invite)")

// String encodes the invite as a berth://join link.
func (inv Invite) String() string {
	b := binary.BigEndian.AppendUint32(nil, uint32(inv.Expires.Unix()))
	b = appendStr(b, inv.From)
	b = append(b, byte(len(inv.Boxes)))
	for _, x := range inv.Boxes {
		b = append(b, x.Fingerprint[:]...)
		b = append(b, x.Code[:]...)
		b = appendStr(b, x.Name)
		b = appendStr(b, x.Network)
		b = appendStr(b, x.Tailnet)
		b = append(b, byte(len(x.Addresses)))
		for _, a := range x.Addresses {
			b = appendStr(b, a)
		}
	}
	// base64url needs no escaping in a query.
	return Scheme + "://" + JoinHost + "?v=" + JoinVersion + "&d=" + base64.RawURLEncoding.EncodeToString(b)
}

// Valid reports whether the invite can be encoded and parsed back: it is
// what berth invite checks before printing a link.
func (inv Invite) Valid() error {
	if len(inv.Boxes) == 0 || len(inv.Boxes) > MaxInviteBoxes || len(inv.From) > maxStr {
		return errMalformedInvite
	}
	for _, x := range inv.Boxes {
		if !validLabel(x.Name) || (x.Network != "" && !validLabel(x.Network)) || len(x.Tailnet) > maxStr || len(x.Addresses) == 0 || len(x.Addresses) > maxAddresses {
			return errMalformedInvite
		}
		for _, a := range x.Addresses {
			if !ValidAddress(a) {
				return errMalformedInvite
			}
		}
	}
	return nil
}

func appendStr(b []byte, s string) []byte {
	if len(s) > maxStr {
		s = s[:maxStr]
	}
	return append(append(b, byte(len(s))), s...)
}

// ParseInvite reads a berth://join link. Every field is checked, so what it
// returns is safe to show and to use as a name.
func ParseInvite(s string) (Invite, error) {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || u.Scheme != Scheme || u.Host != JoinHost || u.User != nil || (u.Path != "" && u.Path != "/") {
		return Invite{}, errMalformedInvite
	}
	q := u.Query()
	if q.Get("v") != JoinVersion {
		return Invite{}, errors.New("this join link is from a newer version of Terminal; update Terminal on this computer")
	}
	b, err := base64.RawURLEncoding.DecodeString(q.Get("d"))
	if err != nil {
		return Invite{}, errMalformedInvite
	}
	r := reader{b: b}
	var inv Invite
	inv.Expires = time.Unix(int64(r.uint32()), 0).UTC()
	inv.From = r.str()
	n := int(r.byte())
	if n == 0 || n > MaxInviteBoxes {
		return Invite{}, errMalformedInvite
	}
	for range n {
		var x InviteBox
		copy(x.Fingerprint[:], r.bytes(len(x.Fingerprint)))
		copy(x.Code[:], r.bytes(len(x.Code)))
		x.Name = r.str()
		x.Network = r.str()
		x.Tailnet = r.str()
		for range int(r.byte()) {
			x.Addresses = append(x.Addresses, r.str())
		}
		inv.Boxes = append(inv.Boxes, x)
	}
	if r.bad || len(r.b) != 0 {
		return Invite{}, errMalformedInvite
	}
	if inv.Valid() != nil || !printable(inv.From) {
		return Invite{}, errMalformedInvite
	}
	for _, x := range inv.Boxes {
		if !printable(x.Tailnet) {
			return Invite{}, errMalformedInvite
		}
	}
	return inv, nil
}

type reader struct {
	b   []byte
	bad bool
}

func (r *reader) bytes(n int) []byte {
	if r.bad || len(r.b) < n {
		r.bad = true
		return make([]byte, n)
	}
	out := r.b[:n]
	r.b = r.b[n:]
	return out
}

func (r *reader) byte() byte     { return r.bytes(1)[0] }
func (r *reader) uint32() uint32 { return binary.BigEndian.Uint32(r.bytes(4)) }
func (r *reader) str() string    { return string(r.bytes(int(r.byte()))) }

var label = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)

func validLabel(s string) bool { return label.MatchString(s) }

// ValidAddress reports whether a is a host:port a join link may carry.
func ValidAddress(a string) bool {
	host, port, err := net.SplitHostPort(a)
	if err != nil || host == "" || strings.ContainsAny(host, "/?#@ ") || !printable(host) {
		return false
	}
	n, err := strconv.Atoi(port)
	return err == nil && n >= 1 && n <= 65535
}

func printable(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

var joinLink = regexp.MustCompile(`berth://join\?[^\s'"<>` + "`" + `]+`)

// FindJoinLink pulls a join link out of pasted text: a message, a terminal's
// output, or the link in quotes.
func FindJoinLink(text string) string {
	return strings.TrimRight(joinLink.FindString(text), ".,;:)]")
}
