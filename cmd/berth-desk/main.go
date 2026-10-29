// Command berth-desk is Shipyard's backend on Windows (internal/desk): the
// app starts it, reads one line from its stdout saying where it listens and
// with what token, and ends it by closing its stdin. Run by hand, it stops
// on Ctrl+C.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/cosscom/shipyard/internal/desk"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:1380", "where to listen (loopback only)")
	dir := flag.String("state", "", "folder for the desk's state (default: the user config folder's Shipyard)")
	watchStdin := flag.Bool("stdin", false, "exit when stdin closes, as when the app that started it ends")
	flag.Parse()

	if *dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			log.Fatal(err)
		}
		*dir = filepath.Join(base, "Shipyard")
	}
	d, err := desk.Open(*dir)
	if err != nil {
		log.Fatalf("berth-desk: %v", err)
	}
	token := os.Getenv("BERTH_DESK_TOKEN")
	if token == "" {
		b := make([]byte, 24)
		_, _ = rand.Read(b)
		token = hex.EncodeToString(b)
	}
	host, _, err := net.SplitHostPort(*addr)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		log.Fatalf("berth-desk: %s isn't a loopback address", *addr)
	}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("berth-desk: %v", err)
	}
	srv := &http.Server{Handler: d.Handler(token), ReadHeaderTimeout: 10 * time.Second}
	ready, _ := json.Marshal(map[string]string{"url": "http://" + ln.Addr().String(), "token": token})
	fmt.Println(string(ready))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if *watchStdin {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop()
		}()
	}
	go func() {
		<-ctx.Done()
		d.StopAll()
		shut, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shut)
	}()
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("berth-desk: %v", err)
	}
}
