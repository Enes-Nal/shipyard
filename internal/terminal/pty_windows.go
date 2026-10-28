package terminal

import (
	"errors"
	"os"
	"os/exec"

	"golang.org/x/term"
)

func Start(_ *exec.Cmd, _, _ int) (*os.File, error) {
	return nil, errors.New("starting a local pseudo-terminal is not supported on Windows")
}

func Resize(_ *os.File, _, _ int) error { return nil }

func Size(fd uintptr) (cols, rows int, err error) { return term.GetSize(int(fd)) }

func MakeRaw(fd uintptr) (func(), error) {
	old, err := term.MakeRaw(int(fd))
	if err != nil {
		return nil, err
	}
	return func() { _ = term.Restore(int(fd), old) }, nil
}

func IsTerminal(fd uintptr) bool { return term.IsTerminal(int(fd)) }
