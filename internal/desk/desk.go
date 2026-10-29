package desk

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/cosscom/shipyard/internal/transcript"
)

// Desk holds the projects and chats and runs the chats' turns.
type Desk struct {
	st     *store
	reader *transcript.Reader
	// findAgent finds the agent's executable (findClaude; tests swap it).
	findAgent func() (string, error)

	mu sync.Mutex
	// running is the chat working in each project, by project id.
	running map[string]string
	turns   map[string]*running
	// queue is what waits for each project, oldest first.
	queue map[string][]queued
	// failed is why each chat's last turn didn't finish, if it didn't.
	failed map[string]string

	subMu sync.Mutex
	subs  map[chan Event]struct{}
}

type running struct {
	t       *turn
	stopped bool
	since   int64
}

type queued struct {
	Chat   string
	Text   string
	Branch string // a new branch to start on, for a chat's first message
}

// Event tells the app something changed: "state" (the lists, a chat's
// status, a branch) or "items" (a chat's transcript grew).
type Event struct {
	Type string `json:"type"`
	Chat string `json:"chat,omitempty"`
}

// Open opens the desk whose state is kept in dir.
func Open(dir string) (*Desk, error) {
	st, err := openStore(filepath.Join(dir, "desk.json"))
	if err != nil {
		return nil, err
	}
	return &Desk{st: st, reader: transcript.NewReader(), findAgent: findClaude,
		running: map[string]string{}, turns: map[string]*running{}, queue: map[string][]queued{}, failed: map[string]string{},
		subs: map[chan Event]struct{}{}}, nil
}

// ProjectView is a project as the sidebar shows it.
type ProjectView struct {
	Project
	Repo    bool   `json:"repo"`
	Branch  string `json:"branch,omitempty"`
	Dirty   bool   `json:"dirty,omitempty"`
	Running string `json:"running,omitempty"`
	Missing bool   `json:"missing,omitempty"`
}

// ChatView is a chat with what it is doing now.
type ChatView struct {
	Chat
	// Status is "running", "queued" (waiting for the project) or "idle".
	Status string `json:"status"`
	// Since is when the running turn started (Unix ms).
	Since  int64    `json:"since,omitempty"`
	Queued []string `json:"queued,omitempty"`
	Error  string   `json:"error,omitempty"`
}

// State is everything the app's sidebar draws.
type State struct {
	Projects []ProjectView `json:"projects"`
	Chats    []ChatView    `json:"chats"`
}

func (d *Desk) State() State {
	s := d.st.snapshot()
	d.mu.Lock()
	defer d.mu.Unlock()
	out := State{Projects: []ProjectView{}, Chats: []ChatView{}}
	for _, p := range s.Projects {
		v := ProjectView{Project: p, Running: d.running[p.ID]}
		if _, err := os.Stat(p.Path); err != nil {
			v.Missing = true
		} else if isRepo(p.Path) {
			v.Repo, v.Branch, v.Dirty = true, currentBranch(p.Path), dirty(p.Path)
		}
		out.Projects = append(out.Projects, v)
	}
	for _, c := range s.Chats {
		out.Chats = append(out.Chats, d.viewLocked(c))
	}
	return out
}

func (d *Desk) viewLocked(c Chat) ChatView {
	v := ChatView{Chat: c, Status: "idle", Error: d.failed[c.ID]}
	for _, q := range d.queue[c.Project] {
		if q.Chat == c.ID {
			v.Queued = append(v.Queued, q.Text)
		}
	}
	switch {
	case d.running[c.Project] == c.ID:
		v.Status = "running"
		if r := d.turns[c.ID]; r != nil {
			v.Since = r.since
		}
	case len(v.Queued) > 0:
		v.Status = "queued"
	}
	return v
}

// AddProject adds the folder at path; it needn't be a git repository.
func (d *Desk) AddProject(path string) (Project, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return Project{}, errors.New("pick a folder")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return Project{}, err
	}
	if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
		return Project{}, fmt.Errorf("%s isn't a folder on this PC", abs)
	}
	for _, p := range d.st.snapshot().Projects {
		if strings.EqualFold(p.Path, abs) {
			return p, nil
		}
	}
	p := Project{ID: newID(), Name: filepath.Base(abs), Path: abs, Added: now()}
	if err := d.st.addProject(p); err != nil {
		return Project{}, err
	}
	d.publish(Event{Type: "state"})
	return p, nil
}

func (d *Desk) RemoveProject(id string) error {
	d.mu.Lock()
	busy := d.running[id] != ""
	d.mu.Unlock()
	if busy {
		return errors.New("a chat is working in this project; stop it first")
	}
	if err := d.st.removeProject(id); err != nil {
		return err
	}
	d.mu.Lock()
	delete(d.queue, id)
	d.mu.Unlock()
	d.publish(Event{Type: "state"})
	return nil
}

