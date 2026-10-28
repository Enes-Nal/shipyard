//go:build !windows

package agent

import (
	"context"
	"fmt"
	"net"
	"os"
)

func validateLocalSocket(path string) error {
	if len(path) > 100 {
		return fmt.Errorf("agent socket path %s is too long for a Unix socket; set a shorter BERTH_HOME", path)
	}
	return nil
}

func listenLocalSocket(path string) (net.Listener, func(), error) {
	// Holding the agent lock means any socket file left here is stale.
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, func() {}, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		return nil, func() {}, err
	}
	return ln, func() {
		_ = ln.Close()
		_ = os.Remove(path)
	}, nil
}

func dialLocalSocket(ctx context.Context, path string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", path)
}
