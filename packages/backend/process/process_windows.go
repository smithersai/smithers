//go:build windows

package process

import (
	"errors"
	"os"
	"os/exec"

	"github.com/creack/pty"
)

func prepareProcessGroup(*exec.Cmd)          {}
func signalProcessGroup(cmd *exec.Cmd) error { return cmd.Process.Kill() }
func killProcessGroup(cmd *exec.Cmd) error   { return cmd.Process.Kill() }
func startPTY(*exec.Cmd, *pty.Winsize) (*os.File, error) {
	return nil, errors.New("workspace terminals are unsupported on Windows")
}
