package flowhost

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
)

type memoryBindingStore struct {
	mu         sync.Mutex
	binding    Binding
	credential string
	acquires   int
}

func (store *memoryBindingStore) Acquire(_ context.Context, authority Authority, catalog Catalog) (BindingLease, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.acquires++
	if store.binding.ID == "" {
		store.binding = Binding{
			ID:       "11111111-1111-4111-8111-111111111111",
			TenantID: authority.Target.TenantID, PrincipalID: authority.Target.PrincipalID,
			BindingKind: authority.Target.BindingKind, BindingID: authority.Target.BindingID,
			RepositoryID: authority.RepositoryID, UserID: authority.UserID, WorkspaceID: authority.WorkspaceID,
			CatalogKey: catalog.Key, ServiceName: catalog.ServiceName,
			RuntimeArtifactDigest: catalog.ArtifactDigest, SourceRevision: catalog.SourceRevision,
			OwnerGeneration: 1, State: "pending",
		}
		store.credential = "server-held-bearer"
	}
	return &memoryBindingLease{store: store, binding: store.binding}, nil
}

type memoryBindingLease struct {
	store   *memoryBindingStore
	binding Binding
}

func (lease *memoryBindingLease) Binding() Binding   { return lease.binding }
func (lease *memoryBindingLease) Credential() string { return lease.store.credential }
func (lease *memoryBindingLease) PrepareStart(_ context.Context, replace bool) (Binding, error) {
	lease.store.mu.Lock()
	defer lease.store.mu.Unlock()
	if replace {
		lease.binding.OwnerGeneration++
	}
	lease.binding.State = "starting"
	lease.store.binding = lease.binding
	return lease.binding, nil
}
func (lease *memoryBindingLease) MarkRunning(context.Context) error {
	lease.store.mu.Lock()
	defer lease.store.mu.Unlock()
	lease.binding.State = "running"
	lease.store.binding = lease.binding
	return nil
}
func (*memoryBindingLease) Close() error { return nil }

type identityTransport struct {
	mu         sync.Mutex
	identity   flowruntime.Identity
	credential string
	requests   int
}

