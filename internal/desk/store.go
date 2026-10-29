// Package desk is Shipyard's Windows-native backend: the projects you added,
// the chats in each, and the agent each chat runs, right in the project's
// own folder (no worktrees, no box, no tmux). A project runs one chat at a
// time; a message sent while another chat works there waits its turn.
//
// What a chat says is never stored here: the agent keeps its own record
// (Claude Code's transcript) and the app reads it through internal/transcript.
// This package keeps only the list of projects and chats.
package desk

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Project is a folder you work in.
type Project struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Path  string `json:"path"`
	Added int64  `json:"added"`
}

// Chat is one conversation with an agent in a project.
type Chat struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	Title   string `json:"title"`
	// Agent is the CLI this chat runs: "claude" for now.
	Agent string `json:"agent"`
	// Session is the agent's own conversation id (Claude Code's
	// --session-id), and Started whether its first turn ran.
	Session string `json:"session"`
	Started bool   `json:"started,omitempty"`
	// Branch is the branch this chat works on: the folder is switched to it
	// before each turn, and it follows the agent when the agent moves on.
	Branch string `json:"branch,omitempty"`
	// Moves are the branch changes this chat made, oldest first.
	Moves []Move `json:"moves,omitempty"`
	// Access is what the agent may do without asking: "full" (any tool) or
	// "edits" (edit files; anything else is refused).
	Access  string `json:"access"`
	Created int64  `json:"created"`
	Updated int64  `json:"updated"`
}

// Move is a branch change: one the chat started on (Kind "created") or one
// the agent made during a turn ("switched").
type Move struct {
	Kind string `json:"kind"`
	From string `json:"from,omitempty"`
	To   string `json:"to"`
	At   int64  `json:"at"`
}

type state struct {
	Projects []Project `json:"projects"`
	Chats    []Chat    `json:"chats"`
}

// store keeps the state in one JSON file, written whole on each change.
type store struct {
	mu   sync.Mutex
	path string
	s    state
}

func openStore(path string) (*store, error) {
	st := &store{path: path}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &st.s); err != nil {
		return nil, err
	}
	return st, nil
}

// save writes the state beside its file and renames it into place, so a
// crash mid-write leaves the old one.
func (st *store) save() error {
	b, err := json.MarshalIndent(st.s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(st.path), 0o700); err != nil {
		return err
	}
	tmp := st.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, st.path)
}

func (st *store) snapshot() state {
	st.mu.Lock()
	defer st.mu.Unlock()
	return state{Projects: append([]Project{}, st.s.Projects...), Chats: append([]Chat{}, st.s.Chats...)}
}

func (st *store) project(id string) (Project, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, p := range st.s.Projects {
		if p.ID == id {
			return p, true
		}
	}
	return Project{}, false
}

func (st *store) chat(id string) (Chat, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, c := range st.s.Chats {
		if c.ID == id {
			return c, true
		}
	}
	return Chat{}, false
}

func (st *store) addProject(p Project) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.s.Projects = append(st.s.Projects, p)
	return st.save()
}

// removeProject takes a project and its chats off the list; the folder and
// the agents' own records stay.
func (st *store) removeProject(id string) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	ps := st.s.Projects[:0]
	for _, p := range st.s.Projects {
		if p.ID != id {
			ps = append(ps, p)
		}
	}
	st.s.Projects = ps
	cs := st.s.Chats[:0]
	for _, c := range st.s.Chats {
		if c.Project != id {
			cs = append(cs, c)
		}
	}
	st.s.Chats = cs
	return st.save()
}

func (st *store) addChat(c Chat) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.s.Chats = append(st.s.Chats, c)
	return st.save()
}

// updateChat changes a chat in place; false when it is gone.
func (st *store) updateChat(id string, fn func(*Chat)) (Chat, bool, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for i := range st.s.Chats {
		if st.s.Chats[i].ID == id {
			fn(&st.s.Chats[i])
			st.s.Chats[i].Updated = now()
			return st.s.Chats[i], true, st.save()
		}
	}
	return Chat{}, false, nil
}

func (st *store) removeChat(id string) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	cs := st.s.Chats[:0]
	for _, c := range st.s.Chats {
		if c.ID != id {
			cs = append(cs, c)
		}
	}
	st.s.Chats = cs
	return st.save()
}

func now() int64 { return time.Now().UnixMilli() }

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// newUUID is a random (version 4) UUID, as Claude Code's --session-id takes.
func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
