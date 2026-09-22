//go:build darwin || linux

package postgres

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func configurePostmaster(cmd *exec.Cmd) { cmd.SysProcAttr = postmasterSysProcAttr() }

func runBounded(ctx context.Context, cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		_ = signalProcessGroup(cmd.Process.Pid, os.Kill)
		<-done
		return ctx.Err()
	}
}

func signalPID(pid int, signal os.Signal) error {
	sig, ok := signal.(syscall.Signal)
	if !ok {
		return errors.New("unsupported process signal")
	}
	return syscall.Kill(pid, sig)
}

func signalProcessGroup(pid int, signal os.Signal) error {
	sig, ok := signal.(syscall.Signal)
	if !ok {
		return errors.New("unsupported process signal")
	}
	return syscall.Kill(-pid, sig)
}

func immediateShutdownSignal() os.Signal { return syscall.SIGQUIT }

func processAlive(pid int) (bool, error) {
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, syscall.ESRCH) {
		return false, nil
	}
	return false, err
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
