package repohostserver

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Push events are durable from the moment git's receive-pack response is
// sent: each changed ref is written to an outbox file under StoragePath
// before the response, delivered right away, and replayed until the API
// acknowledges it. The API deduplicates on delivery_id, so a redelivery
// after a timeout that the API had in fact processed is harmless.
const (
	pushHookOutboxDirName = ".push-hook-outbox@"
	pushHookDeadDirName   = ".push-hook-dead@"

	pushHookReplayInterval   = 30 * time.Second
	pushHookRetryBaseBackoff = 5 * time.Second
	pushHookRetryMaxBackoff  = 10 * time.Minute
	// An event the API has refused for this long is moved to the dead
	// directory and counted as expired instead of being retried forever.
	pushHookMaxAge = 24 * time.Hour
)

// Delivery results recorded on smithers_repo_host_push_hook_deliveries_total.
const (
	pushHookResultOK       = "ok"
	pushHookResultRetry    = "retry"
	pushHookResultExpired  = "expired"
	pushHookResultNotFound = "not_found"
)

type pushHookOutboxEntry struct {
	Payload       PushHookPayload `json:"payload"`
	Attempts      int             `json:"attempts"`
	CreatedAt     time.Time       `json:"created_at"`
	NextAttemptAt time.Time       `json:"next_attempt_at"`
	LastError     string          `json:"last_error,omitempty"`
}

// pushHookOutbox reads config, client, logger and metrics from its server
// on each use, so a test that rewires the server after construction is seen.
type pushHookOutbox struct {
	server *Server
	now    func() time.Time

	mu       sync.Mutex
	inFlight map[string]struct{}
}

func newPushHookOutbox(server *Server) *pushHookOutbox {
	return &pushHookOutbox{server: server, now: time.Now, inFlight: make(map[string]struct{})}
}

func (o *pushHookOutbox) root() string {
	return filepath.Join(o.server.config.StoragePath, pushHookOutboxDirName)
}

func (o *pushHookOutbox) dead() string {
	return filepath.Join(o.server.config.StoragePath, pushHookDeadDirName)
}

func (o *pushHookOutbox) log() *slog.Logger {
	if o.server.logger != nil {
		return o.server.logger
	}
	return slog.New(slog.DiscardHandler)
}

func newPushHookDeliveryID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate push hook delivery id: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

func (o *pushHookOutbox) entryPath(payload PushHookPayload) string {
	return filepath.Join(o.root(), payload.Owner, payload.Repo, payload.DeliveryID+".json")
}

// persist assigns each payload a delivery id and durably writes it. On any
// failure it removes what it wrote, so the caller can roll the push back
// knowing no event for it will be delivered.
func (o *pushHookOutbox) persist(payloads []PushHookPayload) ([]string, error) {
	now := o.now().UTC()
	paths := make([]string, 0, len(payloads))
	for i := range payloads {
		if payloads[i].DeliveryID == "" {
			id, err := newPushHookDeliveryID()
			if err != nil {
				o.discard(paths)
				return nil, err
			}
			payloads[i].DeliveryID = id
		}
		path := o.entryPath(payloads[i])
		entry := pushHookOutboxEntry{Payload: payloads[i], CreatedAt: now, NextAttemptAt: now}
		if err := writeDurableJSON(path, entry); err != nil {
			o.discard(paths)
			return nil, fmt.Errorf("persist push event %s: %w", payloads[i].RefName, err)
		}
		paths = append(paths, path)
	}
	return paths, nil
}

func (o *pushHookOutbox) discard(paths []string) {
	for _, path := range paths {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			o.log().Error("discard push hook outbox entry failed", "path", path, "error", err)
		}
	}
}

// deliverPaths attempts each persisted entry once now. A failure for one ref
// never skips the remaining refs; the replay loop retries it later.
func (o *pushHookOutbox) deliverPaths(ctx context.Context, paths []string) {
	for _, path := range paths {
		o.deliverFile(ctx, path, true)
	}
}

// replay delivers every entry whose backoff has elapsed, oldest first, and
// reports how many entries remain pending afterwards.
func (o *pushHookOutbox) replay(ctx context.Context) int {
	var paths []string
	err := filepath.WalkDir(o.root(), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if !d.IsDir() && strings.HasSuffix(path, ".json") {
			paths = append(paths, path)
		}
		return nil
	})
	if err != nil {
		o.log().Error("scan push hook outbox failed", "error", err)
	}
	sort.Strings(paths)
	for _, path := range paths {
		if ctx.Err() != nil {
			break
		}
		o.deliverFile(ctx, path, false)
	}
	return o.pending()
}

