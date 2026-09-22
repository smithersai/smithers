package flowhost

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
)

func TestBuildProcessSpecUsesSameImmutableIdentityForWorkspaceAdapters(t *testing.T) {
	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: "session-1"}
	authority := Authority{Target: target, RepositoryID: 5, UserID: 9, WorkspaceID: "workspace-1", CatalogKey: CatalogCoding}
	catalog := Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/opt/smithers/coding-host",
		ArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40),
		ServiceName: "smithers-flow-coding", ImplementationModel: "openai:gpt-5"}
	binding := Binding{ID: "11111111-1111-4111-8111-111111111111", TenantID: target.TenantID,
		PrincipalID: target.PrincipalID, BindingKind: target.BindingKind, BindingID: target.BindingID,
		RepositoryID: 5, UserID: 9, WorkspaceID: "workspace-1", CatalogKey: CatalogCoding,
		ServiceName: catalog.ServiceName, RuntimeArtifactDigest: catalog.ArtifactDigest,
		SourceRevision: catalog.SourceRevision, OwnerGeneration: 7, State: "starting"}
	spec, err := BuildProcessSpec(HostLaunch{Binding: binding, Authority: authority, Catalog: catalog, Credential: "bearer"},
		WorkspacePaths{Root: "/workspace/repo", StateDir: "/workspace/state"}, 4317)
	require.NoError(t, err)
	assert.Equal(t, "127.0.0.1:4317", spec.ReadyAddress)
	assert.Equal(t, []string{"/opt/smithers/coding-host", "serve", "--root", "/workspace/repo", "--state-dir",
		"/workspace/state/flow-runtime/11111111-1111-4111-8111-111111111111", "--host", "127.0.0.1", "--port", "4317", "--listen"}, spec.Args)
	assert.Equal(t, "bearer", spec.Environment["SMITHERS_API_KEY"])
	assert.Equal(t, "7", spec.Environment["SMITHERS_OWNER_GENERATION"])
	assert.Equal(t, "openai:gpt-5", spec.Environment["SMITHERS_CODING_IMPLEMENT_MODEL"])
	assert.NotContains(t, spec.Identity, "bearer")
}