// NewChat starts an empty chat in project; its first message runs it.
func (d *Desk) NewChat(project, access string) (Chat, error) {
	if _, ok := d.st.project(project); !ok {
		return Chat{}, errors.New("that project is gone")
	}
	if access != "edits" {
		access = "full"
	}
	t := now()
	c := Chat{ID: newID(), Project: project, Agent: "claude", Session: newUUID(), Access: access, Created: t, Updated: t}
	if err := d.st.addChat(c); err != nil {
		return Chat{}, err
	}
	d.publish(Event{Type: "state"})
	return c, nil
}

// ChatPatch is what an edit to a chat changes; nil fields stay.
type ChatPatch struct {
	Title  *string `json:"title"`
	Access *string `json:"access"`
}

func (d *Desk) UpdateChat(id string, p ChatPatch) (Chat, error) {
	c, ok, err := d.st.updateChat(id, func(c *Chat) {
		if p.Title != nil {
			c.Title = strings.TrimSpace(*p.Title)
		}
		if p.Access != nil && (*p.Access == "full" || *p.Access == "edits") {
			c.Access = *p.Access
		}
	})
	if !ok {
		return Chat{}, errors.New("that chat is gone")
	}
	d.publish(Event{Type: "state"})
	return c, err
}

func (d *Desk) RemoveChat(id string) error {
	c, ok := d.st.chat(id)
	if !ok {
		return nil
	}
	d.mu.Lock()
	if d.running[c.Project] == id {
		d.mu.Unlock()
		return errors.New("this chat is working; stop it first")
	}
	q := d.queue[c.Project][:0]
	for _, it := range d.queue[c.Project] {
		if it.Chat != id {
			q = append(q, it)
		}
	}
	d.queue[c.Project] = q
	delete(d.failed, id)
	d.mu.Unlock()
	if err := d.st.removeChat(id); err != nil {
		return err
	}
	d.publish(Event{Type: "state"})
	return nil
}

// Send gives a chat its next message. It runs now when the project is
// free, and otherwise waits its turn (queued is true). branch, on a chat's
// first message, is a new branch to make for it.
func (d *Desk) Send(chatID, text, branch string) (queuedNow bool, err error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return false, errors.New("write a message first")
	}
	c, ok := d.st.chat(chatID)
	if !ok {
		return false, errors.New("that chat is gone")
	}
	if c.Started {
		branch = ""
	}
	if c.Title == "" {
		c, _, _ = d.st.updateChat(chatID, func(c *Chat) { c.Title = titleFor(text) })
	}
	d.mu.Lock()
	defer func() {
		d.mu.Unlock()
		d.publish(Event{Type: "state"})
	}()
	delete(d.failed, chatID)
	if d.running[c.Project] != "" {
		d.queue[c.Project] = append(d.queue[c.Project], queued{Chat: chatID, Text: text, Branch: branch})
		return true, nil
	}
	return false, d.startLocked(c, text, branch)
}

// Stop ends a chat's turn, and drops what it had waiting.
func (d *Desk) Stop(chatID string) {
	c, ok := d.st.chat(chatID)
	if !ok {
		return
	}
	d.mu.Lock()
	q := d.queue[c.Project][:0]
	for _, it := range d.queue[c.Project] {
		if it.Chat != chatID {
			q = append(q, it)
		}
	}
	d.queue[c.Project] = q
	r := d.turns[chatID]
	if r != nil {
		r.stopped = true
	}
	d.mu.Unlock()
	if r != nil {
		r.t.stop()
	}
	d.publish(Event{Type: "state"})
}

// startLocked runs a turn of c, on its branch. d.mu is held.
func (d *Desk) startLocked(c Chat, text, branch string) error {
	p, ok := d.st.project(c.Project)
	if !ok {
		return errors.New("that project is gone")
	}
	repo := isRepo(p.Path)
	switch {
	case repo && branch != "":
		from := currentBranch(p.Path)
		if err := createBranch(p.Path, branch); err != nil {
			return err
		}
		c, _, _ = d.st.updateChat(c.ID, func(c *Chat) {
			c.Branch = branch
			c.Moves = append(c.Moves, Move{Kind: "created", From: from, To: branch, At: now()})
		})
	case repo && c.Branch != "":
		if err := switchTo(p.Path, c.Branch); err != nil {
			return err
		}
	case repo:
		b := currentBranch(p.Path)
		c, _, _ = d.st.updateChat(c.ID, func(c *Chat) { c.Branch = b })
	}
	exe, err := d.findAgent()
	if err != nil {
		return err
	}
	t, err := startTurn(exe, p.Path, c, text)
	if err != nil {
		return fmt.Errorf("couldn't start Claude Code: %w", err)
	}
	d.running[p.ID] = c.ID
	d.turns[c.ID] = &running{t: t, since: now()}
	go d.watch(p, c, t)
	return nil
}

