package agent

import (
	"context"
	"io"
	"path/filepath"
	"testing"
)

func TestWindowsLocalSocketUsesAPerStateLoopbackEndpoint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.sock")
	ln, cleanup, err := listenLocalSocket(path)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()

	done := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		buf := make([]byte, 4)
		if _, err := io.ReadFull(conn, buf); err != nil {
			done <- err
			return
		}
		_, err = conn.Write([]byte("pong"))
		done <- err
	}()

	conn, err := dialLocalSocket(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 4)
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != "pong" {
		t.Fatalf("reply = %q, want pong", got)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
