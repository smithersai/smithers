//go:build linux

package postgres

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func postmasterSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGINT}
}

func processIdentity(pid int) (birth string, executable string, err error) {
	stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return "", "", err
	}
	closeParen := strings.LastIndexByte(string(stat), ')')
	if closeParen < 0 {
		return "", "", errors.New("malformed process stat")
	}
	fields := strings.Fields(string(stat)[closeParen+1:])
	if len(fields) < 20 {
		return "", "", errors.New("incomplete process stat")
	}
	executable, err = os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
	if err != nil {
		return "", "", err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return "", "", err
	}
	return fmt.Sprintf("linux:%s", fields[19]), executable, nil
}
