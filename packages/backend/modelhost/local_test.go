package modelhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/stretchr/testify/require"
)

func TestLocalLauncherVerifiesBundleAndRunsOneTurn(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node 22 is required for the model host adapter smoke test")
	}
	node, err = filepath.EvalSymlinks(node)
	require.NoError(t, err)
	root := t.TempDir()
	bundle := filepath.Join(root, "model-host.mjs")
	source := []byte(`import http from "node:http";
const port = Number(process.argv.at(-1));
const server = http.createServer((request, response) => {
  if (request.url === "/health") { response.setHeader("content-type", "application/json"); response.end('{"protocol":"smithers.chat-model-host/v1"}'); return; }
  if (request.url === "/v1/chat/turn" && request.headers.authorization === "Bearer " + process.env.SMITHERS_CHAT_HOST_TOKEN && process.env.ANTHROPIC_API_KEY === "secret-only-in-child") {
    response.writeHead(200); response.end(); return;
  }
  response.writeHead(401); response.end();
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close());
`)
	require.NoError(t, os.WriteFile(bundle, source, 0o755))
	digest := sha256.Sum256(source)
	require.NoError(t, os.WriteFile(bundle+".sha256", []byte(hex.EncodeToString(digest[:])+"  model-host.mjs\n"), 0o644))
	runtime, err := process.New(process.Config{Root: filepath.Join(root, "runtime")})
	require.NoError(t, err)
	defer runtime.Close()
	launcher, err := NewLocalLauncher(LocalConfig{Runtime: runtime, NodeBinary: node, BundlePath: bundle})
	require.NoError(t, err)
	host, err := New(ResolverFunc(func(context.Context, int64, int64, json.RawMessage) (Binding, error) {
		return Binding{Model: json.RawMessage(`{"modelId":"test"}`), CredentialName: "ANTHROPIC_API_KEY", CredentialValue: "secret-only-in-child"}, nil
	}), launcher)
	require.NoError(t, err)
	require.NoError(t, host.RunChatTurn(context.Background(), ports.ChatTurnGrant{
		TurnID: "turn-one", OwnerID: 1, Generation: 1, ProducerBaseURL: "http://127.0.0.1:12345",
	}))
	require.NoError(t, host.Close(context.Background()))
	entries, err := os.ReadDir(filepath.Join(root, "runtime", "workspaces"))
	require.NoError(t, err)
	require.Empty(t, entries)

	require.NoError(t, os.WriteFile(bundle, []byte("tampered"), 0o755))
	_, err = NewLocalLauncher(LocalConfig{Runtime: runtime, NodeBinary: node, BundlePath: bundle})
	require.ErrorContains(t, err, "checksum mismatch")
}

func TestCredentialEnvironmentRejectsArbitraryEnvironment(t *testing.T) {
	for _, name := range []string{"PATH", "SMITHERS_CHAT_HOST_TOKEN", "OPENAI_API_KEY_ORIGIN"} {
		_, err := credentialEnvironment(Binding{Model: json.RawMessage(`{}`), CredentialName: name, CredentialValue: "secret"})
		require.Error(t, err, name)
	}
	env, err := credentialEnvironment(Binding{Model: json.RawMessage(`{}`), CredentialName: "ENROLLED", CredentialOrigin: "https://models.example", CredentialValue: "secret"})
	require.NoError(t, err)
	require.Equal(t, "secret", env["SMITHERS_MODEL_KEY_ENROLLED"])
	require.Equal(t, "https://models.example", env["SMITHERS_MODEL_KEY_ENROLLED_ORIGIN"])
}
