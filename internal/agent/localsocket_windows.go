package agent

import (
	"context"
	"net"
	"os"
	"strings"
)

func validateLocalSocket(string) error { return nil }

// Windows builds use a loopback listener and keep its ephemeral address in
// the same per-state socket path. This preserves independent BERTH_HOME
// instances without relying on AF_UNIX path handling on Windows.
func listenLocalSocket(path string) (net.Listener, func(), error) {
	_ = os.Remove(path)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, func() {}, err
	}
	if err := os.WriteFile(path, []byte(ln.Addr().String()+"\n"), 0o600); err != nil {
		_ = ln.Close()
		return nil, func() {}, err
	}
	return ln, func() {
		_ = ln.Close()
		_ = os.Remove(path)
	}, nil
}

func dialLocalSocket(ctx context.Context, path string) (net.Conn, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", strings.TrimSpace(string(raw)))
}
