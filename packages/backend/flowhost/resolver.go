package flowhost

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/runtimebridge"
)

var (
	catalogKeyPattern  = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)
	serviceNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.@:-]{1,128}$`)
)

var reservedEnvironment = map[string]struct{}{
	"SMITHERS_API_KEY": {}, "SMITHERS_GATEWAY_ID": {},
	"SMITHERS_OWNER_GENERATION": {}, "SMITHERS_FLOW_ARTIFACT_SHA256": {},
	"SMITHERS_SOURCE_REVISION": {}, "SMITHERS_REPO": {},
	"SMITHERS_PRODUCT_API_URL": {}, "SMITHERS_CODING_IMPLEMENT_MODEL": {},
	"SMITHERS_LIBRARIAN_MODEL": {},
}

type Resolver struct {
	store    BindingStore
	targets  TargetResolver
	launcher Launcher
	catalogs map[string]Catalog
}

func New(config Config) (*Resolver, error) {
	if config.Store == nil || config.Targets == nil || config.Launcher == nil {
		return nil, errors.New("flow host resolver requires store, target resolver, and launcher")
	}
	catalogs := make(map[string]Catalog, len(config.Catalogs))
	for _, catalog := range config.Catalogs {
		validated, err := validateCatalog(catalog)
		if err != nil {
			return nil, err
		}
		if _, duplicate := catalogs[validated.Key]; duplicate {
			return nil, fmt.Errorf("flow host catalog %q is duplicated", validated.Key)
		}
		catalogs[validated.Key] = validated
	}
	if len(catalogs) == 0 {
		return nil, errors.New("flow host resolver requires at least one catalog")
	}
	return &Resolver{store: config.Store, targets: config.Targets, launcher: config.Launcher, catalogs: catalogs}, nil
}

func validateCatalog(catalog Catalog) (Catalog, error) {
	catalog.Key = strings.TrimSpace(catalog.Key)
	catalog.Family = strings.TrimSpace(catalog.Family)
	catalog.Executable = strings.TrimSpace(catalog.Executable)
	catalog.ServiceName = strings.TrimSpace(catalog.ServiceName)
	catalog.ProductAPIURL = strings.TrimRight(strings.TrimSpace(catalog.ProductAPIURL), "/")
	catalog.ImplementationModel = strings.TrimSpace(catalog.ImplementationModel)
	if !catalogKeyPattern.MatchString(catalog.Key) {
		return Catalog{}, errors.New("flow host catalog key is invalid")
	}
	if catalog.Family != CatalogCoding && catalog.Family != CatalogLibrarian {
		return Catalog{}, fmt.Errorf("flow host catalog %q has an unsupported family", catalog.Key)
	}
	if !filepath.IsAbs(catalog.Executable) {
		return Catalog{}, fmt.Errorf("flow host catalog %q executable must be absolute", catalog.Key)
	}
	if !serviceNamePattern.MatchString(catalog.ServiceName) {
		return Catalog{}, fmt.Errorf("flow host catalog %q service name is invalid", catalog.Key)
	}
	if !lowerHex(catalog.ArtifactDigest, 64) {
		return Catalog{}, fmt.Errorf("flow host catalog %q immutable identity is invalid", catalog.Key)
	}
	if catalog.ReadyTimeout <= 0 {
		catalog.ReadyTimeout = 30 * time.Second
	}
	if catalog.ImplementationModel != "" && !explicitModel(catalog.ImplementationModel) {
		return Catalog{}, fmt.Errorf("flow host catalog %q model must be provider:model", catalog.Key)
	}
	if catalog.Family == CatalogLibrarian && catalog.ProductAPIURL == "" {
		return Catalog{}, fmt.Errorf("flow host catalog %q needs product API configuration", catalog.Key)
	}
	copyEnvironment := make(map[string]string, len(catalog.Environment))
	for name, value := range catalog.Environment {
		if strings.TrimSpace(name) != name || name == "" || strings.ContainsAny(name, "=\x00") || strings.IndexByte(value, 0) >= 0 {
			return Catalog{}, fmt.Errorf("flow host catalog %q environment is invalid", catalog.Key)
		}
		if _, reserved := reservedEnvironment[name]; reserved {
			return Catalog{}, fmt.Errorf("flow host catalog %q environment replaces reserved identity %s", catalog.Key, name)
		}
		copyEnvironment[name] = value
	}
	catalog.Environment = copyEnvironment
	return catalog, nil
}

func explicitModel(value string) bool {
	provider, model, ok := strings.Cut(value, ":")
	return ok && provider != "" && model != "" && !strings.ContainsAny(value, " \t\r\n")
}

func lowerHex(value string, length int) bool {
	if len(value) != length || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validateAuthority(target flowruntime.Target, authority Authority) error {
	if authority.Target != target || strings.TrimSpace(target.TenantID) == "" || strings.TrimSpace(target.PrincipalID) == "" ||
		strings.TrimSpace(target.BindingKind) == "" || strings.TrimSpace(target.BindingID) == "" {
		return failure{code: "runtime_target_forbidden"}
	}
	if authority.RepositoryID <= 0 || authority.UserID <= 0 || strings.TrimSpace(authority.WorkspaceID) == "" || strings.TrimSpace(authority.CatalogKey) == "" {
		return failure{code: "runtime_target_invalid"}
	}
	workspaceID, err := uuid.Parse(authority.WorkspaceID)
	if err != nil || workspaceID.String() != authority.WorkspaceID {
		return failure{code: "runtime_target_invalid"}
	}
	if authority.SourceRevision != "" && !lowerHex(authority.SourceRevision, 40) {
		return failure{code: "runtime_source_revision_invalid"}
	}
	if target.WorkspaceID != "" && target.WorkspaceID != authority.WorkspaceID {
		return failure{code: "runtime_workspace_replaced"}
	}
	return nil
}

func (resolver *Resolver) ResolveFlowRuntime(ctx context.Context, target flowruntime.Target) (flowruntime.Runtime, error) {
	if resolver == nil || resolver.store == nil || resolver.targets == nil || resolver.launcher == nil {
		return nil, failure{code: "runtime_resolver_unavailable", retryable: true}
	}
	authority, err := resolver.targets.ResolveFlowHostTarget(ctx, target)
	if err != nil {
		return nil, sanitizeFailure("runtime_binding_unavailable", err)
	}
	if err := validateAuthority(target, authority); err != nil {
		return nil, err
	}
	catalog, ok := resolver.catalogs[authority.CatalogKey]
	if !ok {
		return nil, failure{code: "runtime_catalog_unavailable"}
	}
	lease, err := resolver.store.Acquire(ctx, authority, catalog)
	if errors.Is(err, ErrSourceRevisionRequired) {
		source, ok := resolver.launcher.(SourceResolver)
		if !ok {
			return nil, failure{code: "runtime_source_revision_unavailable"}
		}
		authority.SourceRevision, err = source.ResolveFlowHostSource(ctx, authority)
		if err != nil {
			return nil, sanitizeFailure("runtime_source_revision_unavailable", err)
		}
		if !lowerHex(authority.SourceRevision, 40) {
			return nil, failure{code: "runtime_source_revision_invalid"}
		}
		lease, err = resolver.store.Acquire(ctx, authority, catalog)
	}
	if err != nil {
		return nil, sanitizeFailure("runtime_binding_unavailable", err)
	}
	defer lease.Close() // best effort: caller error takes precedence over unlock diagnostics.

	binding := lease.Binding()
	connection, inspectErr := resolver.launcher.InspectFlowHost(ctx, binding, authority, catalog)
	if inspectErr == nil {
		client, err := resolver.verifiedClient(ctx, connection, lease.Credential(), binding)
		if err != nil {
			// A process answered at this binding, so starting another would create
			// two owners. Retry/probe or surface its identity refusal instead.
			return nil, err
		}
		if err := lease.MarkRunning(ctx); err != nil {
			return nil, failure{code: "runtime_binding_checkpoint_failed", retryable: true}
		}
		return client, nil
	}
	if !errors.Is(inspectErr, ErrHostNotRunning) {
		return nil, sanitizeFailure("runtime_inspection_failed", inspectErr)
	}

	replaceOwner := binding.State == "running" || binding.State == "failed"
	binding, err = lease.PrepareStart(ctx, replaceOwner)
	if err != nil {
		return nil, sanitizeFailure("runtime_owner_fence_failed", err)
	}
	connection, err = resolver.launcher.StartFlowHost(ctx, HostLaunch{
		Binding: binding, Authority: authority, Catalog: catalog, Credential: lease.Credential(),
	})
	if err != nil {
		return nil, sanitizeFailure("runtime_start_failed", err)
	}
	client, err := resolver.verifiedClient(ctx, connection, lease.Credential(), binding)
	if err != nil {
		return nil, err
	}
	if err := lease.MarkRunning(ctx); err != nil {
		return nil, failure{code: "runtime_binding_checkpoint_failed", retryable: true}
	}
	return client, nil
}

func (resolver *Resolver) verifiedClient(ctx context.Context, connection Connection, credential string, binding Binding) (*runtimebridge.Client, error) {
	client, err := runtimebridge.New(runtimebridge.Config{
		Endpoint: connection.Endpoint, Credential: credential, HTTPClient: connection.HTTPClient,
	})
	if err != nil {
		return nil, failure{code: "runtime_endpoint_invalid"}
	}
	identity, err := client.Identity(ctx)
	if err != nil {
		return nil, sanitizeFailure("runtime_identity_unavailable", err)
	}
	if identity.Protocol != flowruntime.Protocol || identity.RuntimeArtifactDigest != binding.RuntimeArtifactDigest ||
		identity.SourceRevision != binding.SourceRevision || identity.OwnerGeneration != binding.OwnerGeneration {
		return nil, failure{code: "runtime_identity_conflict"}
	}
	return client, nil
}

type failure struct {
	code      string
	retryable bool
}

func (value failure) Error() string              { return "flow host: " + value.code }
func (value failure) FlowRuntimeCode() string    { return value.code }
func (value failure) FlowRuntimeRetryable() bool { return value.retryable }

func sanitizeFailure(fallback string, err error) error {
	var known flowruntime.Failure
	if errors.As(err, &known) {
		code := strings.TrimSpace(known.FlowRuntimeCode())
		if code == "" {
			code = fallback
		}
		return failure{code: code, retryable: known.FlowRuntimeRetryable()}
	}
	return failure{code: fallback, retryable: true}
}

var _ flowruntime.Resolver = (*Resolver)(nil)
var _ flowruntime.Failure = failure{}
