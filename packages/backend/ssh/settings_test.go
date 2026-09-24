package ssh_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	productssh "github.com/smithersai/smithers/packages/backend/ssh"
	"github.com/stretchr/testify/require"
)

func TestSettingsReadCanonicalPublicOriginAndRejectMalformedDurations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ssh.yaml")
	require.NoError(t, os.WriteFile(path, []byte("server:\n  public_url: https://product.example\nssh:\n  receive_pack_timeout: 90s\n  upload_pack_timeout: 3m\n  shutdown_drain_timeout: 10s\n"), 0600))
	settings, err := productssh.LoadSettings(path)
	require.NoError(t, err)
	require.Equal(t, "https://product.example", settings.Server.PublicAPIOrigin)
	require.Equal(t, 90*time.Second, settings.Server.ReceivePackTimeout)
	require.Equal(t, 3*time.Minute, settings.Server.UploadPackTimeout)
	require.Equal(t, 10*time.Second, settings.ShutdownTimeout)
	for _, duration := range []string{"not-a-duration", "-1s"} {
		require.NoError(t, os.WriteFile(path, []byte("ssh:\n  receive_pack_timeout: "+duration+"\n"), 0600))
		_, err = productssh.LoadSettings(path)
		require.ErrorContains(t, err, "ssh.receive_pack_timeout")
	}
}