// watch follows a turn: it says when the transcript grows, and once the
// turn ends it notes branch changes and starts what waits next.
func (d *Desk) watch(p Project, c Chat, t *turn) {
	path := d.transcriptPath(p, c)
	var size int64 = -1
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for done := false; !done; {
		select {
		case <-t.done:
			done = true
		case <-tick.C:
		}
		if fi, err := os.Stat(path); err == nil && fi.Size() != size {
			size = fi.Size()
			d.publish(Event{Type: "items", Chat: c.ID})
		}
	}
	_, started := os.Stat(path)
	b := ""
	if isRepo(p.Path) {
		b = currentBranch(p.Path)
	}
	d.st.updateChat(c.ID, func(ch *Chat) {
		ch.Started = ch.Started || started == nil
		if b != "" && ch.Branch != "" && b != ch.Branch {
			ch.Moves = append(ch.Moves, Move{Kind: "switched", From: ch.Branch, To: b, At: now()})
			ch.Branch = b
		}
	})

	d.mu.Lock()
	if r := d.turns[c.ID]; r != nil && !r.stopped {
		if f := t.failure(); f != "" {
			d.failed[c.ID] = f
		}
	}
	delete(d.turns, c.ID)
	delete(d.running, p.ID)
	for len(d.queue[p.ID]) > 0 {
		next := d.queue[p.ID][0]
		d.queue[p.ID] = d.queue[p.ID][1:]
		nc, ok := d.st.chat(next.Chat)
		if !ok {
			continue
		}
		if err := d.startLocked(nc, next.Text, next.Branch); err != nil {
			d.failed[nc.ID] = err.Error()
			continue
		}
		break
	}
	d.mu.Unlock()
	d.publish(Event{Type: "items", Chat: c.ID})
	d.publish(Event{Type: "state"})
}

func (d *Desk) transcriptPath(p Project, c Chat) string {
	return filepath.Join(transcript.ClaudeDir(p.Path), c.Session+".jsonl")
}

// Items reads a chat's conversation from index since, as the app's
// conversation view takes it (internal/transcript).
func (d *Desk) Items(chatID string, since int, gen string) (transcript.Result, error) {
	c, ok := d.st.chat(chatID)
	if !ok {
		return transcript.Result{}, errors.New("that chat is gone")
	}
	p, ok := d.st.project(c.Project)
	if !ok {
		return transcript.Result{}, errors.New("that project is gone")
	}
	path := d.transcriptPath(p, c)
	if _, err := os.Stat(path); err != nil {
		return transcript.Result{Source: "claude", Items: []transcript.Item{}, Crew: []transcript.CrewMember{}}, nil
	}
	res, err := d.reader.Follow("claude", path, p.Path, since, gen)
	// Nothing new is an empty list, not null.
	if res.Items == nil {
		res.Items = []transcript.Item{}
	}
	if res.Crew == nil {
		res.Crew = []transcript.CrewMember{}
	}
	return res, err
}

// Subscribe hears every event until cancel.
func (d *Desk) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 64)
	d.subMu.Lock()
	d.subs[ch] = struct{}{}
	d.subMu.Unlock()
	return ch, func() {
		d.subMu.Lock()
		delete(d.subs, ch)
		d.subMu.Unlock()
	}
}

func (d *Desk) publish(e Event) {
	d.subMu.Lock()
	defer d.subMu.Unlock()
	for ch := range d.subs {
		select {
		case ch <- e:
		default: // a reader that fell behind gets the next event
		}
	}
}

// StopAll ends every turn, as the desk shuts down.
func (d *Desk) StopAll() {
	d.mu.Lock()
	var ts []*turn
	for _, r := range d.turns {
		r.stopped = true
		ts = append(ts, r.t)
	}
	d.queue = map[string][]queued{}
	d.mu.Unlock()
	for _, t := range ts {
		t.stop()
	}
}

// titleFor is a chat's title from its first message: its first line, cut
// at a word near 60 characters.
func titleFor(text string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	line = strings.TrimSpace(line)
	if r := []rune(line); len(r) > 60 {
		cut := string(r[:60])
		if i := strings.LastIndex(cut, " "); i > 30 {
			cut = cut[:i]
		}
		line = cut + "…"
	}
	return line
}
