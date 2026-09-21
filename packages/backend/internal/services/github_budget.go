// Package services — GitHub installation API budget tracker.
//
// GitHub gives each app installation a rolling 5,000 req/hour budget. Once
// it's gone we get 403 + abuse-detection headaches that taint the whole
// installation for an hour. This tracker lets the proxy layer (and any future
// outbound client) cheaply ask "do I have headroom?" before issuing a call.
//
// Status: wired into the GitHub proxy layer (`github_proxy.go`) through
// WithGitHubProxyBudgetTracker; callers can also manually call Allow from
// other outbound code paths that share the same per-installation budget.
package services

import (
	"math"
	"sync"
	"time"
)

// GitHubInstallationHourlyBudget is GitHub's documented per-installation
// rate-limit budget for app-authenticated requests.
const GitHubInstallationHourlyBudget = 5000

// BudgetTracker is a process-local, thread-safe counter of GitHub API
// requests per installation_id over a rolling window. It uses a simple
// token-bucket model: each installation gets `capacity` tokens that refill
// linearly over `window`.
type BudgetTracker struct {
	mu       sync.Mutex
	buckets  map[int64]*budgetEntry
	capacity int
	window   time.Duration
	now      func() time.Time
}

type budgetEntry struct {
	tokens     float64
	lastRefill time.Time
}

// GitHubRateLimit is a point-in-time view of an installation's locally
// tracked GitHub API budget. ResetAt is when the bucket will be full again.
type GitHubRateLimit struct {
	Limit     int
	Remaining int
	ResetAt   time.Time
}

// NewBudgetTracker returns a tracker with the default 5000/hour budget.
func NewBudgetTracker() *BudgetTracker {
	return NewBudgetTrackerWithLimits(GitHubInstallationHourlyBudget, time.Hour)
}

// NewBudgetTrackerWithLimits is the configurable constructor (for tests).
func NewBudgetTrackerWithLimits(capacity int, window time.Duration) *BudgetTracker {
	if capacity <= 0 {
		capacity = GitHubInstallationHourlyBudget
	}
	if window <= 0 {
		window = time.Hour
	}
	return &BudgetTracker{
		buckets:  make(map[int64]*budgetEntry),
		capacity: capacity,
		window:   window,
		now:      func() time.Time { return time.Now().UTC() },
	}
}

// Allow returns true if the given installation has at least one request of
// budget remaining and consumes it. Returns false (and the duration until the
// bucket's full reset) if the bucket is empty.
func (t *BudgetTracker) Allow(installationID int64) (allowed bool, retryAfter time.Duration) {
	allowed, retryAfter, _ = t.AllowWithStatus(installationID)
	return allowed, retryAfter
}

// AllowWithStatus consumes one request from an installation's budget and
// returns the resulting budget snapshot. When the request is refused,
// retryAfter is the duration until ResetAt.
func (t *BudgetTracker) AllowWithStatus(installationID int64) (allowed bool, retryAfter time.Duration, status GitHubRateLimit) {
	if t == nil {
		return true, 0, GitHubRateLimit{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	now := t.now().UTC()
	entry := t.refillLocked(installationID, now)

	if entry.tokens >= 1 {
		entry.tokens -= 1
		return true, 0, t.statusLocked(entry.tokens, now)
	}

	status = t.statusLocked(entry.tokens, now)
	return false, status.ResetAt.Sub(now), status
}

// Remaining returns the current approximate remaining budget for an
// installation. Useful for observability / metrics.
func (t *BudgetTracker) Remaining(installationID int64) int {
	return t.Status(installationID).Remaining
}

// Status returns the current limit, remaining requests, and full reset time
// for an installation without consuming budget.
func (t *BudgetTracker) Status(installationID int64) GitHubRateLimit {
	if t == nil {
		return GitHubRateLimit{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	now := t.now().UTC()
	_, ok := t.buckets[installationID]
	if !ok {
		return GitHubRateLimit{
			Limit:     t.capacity,
			Remaining: t.capacity,
			ResetAt:   now.Add(t.window),
		}
	}
	entry := t.refillLocked(installationID, now)
	return t.statusLocked(entry.tokens, now)
}

func (t *BudgetTracker) refillLocked(installationID int64, now time.Time) *budgetEntry {
	refillPerSecond := float64(t.capacity) / t.window.Seconds()
	entry, ok := t.buckets[installationID]
	if !ok {
		entry = &budgetEntry{tokens: float64(t.capacity), lastRefill: now}
		t.buckets[installationID] = entry
		return entry
	}

	elapsed := now.Sub(entry.lastRefill).Seconds()
	if elapsed > 0 {
		entry.tokens += elapsed * refillPerSecond
		if entry.tokens > float64(t.capacity) {
			entry.tokens = float64(t.capacity)
		}
		entry.lastRefill = now
	}
	return entry
}

func (t *BudgetTracker) statusLocked(tokens float64, now time.Time) GitHubRateLimit {
	if tokens < 0 {
		tokens = 0
	}
	if tokens > float64(t.capacity) {
		tokens = float64(t.capacity)
	}

	secondsUntilFull := (float64(t.capacity) - tokens) / (float64(t.capacity) / t.window.Seconds())
	resetAfter := time.Duration(math.Ceil(secondsUntilFull)) * time.Second
	if resetAfter <= 0 {
		resetAfter = t.window
	}
	return GitHubRateLimit{
		Limit:     t.capacity,
		Remaining: int(tokens),
		ResetAt:   now.Add(resetAfter),
	}
}