func (o *pushHookOutbox) pending() int {
	count := 0
	_ = filepath.WalkDir(o.root(), func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(path, ".json") {
			count++
		}
		return nil
	})
	if o.server.metrics != nil {
		o.server.metrics.SetPushHookOutboxPending(count)
	}
	return count
}

func (o *pushHookOutbox) claim(path string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if _, busy := o.inFlight[path]; busy {
		return false
	}
	o.inFlight[path] = struct{}{}
	return true
}

func (o *pushHookOutbox) release(path string) {
	o.mu.Lock()
	delete(o.inFlight, path)
	o.mu.Unlock()
}

func (o *pushHookOutbox) deliverFile(ctx context.Context, path string, immediate bool) {
	if !o.claim(path) {
		return
	}
	defer o.release(path)

	var entry pushHookOutboxEntry
	content, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			o.log().Error("read push hook outbox entry failed", "path", path, "error", err)
		}
		return
	}
	if err := json.Unmarshal(content, &entry); err != nil {
		o.moveToDead(path, "unreadable outbox entry: "+err.Error())
		return
	}
	now := o.now().UTC()
	if !immediate && now.Before(entry.NextAttemptAt) {
		return
	}

	deliverCtx, cancel := context.WithTimeout(ctx, pushHookDeliveryTimeout)
	result, sendErr := sendPushHookResult(deliverCtx, o.server.httpClient, o.server.config, entry.Payload)
	cancel()
	if sendErr == nil {
		o.remove(path)
		o.record(result)
		return
	}

	entry.Attempts++
	entry.LastError = sendErr.Error()
	if now.Sub(entry.CreatedAt) >= pushHookMaxAge {
		o.moveToDead(path, sendErr.Error())
		return
	}
	entry.NextAttemptAt = now.Add(pushHookRetryBackoff(entry.Attempts))
	if err := writeDurableJSON(path, entry); err != nil {
		o.log().Error("update push hook outbox entry failed", "path", path, "error", err)
	}
	o.record(pushHookResultRetry)
	o.log().Warn("push hook callback failed; will retry",
		"ref_name", entry.Payload.RefName,
		"delivery_id", entry.Payload.DeliveryID,
		"attempts", entry.Attempts,
		"next_attempt_at", entry.NextAttemptAt,
		"error", sendErr)
}

func (o *pushHookOutbox) remove(path string) {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		o.log().Error("remove delivered push hook outbox entry failed", "path", path, "error", err)
		return
	}
	_ = syncDirectory(filepath.Dir(path))
}

func (o *pushHookOutbox) moveToDead(path, reason string) {
	rel, err := filepath.Rel(o.root(), path)
	if err != nil {
		rel = filepath.Base(path)
	}
	target := filepath.Join(o.dead(), rel)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err == nil {
		err = os.Rename(path, target)
		if err == nil {
			_ = syncDirectory(filepath.Dir(target))
			_ = syncDirectory(filepath.Dir(path))
		}
	}
	if err != nil {
		o.log().Error("move expired push hook outbox entry failed", "path", path, "error", err)
	}
	o.record(pushHookResultExpired)
	o.log().Error("push hook event expired undelivered", "path", path, "dead_path", target, "reason", reason)
}

func (o *pushHookOutbox) record(result string) {
	if o.server.metrics != nil {
		o.server.metrics.RecordPushHookDelivery(result)
	}
}

// pushHookRetryBackoff doubles the delay per failed attempt (attempts >= 1).
func pushHookRetryBackoff(attempts int) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	shift := attempts - 1
	if shift > 16 {
		return pushHookRetryMaxBackoff
	}
	backoff := pushHookRetryBaseBackoff << shift
	if backoff > pushHookRetryMaxBackoff {
		return pushHookRetryMaxBackoff
	}
	return backoff
}

// runReplay replays the outbox on start and then every interval until ctx
// ends. Entries a previous process left behind are delivered on the first
// pass.
func (o *pushHookOutbox) runReplay(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		o.replay(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// writeDurableJSON writes v to path via a synced temp file and rename, then
// syncs the parent directory so the entry survives a crash.
func writeDurableJSON(path string, v any) error {
	dir := filepath.Dir(path)
	if err := ensureDurableDirectory(dir, 0o755); err != nil {
		return err
	}
	body, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("write %s: %w", tmpName, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("sync %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return fmt.Errorf("rename %s: %w", tmpName, err)
	}
	return syncDirectory(dir)
}
