//go:build darwin

package postgres

import (
	"errors"
	"fmt"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

func postmasterSysProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }

func processIdentity(pid int) (birth string, executable string, err error) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return "", "", err
	}
	if int(info.Proc.P_pid) != pid {
		return "", "", errors.New("process identity PID mismatch")
	}
	args, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil || len(args) < 5 {
		return "", "", errors.New("read process executable")
	}
	end := 4
	for end < len(args) && args[end] != 0 {
		end++
	}
	if end == 4 {
		return "", "", errors.New("process executable is empty")
	}
	executable, err = filepath.EvalSymlinks(string(args[4:end]))
	if err != nil {
		return "", "", err
	}
	start := info.Proc.P_starttime
	return fmt.Sprintf("darwin:%d:%d", start.Sec, start.Usec), executable, nil
}
