package box

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/cosscom/shipyard/internal/agenthost"
	"github.com/cosscom/shipyard/internal/integrations/adapters"
	"github.com/cosscom/shipyard/internal/statefile"
)

// A structured agent's conversation outlives its session: its folder under
// ConversationsDir holds its log and meta.json, what it is. A session that
// ended is started again on its own log (POST /v1/sessions/{name}/resume),
// and one that is gone altogether is found again (GET /v1/conversations)
// and resumed in a new session (POST /v1/conversations/{id}/resume), with
// Claude Code's --resume: the same conversation, carried on.

// Conversation is what a structured conversation is.
type Conversation struct {
	ID    string `json:"id"`
	Agent string `json:"agent"`
	// Location and Dir are where it works; Session the session it last ran
	// in, and Live that one is running.
	Location string `json:"location,omitempty"`
	Dir      string `json:"dir"`
	Session  string `json:"session,omitempty"`
	Live     bool   `json:"live,omitempty"`
	// AgentSessionID is Claude Code's own name for it; Mode the
	// permission mode it ran in ("bypassPermissions": berthd allowed).
	AgentSessionID string `json:"agent_session_id,omitempty"`
	Mode           string `json:"mode,omitempty"`
	// Title is its first prompt's first line.
	Title   string    `json:"title,omitempty"`
	Created time.Time `json:"created"`
	Updated time.Time `json:"updated,omitzero"`
}

const metaName = "meta.json"

func (b *Box) mountConversations(route func(string, func(http.ResponseWriter, *http.Request) error)) {
	route("GET /v1/conversations", b.listConversations)
	route("POST /v1/conversations/{id}/resume", b.resumeConversation)
	route("POST /v1/sessions/{name}/resume", b.resumeSession)
}

// readConversation reads a conversation's meta.json.
func readConversation(dir string) (Conversation, bool) {
	raw, err := os.ReadFile(filepath.Join(dir, metaName))
	if err != nil {
		return Conversation{}, false
	}
	var c Conversation
	if json.Unmarshal(raw, &c) != nil {
		return Conversation{}, false
	}
	c.ID = filepath.Base(dir)
	return c, true
}

// noteConversation changes a conversation's meta.json.
func noteConversation(dir string, change func(*Conversation)) {
	c, _ := readConversation(dir)
	change(&c)
	c.ID, c.Live = "", false
	if raw, err := json.Marshal(c); err == nil {
		statefile.Write(filepath.Join(dir, metaName), raw)
	}
}

