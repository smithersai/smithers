package sandbox

import (
	"errors"
	"fmt"
	"strings"
)

// ErrServiceExecNotArgv reports a service whose Exec is a shell command line
// or a pre-quoted word instead of an argv. Providers quote every element, so
// such a service would launch a program that does not exist.
var ErrServiceExecNotArgv = errors.New("service exec must be an argv")

// ValidateExec requires Exec to be an argv: its first element names one
// executable, with no whitespace or shell quoting.
func (s ServiceSpec) ValidateExec() error {
	if len(s.Exec) == 0 || strings.TrimSpace(s.Exec[0]) == "" {
		return fmt.Errorf("%w: exec is empty", ErrServiceExecNotArgv)
	}
	if strings.ContainsAny(s.Exec[0], " \t\n'\"") {
		return fmt.Errorf("%w: exec[0] %q is a command line, not an executable", ErrServiceExecNotArgv, s.Exec[0])
	}
	for i, arg := range s.Exec {
		if strings.ContainsRune(arg, 0) {
			return fmt.Errorf("%w: exec[%d] contains a NUL", ErrServiceExecNotArgv, i)
		}
	}
	return nil
}
