// Package cleanup provides utilities for cleaning up expired data.
package cleanup

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// CleanupStore defines the interface for cleanup operations.
type CleanupStore interface {
	DeleteExpiredSessions(ctx context.Context) error
	DeleteExpiredNonces(ctx context.Context) error
	DeleteExpiredOAuthStates(ctx context.Context) error
	DeleteExpiredLinearOAuthSetups(ctx context.Context) error
	DeleteExpiredVerificationTokens(ctx context.Context) error
	DeleteExpiredSSETickets(ctx context.Context) error
	// DeleteExpiredAccessTokens prunes PATs whose expires_at passed more than
	// a grace day ago; bounded per sweep (see db/queries/auth.sql). Returns
	// the number of rows deleted.
	DeleteExpiredAccessTokens(ctx context.Context) (int64, error)
}

// ticker is an interface for time.Ticker to allow mocking in tests.
type ticker interface {
	Chan() <-chan time.Time
	Stop()
}

// realTicker wraps time.Ticker to implement the ticker interface.
type realTicker struct {
	t *time.Ticker
}

func (t *realTicker) Chan() <-chan time.Time {
	return t.t.C
}

func (t *realTicker) Stop() {
	t.t.Stop()
}

// AuthCleaner periodically cleans up expired auth-related data.
type AuthCleaner struct {
	store       CleanupStore
	revocations revocation.Publisher
	interval    time.Duration
	ticker      ticker
	newTicker   func(time.Duration) ticker
	stopCh      chan struct{}
	wg          sync.WaitGroup
	mu          sync.Mutex
	running     bool
}

type expiredOAuth2AccessTokenStore interface {
	DeleteExpiredOAuth2AccessTokens(context.Context) ([]db.Oauth2AccessToken, error)
}

// SetRevocationPublisher announces expired OAuth2 access tokens so streams
// authenticated by them stop instead of surviving until disconnect.
func (c *AuthCleaner) SetRevocationPublisher(p revocation.Publisher) {
	c.revocations = p
}

// defaultAuthCleanupInterval is used when a non-positive interval is supplied.
// time.NewTicker panics on d<=0, and Start creates the ticker synchronously, so
// a misconfigured interval (e.g. SMITHERS_CLEANUP_AUTH_INTERVAL=-5m or 0s, which
// time.ParseDuration accepts) would otherwise crash the server at boot.
const defaultAuthCleanupInterval = 5 * time.Minute

// NewAuthCleaner creates a new AuthCleaner.
func NewAuthCleaner(store CleanupStore, interval time.Duration) *AuthCleaner {
	if interval <= 0 {
		interval = defaultAuthCleanupInterval
	}
	return &AuthCleaner{
		store:    store,
		interval: interval,
		stopCh:   make(chan struct{}),
		newTicker: func(d time.Duration) ticker {
			return &realTicker{t: time.NewTicker(d)}
		},
	}
}

// Start begins the periodic cleanup loop.
func (c *AuthCleaner) Start(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.running {
		return
	}
	c.running = true

	c.ticker = c.newTicker(c.interval)
	c.wg.Add(1)
	go c.loop(ctx)
}

// loop runs the cleanup loop until stopped.
func (c *AuthCleaner) loop(ctx context.Context) {
	defer c.wg.Done()
	defer c.ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-c.stopCh:
			return
		case <-c.ticker.Chan():
			_ = c.sweep(ctx)
		}
	}
}

// sweep performs a single cleanup pass.
func (c *AuthCleaner) sweep(ctx context.Context) error {
	var errs []error

	if err := c.store.DeleteExpiredSessions(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired sessions: %w", err))
	}
	if err := c.store.DeleteExpiredNonces(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired nonces: %w", err))
	}
	if err := c.store.DeleteExpiredOAuthStates(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired oauth states: %w", err))
	}
	if err := c.store.DeleteExpiredLinearOAuthSetups(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired linear oauth setups: %w", err))
	}
	if err := c.store.DeleteExpiredVerificationTokens(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired verification tokens: %w", err))
	}
	if err := c.store.DeleteExpiredSSETickets(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired sse tickets: %w", err))
	}
	if deleted, err := c.store.DeleteExpiredAccessTokens(ctx); err != nil {
		errs = append(errs, fmt.Errorf("delete expired access tokens: %w", err))
	} else if deleted > 0 {
		slog.Info("pruned expired access tokens", "count", deleted)
	}
	if store, ok := c.store.(expiredOAuth2AccessTokenStore); ok {
		expired, err := store.DeleteExpiredOAuth2AccessTokens(ctx)
		if err != nil {
			errs = append(errs, fmt.Errorf("delete expired oauth2 access tokens: %w", err))
		} else {
			for _, token := range expired {
				revocation.PublishBestEffort(ctx, c.revocations, revocation.Event{
					Kind:      revocation.KindTokenRevoked,
					UserID:    token.UserID,
					TokenID:   token.ID,
					TokenHash: token.TokenHash,
					Reason:    "oauth2 access token expired",
				})
			}
		}
	}

	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}

// Stop stops the cleaner. It blocks until the current sweep completes.
func (c *AuthCleaner) Stop() {
	c.mu.Lock()
	if !c.running {
		c.mu.Unlock()
		return
	}
	c.running = false
	close(c.stopCh)
	c.mu.Unlock()

	c.wg.Wait()
}

// Wait waits for the cleaner to finish.
func (c *AuthCleaner) Wait() {
	c.wg.Wait()
}
