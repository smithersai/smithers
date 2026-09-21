package ssh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
)

func TestParseWorkspaceLogins(t *testing.T) {
	token := "abcdefghijklmnopqrstuvwxyz012345"
	want := WorkspaceAccess{SandboxID: "msb_1234-abcd", User: "developer", Token: token}

	got, ok := parseWorkspacePublicKeyLogin("msb_1234-abcd+developer:" + token)
	require.True(t, ok)
	assert.Equal(t, want, got)

	got, ok = parseWorkspacePasswordLogin("msb_1234-abcd+developer", token)
	require.True(t, ok)
	assert.Equal(t, want, got)

	for _, login := range []string{
		"vm_legacy+developer:" + token,
		"msb_1234+../../root:" + token,
		"msb_1234+developer:short",
		"msb_1234+developer:" + token + " whitespace",
	} {
		_, ok := parseWorkspacePublicKeyLogin(login)
		assert.False(t, ok, login)
	}
}

func TestControllerWorkspaceBridgeValidate(t *testing.T) {
	access := WorkspaceAccess{SandboxID: "msb_test", User: "developer", Token: "abcdefghijklmnopqrstuvwxyz012345"}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		assert.Equal(t, "/internal/v1/access/validate", request.URL.Path)
		var received msb.AccessValidationRequest
		require.NoError(t, json.NewDecoder(request.Body).Decode(&received))
		assert.Equal(t, access.SandboxID, received.SandboxID)
		assert.Equal(t, access.User, received.User)
		assert.Equal(t, access.Token, received.Token)
		assert.Equal(t, "ssh", received.Protocol)
		_ = json.NewEncoder(writer).Encode(msb.AccessValidationResponse{Allowed: true, SandboxID: access.SandboxID})
	}))
	defer server.Close()

	bridge, err := NewControllerWorkspaceBridge(ControllerWorkspaceBridgeConfig{
		ControllerURL:  server.URL,
		HTTPClient:     server.Client(),
		PrivateKeyFile: writeTestBridgeKey(t),
	})
	require.NoError(t, err)
	require.NoError(t, bridge.Validate(context.Background(), access))
}

func TestControllerWorkspaceBridgeValidateDeniesMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(writer).Encode(msb.AccessValidationResponse{Allowed: true, SandboxID: "msb_other"})
	}))
	defer server.Close()
	bridge, err := NewControllerWorkspaceBridge(ControllerWorkspaceBridgeConfig{
		ControllerURL:  server.URL,
		HTTPClient:     server.Client(),
		PrivateKeyFile: writeTestBridgeKey(t),
	})
	require.NoError(t, err)
	err = bridge.Validate(context.Background(), WorkspaceAccess{
		SandboxID: "msb_test", User: "developer", Token: "abcdefghijklmnopqrstuvwxyz012345",
	})
	assert.ErrorIs(t, err, ErrWorkspaceAccessDenied)
}

func writeTestBridgeKey(t *testing.T) string {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	encoded, err := x509.MarshalPKCS8PrivateKey(privateKey)
	require.NoError(t, err)
	path := filepath.Join(t.TempDir(), "bridge-key")
	require.NoError(t, os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded}), 0o600))
	return path
}
