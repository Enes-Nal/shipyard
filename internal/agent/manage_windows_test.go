package agent

import (
	"context"
	"path/filepath"
	"testing"
)

func TestBackgroundCLICommandsNeverOpenAConsoleWindow(t *testing.T) {
	a := &Agent{cfg: Config{CLI: filepath.Join(t.TempDir(), "berth.exe"), Dir: filepath.Join(t.TempDir(), "client")}}
	cmd := a.cli(context.Background(), "version")
	const createNoWindow = 0x08000000
	if cmd.SysProcAttr == nil || cmd.SysProcAttr.CreationFlags&createNoWindow == 0 || !cmd.SysProcAttr.HideWindow {
		t.Fatalf("background CLI process can open a console window: %+v", cmd.SysProcAttr)
	}
}