func (transport *identityTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	transport.requests++
	if request.Header.Get("Authorization") != "Bearer "+transport.credential {
		return &http.Response{StatusCode: http.StatusUnauthorized, Status: "401 Unauthorized", Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"error":"unauthorized"}`)), Request: request}, nil
	}
	body := `{"runtimeBridge":{"protocol":"` + transport.identity.Protocol + `","runtimeArtifactDigest":"` +
		transport.identity.RuntimeArtifactDigest + `","sourceRevision":"` + transport.identity.SourceRevision +
		`","ownerGeneration":` + intString(transport.identity.OwnerGeneration) + `}}`
	return &http.Response{StatusCode: http.StatusOK, Status: "200 OK", Header: make(http.Header),
		Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
}

func intString(value int64) string {
	if value == 1 {
		return "1"
	}
	if value == 2 {
		return "2"
	}
	return "0"
}

type memoryLauncher struct {
	mu        sync.Mutex
	running   bool
	binding   Binding
	transport *identityTransport
	starts    []HostLaunch
}

func (launcher *memoryLauncher) connection(binding Binding, credential string) Connection {
	launcher.transport.identity = flowruntime.Identity{Protocol: flowruntime.Protocol,
		RuntimeArtifactDigest: binding.RuntimeArtifactDigest, SourceRevision: binding.SourceRevision,
		OwnerGeneration: binding.OwnerGeneration}
	launcher.transport.credential = credential
	return Connection{Endpoint: "http://127.0.0.1:7331", HTTPClient: &http.Client{Transport: launcher.transport}}
}

func (launcher *memoryLauncher) InspectFlowHost(_ context.Context, binding Binding, _ Authority, _ Catalog) (Connection, error) {
	launcher.mu.Lock()
	defer launcher.mu.Unlock()
	if !launcher.running {
		return Connection{}, ErrHostNotRunning
	}
	return launcher.connection(launcher.binding, launcher.transport.credential), nil
}

func (launcher *memoryLauncher) StartFlowHost(_ context.Context, request HostLaunch) (Connection, error) {
	launcher.mu.Lock()
	defer launcher.mu.Unlock()
	launcher.running = true
	launcher.binding = request.Binding
	launcher.starts = append(launcher.starts, request)
	return launcher.connection(request.Binding, request.Credential), nil
}

func testResolver(t *testing.T) (*Resolver, *memoryBindingStore, *memoryLauncher, flowruntime.Target) {
	t.Helper()
	target := flowruntime.Target{TenantID: "repository:5", PrincipalID: "user:9", BindingKind: "agent-session", BindingID: "session-1"}
	authority := Authority{Target: target, RepositoryID: 5, UserID: 9,
		WorkspaceID: "22222222-2222-4222-8222-222222222222", CatalogKey: CatalogCoding}
	store := &memoryBindingStore{}
	launcher := &memoryLauncher{transport: &identityTransport{}}
	resolver, err := New(Config{
		Store: store, Launcher: launcher,
		Targets: TargetResolverFunc(func(context.Context, flowruntime.Target) (Authority, error) { return authority, nil }),
		Catalogs: []Catalog{{Key: CatalogCoding, Family: CatalogCoding, Executable: "/opt/smithers/coding-host",
			ArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40),
			ServiceName: "smithers-flow-coding", Port: 7331, ImplementationModel: "openai:gpt-5"}},
	})
	require.NoError(t, err)
	return resolver, store, launcher, target
}

func TestResolverStartsOnceAuthenticatesAndReusesDurableBinding(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	runtime, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	identity, err := runtime.Identity(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(1), identity.OwnerGeneration)

	second, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	secondIdentity, err := second.Identity(context.Background())
	require.NoError(t, err)
	assert.Equal(t, identity, secondIdentity)
	require.Len(t, launcher.starts, 1)
	assert.Equal(t, "server-held-bearer", launcher.starts[0].Credential)
	assert.Equal(t, "running", store.binding.State)
	assert.Equal(t, 2, store.acquires)
	assert.GreaterOrEqual(t, launcher.transport.requests, 4)
}

func TestResolverFencesReplacementOwnerButKeepsBearerAndArtifact(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	launcher.mu.Lock()
	launcher.running = false
	launcher.mu.Unlock()

	runtime, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.NoError(t, err)
	identity, err := runtime.Identity(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(2), identity.OwnerGeneration)
	require.Len(t, launcher.starts, 2)
	assert.Equal(t, launcher.starts[0].Credential, launcher.starts[1].Credential)
	assert.Equal(t, launcher.starts[0].Catalog.ArtifactDigest, launcher.starts[1].Catalog.ArtifactDigest)
	assert.Equal(t, int64(2), store.binding.OwnerGeneration)
}

func TestResolverRefusesLiveHostWithDifferentIdentityWithoutStartingCompetitor(t *testing.T) {
	resolver, store, launcher, target := testResolver(t)
	store.binding = Binding{ID: "11111111-1111-4111-8111-111111111111",
		TenantID: target.TenantID, PrincipalID: target.PrincipalID, BindingKind: target.BindingKind, BindingID: target.BindingID,
		RepositoryID: 5, UserID: 9, WorkspaceID: "22222222-2222-4222-8222-222222222222", CatalogKey: CatalogCoding,
		ServiceName: "smithers-flow-coding", RuntimeArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40),
		OwnerGeneration: 1, State: "running"}
	store.credential = "server-held-bearer"
	launcher.running = true
	launcher.binding = store.binding
	launcher.binding.RuntimeArtifactDigest = strings.Repeat("c", 64)
	launcher.transport.credential = store.credential

	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.Error(t, err)
	var bridgeFailure flowruntime.Failure
	require.ErrorAs(t, err, &bridgeFailure)
	assert.Equal(t, "runtime_identity_conflict", bridgeFailure.FlowRuntimeCode())
	assert.False(t, bridgeFailure.FlowRuntimeRetryable())
	assert.Empty(t, launcher.starts)
}

func TestResolverRefusesTargetResolverScopeSubstitution(t *testing.T) {
	resolver, _, launcher, target := testResolver(t)
	resolver.targets = TargetResolverFunc(func(_ context.Context, _ flowruntime.Target) (Authority, error) {
		changed := target
		changed.PrincipalID = "user:10"
		return Authority{Target: changed, RepositoryID: 5, UserID: 10,
			WorkspaceID: "22222222-2222-4222-8222-222222222222", CatalogKey: CatalogCoding}, nil
	})
	_, err := resolver.ResolveFlowRuntime(context.Background(), target)
	require.Error(t, err)
	assert.Empty(t, launcher.starts)
}

func TestCatalogRejectsReservedIdentityEnvironment(t *testing.T) {
	_, err := validateCatalog(Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/host",
		ArtifactDigest: strings.Repeat("a", 64), SourceRevision: strings.Repeat("b", 40),
		ServiceName: "host", Port: 7331, ImplementationModel: "openai:gpt-5",
		Environment: map[string]string{"SMITHERS_API_KEY": "caller-value"}})
	require.Error(t, err)
}
