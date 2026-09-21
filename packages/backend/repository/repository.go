// Package repository exposes the shared native repository engine to the
// self-hosted app and to Plue. Both hosts use the same server and jj library.
package repository

import (
	"context"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
)

type Config = repohostserver.Config
type Client = repohost.Client
type StorageSetResolver = repohost.StorageSetResolver
type StorageSetURLResolver = repohost.StorageSetURLResolver
type StagedProvision = repohost.StagedProvision
type StagedDelete = repohost.StagedDelete
type StagedMove = repohost.StagedMove

// OpenLocal opens the repository engine on local disk. The client calls the
// server handler in process; no repo-host listener or placement lookup exists.
func OpenLocal(cfg Config) (*Local, error) {
	server, err := repohostserver.New(cfg)
	if err != nil {
		return nil, err
	}
	return &Local{server: server, client: repohost.NewLocalClient(server.Handler(), cfg.AuthToken)}, nil
}

type Local struct {
	server *repohostserver.Server
	client *repohost.Client
}

func (l *Local) Client() *Client { return l.client }

// Handler provides the same authenticated Git and repository API as the
// independently hosted service. The app may mount it under its own routing.
func (l *Local) Handler() http.Handler { return SmartHTTPHandler(l.server.Handler()) }

func (l *Local) Shutdown(ctx context.Context) error { return l.server.Shutdown(ctx) }

// NewRemoteClient is Plue's adapter to that same engine behind its cluster
// routing. Placement remains a Plue concern, outside this package.
func NewRemoteClient(resolver StorageSetResolver, authToken string) *Client {
	return repohost.NewClient(resolver, authToken)
}

// NewService constructs the independently hostable form of the same server.
func NewService(cfg Config) (*Service, error) {
	server, err := repohostserver.New(cfg)
	if err != nil {
		return nil, err
	}
	return &Service{server: server}, nil
}

type Service struct{ server *repohostserver.Server }

func (s *Service) Handler() http.Handler { return SmartHTTPHandler(s.server.Handler()) }

func (s *Service) Shutdown(ctx context.Context) error { return s.server.Shutdown(ctx) }

// SmartHTTPHandler maps ordinary Git remote URLs onto the repository engine's
// authenticated Git routes. Both embedded and separately hosted modes use it.
func SmartHTTPHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/git/") {
			next.ServeHTTP(w, r)
			return
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/git/"), "/")
		if len(parts) < 3 || !strings.HasSuffix(parts[1], ".git") {
			http.NotFound(w, r)
			return
		}
		owner, repo := parts[0], strings.TrimSuffix(parts[1], ".git")
		if !validComponent(owner) || !validComponent(repo) {
			http.NotFound(w, r)
			return
		}
		var suffix string
		switch {
		case len(parts) == 4 && parts[2] == "info" && parts[3] == "refs" && r.Method == http.MethodGet:
			suffix = "info-refs"
		case len(parts) == 3 && parts[2] == "git-upload-pack" && r.Method == http.MethodPost:
			suffix = "upload-pack"
		case len(parts) == 3 && parts[2] == "git-receive-pack" && r.Method == http.MethodPost:
			suffix = "receive-pack"
		default:
			http.NotFound(w, r)
			return
		}
		rewritten := r.Clone(r.Context())
		rewritten.URL.Path = "/repos/" + owner + "/" + repo + "/git/" + suffix
		rewritten.URL.RawPath = ""
		next.ServeHTTP(w, rewritten)
	})
}

func validComponent(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}
	for _, ch := range value {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
			(ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' {
			continue
		}
		return false
	}
	return true
}

func LoadConfig() (Config, error) { return repohostserver.LoadConfig() }