// conversationDir is the folder of conversation id, refusing anything that
// isn't one of the box's.
func (b *Box) conversationDir(id string) (string, error) {
	if b.ConversationsDir == "" || id == "" || strings.ContainsAny(id, `/\`) || strings.HasPrefix(id, ".") {
		return "", httpError{http.StatusNotFound, "no conversation " + strconv.Quote(id)}
	}
	dir := filepath.Join(b.ConversationsDir, id)
	if _, ok := readConversation(dir); !ok {
		return "", httpError{http.StatusNotFound, "no conversation " + strconv.Quote(id)}
	}
	return dir, nil
}

// listConversations answers GET /v1/conversations?path=P&location=L&limit=N:
// the structured conversations kept on the box, newest first, those that
// worked in P (or in location L, or its worktrees).
func (b *Box) listConversations(w http.ResponseWriter, r *http.Request) error {
	out := []Conversation{}
	if b.ConversationsDir == "" {
		writeJSON(w, out)
		return nil
	}
	q := r.URL.Query()
	path, location := q.Get("path"), q.Get("location")
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	live := map[string]string{}
	if sessions, err := b.Sessions.List(r.Context()); err == nil {
		for _, s := range sessions {
			if s.conv != "" && !s.Exited {
				live[s.conv] = s.Name
			}
		}
	}
	entries, _ := os.ReadDir(b.ConversationsDir)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(b.ConversationsDir, e.Name())
		c, ok := readConversation(dir)
		if !ok {
			continue
		}
		if path != "" && !sameDir(c.Dir, filepath.Clean(path)) {
			continue
		}
		if location != "" && c.Location != location && !strings.HasPrefix(c.Location, location+"/") {
			continue
		}
		if name, ok := live[dir]; ok {
			c.Live, c.Session = true, name
		}
		out = append(out, c)
	}
	slices.SortFunc(out, func(a, b Conversation) int { return lastTime(b).Compare(lastTime(a)) })
	if len(out) > limit {
		out = out[:limit]
	}
	writeJSON(w, out)
	return nil
}

func lastTime(c Conversation) time.Time {
	if c.Updated.After(c.Created) {
		return c.Updated
	}
	return c.Created
}

// resumeSession answers POST /v1/sessions/{name}/resume: a structured
// session whose agent ended starts again on its own log, carrying its
// conversation on.
func (b *Box) resumeSession(w http.ResponseWriter, r *http.Request) error {
	name := r.PathValue("name")
	sess, err := b.Sessions.Get(r.Context(), name)
	if err != nil {
		return err
	}
	if sess.conv == "" {
		return httpError{http.StatusConflict, name + " isn't a structured session: start its agent again instead"}
	}
	if !sess.Exited {
		return httpError{http.StatusConflict, name + " is still running"}
	}
	if err := b.before(r, "session.start", map[string]any{"name": name, "location": sess.Location, "path": sess.Dir, "resume": true}); err != nil {
		return err
	}
	if sess.Driver == "" {
		// Left in Claude Code's terminal: back to its chat, with what was
		// said there.
		err = b.toChat(r, sess)
	} else {
		err = b.resumeInPlace(r, sess, "")
	}
	if err != nil {
		return err
	}
	b.publish(r, "session.resumed", map[string]any{"name": name})
	sess, err = b.Sessions.Get(r.Context(), name)
	if err != nil {
		return err
	}
	writeJSON(w, b.enrich(r.Context(), []Session{sess})[0])
	return nil
}

// resumeInPlace starts a structured session's host again in its own pane,
// on its log and socket, with --resume (sid, or the one its log names).
func (b *Box) resumeInPlace(r *http.Request, sess Session, sid string) error {
	ctx := r.Context()
	if sid == "" {
		sid = conversationSession(sess.conv)
	}
	if sid == "" {
		return httpError{http.StatusConflict, "berthd doesn't know which Claude conversation this is"}
	}
	l, err := b.launchClaudeIn(b.claudePreset(ctx, sess), "", "", modeFor(sess), sid, sess.conv, sess.sock)
	if err != nil {
		return err
	}
	l.labels[labelHandoff] = ""
	b.claude().forget(sess.Name)
	if err := b.respawnAgent(ctx, sess, l.command, l.env, l.labels); err != nil {
		return err
	}
	noteResumed(sess.conv, sess.Name)
	// Back when it listens, so what is sent next reaches it.
	awaitHost(sess.sock, 15*time.Second)
	if live, err := b.Sessions.Get(ctx, sess.Name); err == nil {
		b.startStructured(origin(r), gateOrigin(r), live, "")
	}
	return nil
}

// conversationSession is the Claude conversation a structured
// conversation's folder carries on: from its meta, else its log.
func conversationSession(dir string) string {
	if c, ok := readConversation(dir); ok && c.AgentSessionID != "" {
		return c.AgentSessionID
	}
	return lastSessionID(filepath.Join(dir, agenthost.LogName))
}

// resumeConversation answers POST /v1/conversations/{id}/resume {open?}:
// the session it runs in, started again when it ended, or a new one when
// it is gone.
func (b *Box) resumeConversation(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Open string `json:"open,omitempty"`
	}
	if r.ContentLength > 0 {
		if err := decode(r, &req); err != nil {
			return err
		}
	}
	dir, err := b.conversationDir(r.PathValue("id"))
	if err != nil {
		return err
	}
	conv, _ := readConversation(dir)
	sessions, err := b.Sessions.List(r.Context())
	if err != nil {
		return err
	}
	for _, s := range sessions {
		if s.conv != dir {
			continue
		}
		if s.Exited {
			if s.Driver == "" {
				err = b.toChat(r, s)
			} else {
				err = b.resumeInPlace(r, s, "")
			}
			if err != nil {
				return err
			}
			if s, err = b.Sessions.Get(r.Context(), s.Name); err != nil {
				return err
			}
		}
		s = b.enrich(r.Context(), []Session{s})[0]
		b.announceOpen(r, s, req.Open)
		writeJSON(w, s)
		return nil
	}
	if st, err := os.Stat(conv.Dir); err != nil || !st.IsDir() {
		return httpError{http.StatusGone, "the folder it worked in, " + conv.Dir + ", is gone"}
	}
	sid := conversationSession(dir)
	if sid == "" {
		return httpError{http.StatusConflict, "berthd doesn't know which Claude conversation this is"}
	}
	sock, err := hostSocket(filepath.Base(dir))
	if err != nil {
		return err
	}
	p := b.claudePreset(r.Context(), Session{Location: conv.Location})
	l, err := b.launchClaudeIn(p, "", "", conv.Mode, sid, dir, sock)
	if err != nil {
		return err
	}
	name := defaultSessionName(firstNonEmpty(conv.Location, filepath.Base(conv.Dir)), p.Command)
	sess, err := b.startStructuredSession(r, name, conv.Location, conv.Dir, "claude", l, "")
	if err != nil {
		return err
	}
	if conv.Title != "" {
		b.nameAfter(r.Context(), sess.Name, conv.Title)
		sess.Title = conv.Title
	}
	b.announceOpen(r, sess, req.Open)
	writeJSON(w, sess)
	return nil
}

// noteStarted keeps what a new structured conversation is.
func noteStarted(dir, location, cwd, session, mode, prompt string) {
	noteConversation(dir, func(c *Conversation) {
		c.Agent, c.Location, c.Dir, c.Session = "claude", location, cwd, session
		if mode != "" {
			c.Mode = mode
		}
		if c.Created.IsZero() {
			c.Created = time.Now().UTC()
		}
		if c.Title == "" && strings.TrimSpace(prompt) != "" {
			c.Title = adapters.Clip(adapters.Title(prompt), adapters.TitleMax)
		}
	})
}

// noteResumed marks a conversation as running in session now.
func noteResumed(dir, session string) {
	noteConversation(dir, func(c *Conversation) {
		c.Session, c.Updated = session, time.Now().UTC()
	})
}
