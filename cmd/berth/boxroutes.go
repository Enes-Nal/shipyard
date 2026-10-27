package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/cosscom/shipyard/internal/agent"
	"github.com/cosscom/shipyard/internal/doctor"
)

// activeRoute names the route a box's requests take, as `berth boxes`
// shows it: "SSH", or "-" before the agent knows.
func activeRoute(b agent.BoxStatus) string {
	for _, r := range b.Routes {
		if r.Active {
			return r.Label
		}
	}
	return "-"
}

// routeChecks list a box's routes for `berth doctor BOX`: each with how it
// is doing, the one in use marked.
func routeChecks(b agent.BoxStatus) []doctor.Check {
	area := "Routes to " + b.Name
	var checks []doctor.Check
	for _, r := range b.Routes {
		name := r.Label
		if r.Detail != "" {
			name += " (" + r.Detail + ")"
		}
		c := doctor.Check{Area: area, Name: name}
		var words []string
		if r.LatencyMs > 0 {
			words = append(words, fmt.Sprintf("%d ms", r.LatencyMs))
		}
		switch r.State {
		case "up":
			c.Status = doctor.OK
		case "stalled", "down":
			c.Status = doctor.Warn
			words = append(words, r.State)
			if r.Error != "" {
				words = append(words, r.Error)
			}
			if r.Kind == "ssh" {
				c.Fix = "ssh " + r.Detail + "  (check it logs in without asking anything)"
			}
		case "off":
			c.Status = doctor.Info
			words = append(words, "off")
			if r.Suggested {
				words = append(words, "found in ~/.ssh/config")
			}
			c.Fix = "turn it on in Terminal: Settings › Boxes"
		default:
			c.Status = doctor.Info
			words = append(words, "not tried yet (measured while the box is in use)")
		}
		if r.Active {
			words = append(words, "in use")
		}
		c.Detail = strings.Join(words, ", ")
		checks = append(checks, c)
	}
	return checks
}

// boxRouteChecks asks the agent, when it runs, how it reaches box.
func boxRouteChecks(l laptop, box string) []doctor.Check {
	c := agent.NewClient(l.socket())
	s, err := c.Status(context.Background())
	if err != nil {
		return nil
	}
	for _, b := range s.Boxes {
		if b.Name == box {
			return routeChecks(b)
		}
	}
	return nil
}
