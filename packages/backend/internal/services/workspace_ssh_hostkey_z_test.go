package services

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWorkspaceSSHHostKey_Z_NextKeyReadError(t *testing.T) {
	dir := t.TempDir()
	writeEd25519HostKey(t, filepath.Join(dir, primaryHostKeyFile))
	require.NoError(t, os.Mkdir(filepath.Join(dir, nextHostKeyFile), 0o755))

	_, err := NewDiskHostKeyLoader(dir).LoadHostKeys()
	require.ErrorContains(t, err, "load next host key")
}
