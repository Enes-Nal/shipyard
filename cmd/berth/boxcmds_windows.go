package main

import (
	"errors"
	"strings"

	"github.com/cosscom/shipyard/internal/wire"
)

func splitBox(args []string, words int) (string, []string, error) {
	needSlash := words == 2 && !(len(args) > 1 && (args[1] == "kill" || args[1] == "screen" || args[1] == "import" || (args[0] == "browser" && (args[1] == "allow" || args[1] == "list")))) && args[0] != "secret"
	for i := words; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			break
		}
		if strings.HasPrefix(a, "-") || (needSlash && !strings.Contains(a, "/")) {
			continue
		}
		name, rest, hasRest := strings.Cut(a, "/")
		out := append([]string{}, args[:i]...)
		if hasRest {
			out = append(out, rest)
		}
		out = append(out, args[i+1:]...)
		return name, out, nil
	}
	return "", nil, errors.New("which box? put it first, e.g. devl or devl/shop")
}

// boxClient is platform independent; keep it available on Windows even though
// the interactive Unix-terminal commands are not.
func (l laptop) boxClient(name string) (*wire.Client, error) {
	peer, ok, err := l.boxes().ByName(name)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("no paired box named " + name)
	}
	id, err := l.identity()
	if err != nil {
		return nil, err
	}
	dial, err := networkDialer(l, peer.Network)
	if err != nil {
		return nil, err
	}
	return wire.NewClientVia(id, peer, dial), nil
}

func runOnBox(l laptop, args []string) error {
	return errors.New("this box command is not available in the Windows build yet")
}

func attach(l laptop, args []string) error {
	return errors.New("interactive session attachment is not available in the Windows build yet")
}

func openTerminal(args []string) error {
	return errors.New("opening an attached box terminal is not available in the Windows build yet")
}

// These helpers remain here for code that formats project locations.
func boxPath(path, laptopHome string) string {
	if laptopHome == "" {
		return path
	}
	if path == laptopHome {
		return "~"
	}
	if rest, ok := strings.CutPrefix(path, laptopHome+"/"); ok {
		return "~/" + rest
	}
	return path
}
