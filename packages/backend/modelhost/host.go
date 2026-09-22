// Package modelhost connects the durable Go chat journal to the canonical
// TypeScript model host. Credential selection is an authorized deployment
// concern; a grant never carries a provider secret.
package modelhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// Binding is resolved for exactly one authenticated owner and turn. Model is
// the canonical TypeScript ModelBinding; TypeScript remains the sole authority
// for provider routing, credential origin, and model policy.
type Binding struct {
	Model            json.RawMessage
	CredentialName   string
	CredentialOrigin string

	// CredentialValue is held only in the launch request's memory and child
	// process environment. It must never enter workspace metadata or logs.
	CredentialValue string
}

type Resolver interface {
	ResolveChatModel(context.Context, int64, int64, json.RawMessage) (Binding, error)
}

type ResolverFunc func(context.Context, int64, int64, json.RawMessage) (Binding, error)

func (resolve ResolverFunc) ResolveChatModel(ctx context.Context, ownerID, repositoryID int64, request json.RawMessage) (Binding, error) {
	return resolve(ctx, ownerID, repositoryID, request)
}

// Lease is an authenticated private connection to one launched host. Close
// joins process termination and workspace cleanup before a turn is released.
type Lease interface {
	Endpoint() (baseURL string, client *http.Client, token string)
	Close(context.Context) error
}

type Launcher interface {
	LaunchChatHost(context.Context, ports.ChatTurnGrant, Binding) (Lease, error)
}

type Host struct {
	resolver Resolver
	launcher Launcher
}

const cleanupTimeout = 15 * time.Second

func New(resolver Resolver, launcher Launcher) (*Host, error) {
	if resolver == nil || launcher == nil {
		return nil, errors.New("model host requires an owner-scoped resolver and private launcher")
	}
	return &Host{resolver: resolver, launcher: launcher}, nil
}

func (host *Host) RunChatTurn(ctx context.Context, grant ports.ChatTurnGrant) (runErr error) {
	if grant.OwnerID <= 0 {
		return errors.New("model host grant has no authenticated owner")
	}
	binding, err := host.resolver.ResolveChatModel(ctx, grant.OwnerID, grant.RepositoryID, grant.Request)
	if err != nil {
		return fmt.Errorf("resolve owner model: %w", err)
	}
	lease, err := host.launcher.LaunchChatHost(ctx, grant, binding)
	if err != nil {
		return fmt.Errorf("launch owner model host: %w", err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		runErr = errors.Join(runErr, lease.Close(cleanupCtx))
	}()
	baseURL, client, token := lease.Endpoint()
	transport, err := chat.NewHTTPChatHost(baseURL, client, token)
	if err != nil {
		return err
	}
	return transport.RunChatTurn(ctx, grant)
}

// Close releases any launcher's retained cleanup work after dispatcher drain.
func (host *Host) Close(ctx context.Context) error {
	if closer, ok := host.launcher.(interface{ Close(context.Context) error }); ok {
		return closer.Close(ctx)
	}
	return nil
}
