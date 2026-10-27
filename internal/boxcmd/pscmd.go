package boxcmd

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/box"
)

// ps lists the box's browsers and what sessions use, or stops one.
func ps(ctx context.Context, c *box.Client, args []string, out io.Writer) error {
	if len(args) > 0 && args[0] == "stop" {
		if len(args) != 2 {
			return usageErr("ps stop ID")
		}
		var res struct {
			Text string `json:"text"`
		}
		if err := c.Call(ctx, "POST", "/v1/processes/"+url.PathEscape(args[1])+"/stop", nil, &res); err != nil {
			return err
		}
		fmt.Fprintln(out, res.Text)
		return nil
	}
	fs, asJSON := flags(args)
	if pos, err := parse(fs, args); err != nil || len(pos) > 0 {
		return usageErr("ps [--json] | ps stop ID")
	}
	var list box.BoxProcesses
	if err := c.Call(ctx, "GET", "/v1/processes", nil, &list); err != nil {
		return err
	}
	return show(out, *asJSON, list, func() { printProcesses(out, list) })
}

func printProcesses(out io.Writer, list box.BoxProcesses) {
	if len(list.Browsers) == 0 {
		fmt.Fprintln(out, "No browsers running.")
	} else {
		fmt.Fprintln(out, "Browsers")
		for _, b := range list.Browsers {
			stop := b.ID
			if !b.Stoppable {
				stop = "(not Terminal's)"
			}
			fmt.Fprintf(out, "  %-44s %5.0f%% CPU  %8s  %4s  %d proc  %s\n", clip(b.Label, 44), b.CPUPercent, mem(b.Memory), since(b.Started), b.Processes, stop)
		}
	}
	if len(list.Sessions) > 0 {
		fmt.Fprintln(out, "Sessions")
		for _, s := range list.Sessions {
			where := s.Name
			if s.Location != "" {
				where = s.Location + " (" + s.Name + ")"
			}
			limit := ""
			if s.Usage.MemoryHigh > 0 {
				limit = " of " + mem(s.Usage.MemoryHigh)
				if s.Usage.NearLimit {
					limit += ", near its limit"
				}
			}
			fmt.Fprintf(out, "  %-44s %5.0f%% CPU  %8s%s  %d proc  s-%s\n", clip(where, 44), s.Usage.CPUPercent, mem(s.Usage.Memory), limit, s.Usage.Processes, s.Name)
		}
	}
	if !list.Scopes {
		fmt.Fprintln(out, "Sessions here have no systemd scope: ending one stops the processes Terminal finds for it.")
	}
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func mem(n uint64) string {
	if n >= 1<<30 {
		return strings.TrimSuffix(fmt.Sprintf("%.1f", float64(n)/(1<<30)), ".0") + " GB"
	}
	return fmt.Sprintf("%d MB", n>>20)
}

func since(t time.Time) string {
	if t.IsZero() {
		return "?"
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}
