package guest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
)

func TestPersistentServiceWritesArgvWithoutUnitInjection(t *testing.T) {
	dir := handlerHWithSystemdUnitPath(t)
	handlerHInstallSystemctl(t)
	script := "printf '%s' \"$HOME\"\necho 'quoted value'; echo done"
	_, err := NewHandler(time.Hour).handleCreatePersistentUnit(context.Background(), &CreatePersistentUnitRequest{Name: "argv", Exec: []string{"/bin/sh", "-c", script}})
	require.NoError(t, err)
	unit, err := os.ReadFile(filepath.Join(dir, "argv.service"))
	require.NoError(t, err)
	require.Contains(t, string(unit), `ExecStart="/bin/sh" "-c" "printf '%%s' \"$$HOME\"\necho 'quoted value'; echo done"`+"\n")
	require.Equal(t, 1, strings.Count(string(unit), "\nExecStart="))
	require.NotContains(t, string(unit), "\necho 'quoted value'")
}

func TestTransientServicePreservesArgumentBoundaries(t *testing.T) {
	target := filepath.Join(t.TempDir(), "argv")
	handlerCovSetPathWithCommands(t, map[string]string{"systemd-run": `printf '%s\000' "$@" > "$SERVICE_ARGV_FILE"`})
	t.Setenv("SERVICE_ARGV_FILE", target)
	args := []string{"/bin/sh", "-c", "echo \"$HOME\";\necho 'a b'", "", "two words"}
	_, err := NewHandler(time.Hour).handleCreateTransientUnit(context.Background(), &CreateTransientUnitRequest{Name: "argv", Exec: args})
	require.NoError(t, err)
	captured, err := os.ReadFile(target)
	require.NoError(t, err)
	require.True(t, strings.HasSuffix(string(captured), "--\x00/bin/sh\x00-c\x00echo \"$$HOME\";\necho 'a b'\x00\x00two words\x00"), string(captured))
}

func TestGuestRefusesCommandLineServiceExec(t *testing.T) {
	h := NewHandler(time.Hour)
	_, err := h.handleCreatePersistentUnit(context.Background(), &CreatePersistentUnitRequest{Name: "bad", Exec: []string{"/bin/sh -c 'echo bad'"}})
	require.ErrorIs(t, err, sandbox.ErrServiceExecNotArgv)
	_, err = h.handleCreateTransientUnit(context.Background(), &CreateTransientUnitRequest{Name: "bad", Exec: []string{"/bin/sh -c 'echo bad'"}})
	require.ErrorIs(t, err, sandbox.ErrServiceExecNotArgv)
}
