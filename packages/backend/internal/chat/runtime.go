package chat

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/ports"
)

type RuntimeOptions struct {
	QueueSize   int
	Concurrency int
	Lease       time.Duration
}

type Runtime struct {
	Handler     *Handler
	dispatcher  *Dispatcher
	concurrency int
}

// NewRuntime composes the common PostgreSQL admission boundary with a
// deployment-provided location for the same TypeScript model host. Root only
// mounts the returned routes and attaches Run to its existing lifecycle.
func NewRuntime(pool *pgxpool.Pool, host ports.ChatHost, producerBaseURL string, options RuntimeOptions) (*Runtime, error) {
	if host == nil {
		return nil, errors.New("chat runtime requires a model host")
	}
	callback, err := url.Parse(strings.TrimSpace(producerBaseURL))
	if err != nil || (callback.Scheme != "http" && callback.Scheme != "https") || callback.Host == "" || callback.User != nil || callback.RawQuery != "" || callback.Fragment != "" {
		return nil, errors.New("chat producer callback URL is invalid")
	}
	if options.QueueSize == 0 {
		options.QueueSize = 256
	}
	if options.Concurrency == 0 {
		options.Concurrency = 4
	}
	if options.Lease == 0 {
		options.Lease = 15 * time.Minute
	}
	if options.QueueSize < 1 || options.Concurrency < 1 || options.Lease <= 0 {
		return nil, errors.New("chat runtime options are invalid")
	}
	store, err := NewStore(pool)
	if err != nil {
		return nil, err
	}
	dispatcher, err := NewDispatcher(store, PortHost{Host: host, ProducerBaseURL: callback.String()}, options.QueueSize, options.Lease)
	if err != nil {
		return nil, err
	}
	return &Runtime{Handler: &Handler{Store: store, Dispatcher: dispatcher}, dispatcher: dispatcher, concurrency: options.Concurrency}, nil
}

func (r *Runtime) Run(ctx context.Context) error {
	if r == nil || r.dispatcher == nil {
		return errors.New("chat runtime is not configured")
	}
	return r.dispatcher.Run(ctx, r.concurrency)
}

func (r *Runtime) MountPublic(router chi.Router)        { r.Handler.MountPublic(router) }
func (r *Runtime) MountAuthenticated(router chi.Router) { r.Handler.MountAuthenticated(router) }
func (r *Runtime) MountErasure(router chi.Router)       { r.Handler.MountErasure(router) }
func (r *Runtime) MountProducerCallbacks(router chi.Router) {
	r.Handler.MountProducerCallbacks(router)
}
