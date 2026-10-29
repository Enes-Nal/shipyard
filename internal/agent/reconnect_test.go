package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestBackoffDoublesToItsLimitWithJitter(t *testing.T) {
	base, limit := 2*time.Second, 10*time.Second
	for attempt, want := range map[int]time.Duration{0: 2 * time.Second, 1: 2 * time.Second, 2: 4 * time.Second, 3: 8 * time.Second, 4: 10 * time.Second, 9: 10 * time.Second, 60: 10 * time.Second} {
		seen := map[time.Duration]bool{}
		for range 50 {
			d := backoff(attempt, base, limit)
			if d < want*8/10 || d > want*12/10 {
				t.Fatalf("attempt %d: %s, want %s ± 20%%", attempt, d, want)
			}
			seen[d] = true
		}
		// Jitter: laptops that lost the network together don't retry in step.
		if len(seen) < 10 {
			t.Fatalf("attempt %d: only %d distinct waits in 50", attempt, len(seen))
		}
	}
}

func TestAnAwayBoxIsRetriedOnABackoffAndAnsweredForAtOnce(t *testing.T) {
	b := newBox(t)
	dir := b.pairLaptop()
	a := startAgent(t, dir)
	tok := uiToken(t, a)
	eventually(t, "box online", func() bool { return stateOf(t, a) == StateOnline })

	addr := b.address
	b.stop()
	var st BoxStatus
	eventually(t, "box offline with its next try", func() bool {
		s, err := a.client.Status(context.Background())
		if err != nil || len(s.Boxes) != 1 {
			return false
		}
		st = s.Boxes[0]
		return st.State == StateOffline && st.RetryAt != nil && st.Attempts >= 1
	})
	// Tried again on its own, more than once, while away.
	eventually(t, "more tries", func() bool {
		s, _ := a.client.Status(context.Background())
		return len(s.Boxes) == 1 && s.Boxes[0].Attempts >= 3
	})

	// A request for it answers at once, saying it is reconnecting, rather
	// than waiting out a dial.
	start := time.Now()
	resp, body := uiCall(t, a, "GET", "/v1/boxes/devbox/api/services", tok)
	if took := time.Since(start); took > time.Second {
		t.Fatalf("an away box's request took %s", took)
	}
	var e struct{ Error, Code string }
	json.Unmarshal([]byte(body), &e)
	if resp.StatusCode != http.StatusServiceUnavailable || e.Code != "box_unreachable" || !strings.Contains(e.Error, "devbox is offline; Terminal is reconnecting") {
		t.Fatalf("away answer %d %s", resp.StatusCode, body)
	}

	// Back: online at its next try, and its backoff forgotten.
	b.start(addr)
	eventually(t, "box back online", func() bool { return stateOf(t, a) == StateOnline })
	s, _ := a.client.Status(context.Background())
	if s.Boxes[0].RetryAt != nil || s.Boxes[0].Attempts != 0 {
		t.Fatalf("an online box keeps its backoff: %+v", s.Boxes[0])
	}
	if resp, body := uiCall(t, a, "GET", "/v1/boxes/devbox/api/services", tok); resp.StatusCode != http.StatusOK {
		t.Fatalf("after it came back: %d %s", resp.StatusCode, body)
	}
}

func TestTryNowChecksTheOneBox(t *testing.T) {
	b := newBox(t)
	dir := b.pairLaptop()
	a := startAgent(t, dir)
	tok := uiToken(t, a)
	eventually(t, "box online", func() bool { return stateOf(t, a) == StateOnline })
	b.stop()
	resp, body := uiCall(t, a, "POST", "/v1/refresh?box=devbox", tok)
	var s Status
	json.Unmarshal([]byte(body), &s)
	if resp.StatusCode != http.StatusOK || len(s.Boxes) != 1 || s.Boxes[0].State != StateOffline {
		t.Fatalf("try now: %d %s", resp.StatusCode, body)
	}
}
