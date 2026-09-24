package sandbox

import (
	"errors"
	"testing"
)

func TestServiceSpecValidateExecRequiresArgv(t *testing.T) {
	for _, exec := range [][]string{
		{"/usr/local/bin/bun", "run", "./agent.ts"},
		{"/bin/sh", "-c", "echo 'quoted script' && exit 0"},
		{"/usr/local/bin/smithers-desktop-start"},
	} {
		if err := (ServiceSpec{Exec: exec}).ValidateExec(); err != nil {
			t.Fatalf("%q: %v", exec, err)
		}
	}
	for _, exec := range [][]string{
		nil,
		{""},
		{"/usr/local/bin/bun run ./agent.ts"},
		{"/bin/sh -c 'serve'"},
		{"'/home/developer/.local/state/smithers/services/host.sh'"},
	} {
		if err := (ServiceSpec{Exec: exec}).ValidateExec(); !errors.Is(err, ErrServiceExecNotArgv) {
			t.Fatalf("%q: error = %v, want ErrServiceExecNotArgv", exec, err)
		}
	}
}
