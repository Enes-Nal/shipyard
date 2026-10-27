package boxcmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/cosscom/shipyard/internal/box"
)

// Artifacts from the command line: an agent registers a file it made for
// the person to look at, and Terminal shows it (box/artifacts.go). add's
// first line is the one the chat recognises to place the card
// (transcript/localartifacts.go): keep its form.

// ArtifactLine is add's first line: "Artifact <id> v<n> · <kind> · <title>".
func ArtifactLine(a box.Artifact) string {
	return fmt.Sprintf("Artifact %s v%d · %s · %s", a.ID, a.Latest().N, a.Kind, a.Title)
}

func artifactBase(loc, wt string) string {
	return "/v1/locations/" + url.PathEscape(loc) + "/worktrees/" + url.PathEscape(wt) + "/artifacts"
}

// artifactWorktree is the worktree a command is for: --in LOC/WT, else the
// one this shell is in.
func artifactWorktree(ctx context.Context, c *box.Client, ref string) (box.Location, box.Worktree, error) {
	dir := os.Getenv("BERTH_WORKTREE_PATH")
	if dir == "" {
		dir, _ = os.Getwd()
	}
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = resolved
	}
	return findWorktree(ctx, c, ref, dir)
}

func artifactCmd(ctx context.Context, c *box.Client, sub string, args []string, out io.Writer) error {
	switch sub {
	case "add":
		fs, asJSON := flags(args)
		title := fs.String("title", "", "what it shows, in a few words")
		kind := fs.String("kind", "", "chart, table, diagram, page or notes (default: from the file)")
		id := fs.String("id", "", "update this artifact instead of adding one")
		note := fs.String("note", "", "what changed in this version")
		by := fs.String("by", "", "a helper's name, when a helper made it")
		in := fs.String("in", "", "the worktree, LOC/WT (default: the one you're in)")
		pos, err := parse(fs, args)
		usage := `artifact add FILE --title "…" [--kind chart|table|diagram|page|notes] [--id ID] [--note "…"] [--by HELPER] [--in LOC/WT]`
		if err != nil || len(pos) != 1 {
			return usageErr(usage)
		}
		path, err := filepath.Abs(pos[0])
		if err != nil {
			return err
		}
		fi, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("can't read %s: %w", pos[0], errors.Unwrap(err))
		}
		// The box says the exact limit; this only keeps a huge file off the wire.
		if fi.Size() > 4<<20 {
			return fmt.Errorf("%s is %d KB: an artifact is at most 2 MB (a page) or 1 MB (data). Aggregate first", pos[0], fi.Size()>>10)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			path = resolved
		}
		loc, wt, err := artifactWorktree(ctx, c, *in)
		if err != nil {
			return err
		}
		req := map[string]any{
			"id": *id, "title": *title, "kind": *kind, "note": *note, "name": filepath.Base(path), "source": path,
			"content": string(content), "session": os.Getenv("BERTH_SESSION"), "agent": os.Getenv("BERTH_AGENT"), "helper": *by,
		}
		var res box.AddArtifactResult
		if err := c.Call(ctx, "POST", artifactBase(loc.Name, wt.Name), req, &res); err != nil {
			return err
		}
		return show(out, *asJSON, res, func() {
			a := res.Artifact
			line := ArtifactLine(a)
			if !res.Changed {
				line += " (no change)"
			}
			fmt.Fprintln(out, line)
			switch {
			case res.Added && a.Watched:
				fmt.Fprintf(out, "Shown in your chat and on %s's board. Rewrite %s to update it live; berthd artifact add again only to retitle or add --note.\n", wt.Name, filepath.Base(path))
			case res.Added:
				fmt.Fprintf(out, "Shown in your chat and on %s's board. Update it with --id %s.\n", wt.Name, a.ID)
			case res.Changed:
				fmt.Fprintf(out, "Version %d is live.\n", a.Latest().N)
			}
		})
	case "list", "ls":
		fs, asJSON := flags(args)
		pos, err := parse(fs, args)
		if err != nil || len(pos) > 1 {
			return usageErr("artifact list [LOC/WT] [--json]")
		}
		ref := ""
		if len(pos) == 1 {
			ref = pos[0]
		}
		loc, wt, err := artifactWorktree(ctx, c, ref)
		if err != nil {
			return err
		}
		var list []box.Artifact
		if err := c.Call(ctx, "GET", artifactBase(loc.Name, wt.Name), nil, &list); err != nil {
			return err
		}
		return show(out, *asJSON, list, func() {
			if len(list) == 0 {
				fmt.Fprintf(out, "No artifacts in %s/%s yet.\n", loc.Name, wt.Name)
				return
			}
			w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tKIND\tVERSION\tUPDATED\tFILE\tTITLE")
			for _, a := range list {
				fmt.Fprintf(w, "%s\t%s\tv%d\t%s\t%s\t%s\n", a.ID, a.Kind, a.Latest().N, ago(a.Updated), dash(a.File), a.Title)
			}
			w.Flush()
		})
	case "show":
		fs, asJSON := flags(args)
		content := fs.Bool("content", false, "print the content instead")
		version := fs.Int("version", 0, "with --content, this version (default: the latest)")
		pos, err := parse(fs, args)
		if err != nil || len(pos) != 1 {
			return usageErr("artifact show ID [--content [--version N]] [--json]")
		}
		loc, wt, err := artifactWorktree(ctx, c, "")
		if err != nil {
			return err
		}
		base := artifactBase(loc.Name, wt.Name) + "/" + url.PathEscape(pos[0])
		if *content {
			v := "latest"
			if *version > 0 {
				v = strconv.Itoa(*version)
			}
			resp, err := c.Doer.DoWithHeader(ctx, "GET", base+"/v/"+v, nil, nil)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				var e struct{ Error string }
				_ = json.NewDecoder(resp.Body).Decode(&e)
				return errors.New(firstNonEmpty(e.Error, resp.Status))
			}
			_, err = io.Copy(out, resp.Body)
			return err
		}
		var a box.Artifact
		if err := c.Call(ctx, "GET", base, nil, &a); err != nil {
			return err
		}
		return show(out, *asJSON, a, func() {
			fmt.Fprintf(out, "%s  %s\n", a.ID, a.Title)
			fmt.Fprintf(out, "  %s (%s) in %s/%s, added %s", a.Kind, a.Format, a.Location, a.Worktree, ago(a.Created))
			if a.By.Session != "" {
				fmt.Fprintf(out, " by %s", a.By.Session)
				if a.By.Helper != "" {
					fmt.Fprintf(out, " (helper: %s)", a.By.Helper)
				}
			}
			fmt.Fprintln(out)
			if a.File != "" {
				w := "watched"
				if !a.Watched {
					w = "not watched"
				}
				fmt.Fprintf(out, "  from %s, %s\n", a.File, w)
			}
			if a.Problem != "" {
				fmt.Fprintf(out, "  the latest rewrite wasn't taken: %s\n", a.Problem)
			}
			for i := len(a.Versions) - 1; i >= 0; i-- {
				v := a.Versions[i]
				line := fmt.Sprintf("  v%-3d %s  %s", v.N, ago(v.At), sizeLabel(v.Size))
				if v.Note != "" {
					line += "  " + v.Note
				}
				fmt.Fprintln(out, line)
			}
		})
	case "rm":
		fs, _ := flags(args)
		pos, err := parse(fs, args)
		if err != nil || len(pos) != 1 {
			return usageErr("artifact rm ID")
		}
		loc, wt, err := artifactWorktree(ctx, c, "")
		if err != nil {
			return err
		}
		var a box.Artifact
		if err := c.Call(ctx, "DELETE", artifactBase(loc.Name, wt.Name)+"/"+url.PathEscape(pos[0]), nil, &a); err != nil {
			return err
		}
		fmt.Fprintf(out, "Removed %s (%s)\n", a.ID, a.Title)
		return nil
	}
	return usageErr("artifact add|list|show|rm")
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func sizeLabel(n int) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	return fmt.Sprintf("%.1f KB", float64(n)/1024)
}

func ago(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
	return t.Local().Format("Jan 2")
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
