package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	upstream "github.com/superradcompany/microsandbox/sdk/go"
)

// Run in an ephemeral worker image with the pinned Microsandbox library. No
// KVM or guest is needed: the real SDK verifies and transfers synthetic disk
// artifacts, including their parent chain, just as its own archive tests do.
func TestSDKSnapshotArchiveRoundTrip(t *testing.T) {
	if os.Getenv("SMITHERS_TEST_SNAPSHOT_RUNTIME") != "1" {
		t.Skip("requires an isolated worker image and SMITHERS_TEST_SNAPSHOT_RUNTIME=1")
	}
	ctx := context.Background()
	runtime := NewSDKRuntime()
	require.NoError(t, runtime.EnsureInstalled(ctx))
	home, err := os.UserHomeDir()
	require.NoError(t, err)
	root := filepath.Join(home, ".microsandbox", "snapshots")
	id := "msbs_" + uuid.NewString()
	parentID := "msbs_" + uuid.NewString()
	artifact := func(name, payload string, parent *string) *upstream.SnapshotArtifact {
		dir := filepath.Join(root, name)
		require.NoError(t, os.MkdirAll(dir, 0o700))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "upper.ext4"), []byte(payload), 0o600))
		parentJSON, err := json.Marshal(parent)
		require.NoError(t, err)
		// Schema 1 field order is identity-bearing in Microsandbox archives.
		manifest := []byte(fmt.Sprintf(`{"schema":1,"artifact":"snapshot","scope":"disk","created_at":"2026-09-12T00:00:00Z","parent":%s,"image":{"ref":"docker.io/library/alpine:3.20","manifest_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000001"},"source_sandbox":%q,"state":{"kind":"file","format":"raw","fstype":"ext4","upper":{"file":"upper.ext4","size_bytes":%d,"integrity":null}},"labels":{},"extensions":{},"requires":[]}`, parentJSON, name, len(payload)))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "snapshot.json"), manifest, 0o600))
		snapshot, err := upstream.Snapshot.Open(ctx, dir)
		require.NoError(t, err)
		return snapshot
	}
	parentDigest := artifact(parentID, "parent disk bytes", nil).Digest()
	digest := artifact(id, "child disk bytes", &parentDigest).Digest()
	archive := filepath.Join(t.TempDir(), "snapshot.tar.zst")
	exported, err := runtime.ExportSnapshot(ctx, id, archive)
	require.NoError(t, err)
	require.NoError(t, runtime.DeleteSnapshot(ctx, id))
	require.NoError(t, runtime.DeleteSnapshot(ctx, parentID))

	for attempt := 0; attempt < 3; attempt++ {
		if attempt == 2 {
			// Recover a crash between publishing the artifact and its digest marker.
			marker, err := snapshotArchiveDigestPath(id)
			require.NoError(t, err)
			require.NoError(t, os.Remove(marker))
		}
		imported, err := runtime.ImportSnapshot(ctx, id, archive)
		require.NoError(t, err)
		require.Equal(t, exported, imported)
		handle, err := upstream.Snapshot.Get(ctx, id)
		require.NoError(t, err)
		require.Equal(t, digest, handle.Digest())
		payload, err := os.ReadFile(filepath.Join(handle.Path(), "upper.ext4"))
		require.NoError(t, err)
		require.Equal(t, "child disk bytes", string(payload))
		_, err = upstream.Snapshot.Get(ctx, parentDigest)
		require.NoError(t, err, "imported parent remains available")
	}
	// The old adapter left this content-named artifact behind on failure. A
	// retry after upgrading must succeed without overwriting that directory.
	require.NoError(t, runtime.DeleteSnapshot(ctx, id))
	_, err = upstream.Snapshot.Load(ctx, archive, filepath.Join(root, "plue-imports", id))
	require.NoError(t, err)
	imported, err := runtime.ImportSnapshot(ctx, id, archive)
	require.NoError(t, err)
	require.Equal(t, exported, imported)
	_, err = runtime.ExportSnapshot(ctx, id, filepath.Join(t.TempDir(), "restored.tar.zst"))
	require.NoError(t, err, "restored snapshot can be exported with its parents")
}
