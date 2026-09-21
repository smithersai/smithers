package services

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// Closure-keyed golden snapshots back the NixOS compute path: every
// kind=vm / kind=desktop workspace boots an immutable image whose tag is the
// NixOS closure hash, and the first boot of each closure is baked into a
// Microsandbox snapshot so later boots clone a disk instead of pulling and
// booting the OCI image. Rows share sandbox_golden_snapshots with the
// workspace toolchain snapshot; the key is the `kind` column.

type keyedGoldenSnapshot struct {
	id string
	at time.Time
}

// goldenSnapshotKeyForImage is the sandbox_golden_snapshots.kind value for a
// NixOS environment image: "nix:<vm|desktop>:<closure-hash>".
func goldenSnapshotKeyForImage(kind, closureHash string) string {
	return "nix:" + normalizeWorkspaceKind(kind) + ":" + strings.TrimSpace(closureHash)
}

// goldenSnapshotNixReadyCheck proves a NixOS guest finished booting: systemd
// reached running/degraded and the closure's agent tools resolve through the
// FHS shim the worker's exec contract relies on.
const goldenSnapshotNixReadyCheck = "state=$(systemctl is-system-running 2>/dev/null || true); " +
	"case \"$state\" in running|degraded) ;; *) exit 1;; esac; " +
	"test -x /usr/local/bin/jj && test -x /usr/local/bin/bun && test -x /usr/local/bin/node && test -x /usr/local/bin/git"

// CurrentFor returns the newest ready snapshot for a closure key, or "" when
// none exists (callers boot the bare image). Never returns an error.
func (s *GoldenSnapshotService) CurrentFor(ctx context.Context, key string) string {
	if s == nil || s.db == nil || strings.TrimSpace(key) == "" {
		return ""
	}
	s.mu.Lock()
	if cached, ok := s.keyed[key]; ok && time.Since(cached.at) < goldenSnapshotCacheTTL {
		s.mu.Unlock()
		return cached.id
	}
	s.mu.Unlock()

	var (
		id        string
		createdAt time.Time
	)
	if err := s.db.QueryRow(ctx, latestReadyGoldenSnapshotSQL, key).Scan(&id, &createdAt); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.Warn("keyed golden snapshot lookup failed", "key", key, "error", err)
		}
		id = ""
	}
	s.rememberKeyed(key, id)
	return id
}

func (s *GoldenSnapshotService) rememberKeyed(key, id string) {
	s.mu.Lock()
	if s.keyed == nil {
		s.keyed = map[string]keyedGoldenSnapshot{}
	}
	s.keyed[key] = keyedGoldenSnapshot{id: id, at: time.Now()}
	s.mu.Unlock()
}

// MarkBadFor retires a closure-keyed snapshot the provider rejected at VM
// create. Same differential-signal contract as MarkBad.
func (s *GoldenSnapshotService) MarkBadFor(ctx context.Context, key, snapshotID string) {
	if s == nil || s.db == nil || strings.TrimSpace(key) == "" || strings.TrimSpace(snapshotID) == "" {
		return
	}
	bg := context.WithoutCancel(ctx)
	if _, err := s.db.Exec(bg, markBadGoldenSnapshotSQL, key, snapshotID); err != nil {
		slog.Warn("keyed golden snapshot mark-bad failed", "key", key, "snapshot_id", snapshotID, "error", err)
		return
	}
	s.rememberKeyed(key, "")
	slog.Warn("keyed golden snapshot invalidated after vm-create rejection", "key", key, "snapshot_id", snapshotID)
}

// EnsureBake bakes a snapshot for key in the background when none is ready
// and no bake is in flight (locally or, via the partial unique index, on any
// pod). It returns immediately; the caller boots the bare image meanwhile.
// build must return the exact request workspaces of that closure boot, minus
// repository-specific state (see WorkspaceService.NixBakeVMRequest).
func (s *GoldenSnapshotService) EnsureBake(ctx context.Context, key string, build func() sandbox.CreateRequest) {
	if s == nil || s.db == nil || s.sandbox == nil || build == nil || strings.TrimSpace(key) == "" {
		return
	}
	if s.CurrentFor(ctx, key) != "" {
		return
	}
	s.mu.Lock()
	if s.inflight == nil {
		s.inflight = map[string]struct{}{}
	}
	if _, busy := s.inflight[key]; busy {
		s.mu.Unlock()
		return
	}
	s.inflight[key] = struct{}{}
	s.mu.Unlock()

	go func() {
		bg := context.WithoutCancel(ctx)
		defer func() {
			s.mu.Lock()
			delete(s.inflight, key)
			s.mu.Unlock()
		}()
		s.bakeKey(bg, key, build)
	}()
}

func (s *GoldenSnapshotService) bakeKey(ctx context.Context, key string, build func() sandbox.CreateRequest) {
	var (
		id        string
		createdAt time.Time
	)
	err := s.db.QueryRow(ctx, latestReadyGoldenSnapshotSQL, key).Scan(&id, &createdAt)
	if err == nil {
		s.rememberKeyed(key, id)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		slog.Warn("keyed golden snapshot freshness check failed", "key", key, "error", err)
		return
	}
	s.reclaimStaleBakingFor(ctx, key)

	var rowID string
	if err := s.db.QueryRow(ctx, insertGoldenSnapshotBakingSQL, key).Scan(&rowID); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.Warn("keyed golden snapshot bake claim failed", "key", key, "error", err)
		}
		return // another pod holds the baking slot for this key
	}

	snapshotID, bakeErr := s.bakeWith(ctx, rowID, build, goldenSnapshotNixReadyCheck)
	status := "ready"
	if bakeErr != nil {
		status = "failed"
		snapshotID = ""
		slog.Error("keyed golden snapshot bake failed", "key", key, "error", bakeErr)
	}
	var finished string
	if err := s.db.QueryRow(ctx, finishGoldenSnapshotSQL, rowID, status, snapshotID).Scan(&finished); err != nil {
		slog.Warn("keyed golden snapshot finish write failed", "key", key, "row_id", rowID, "error", err)
		if bakeErr == nil {
			delCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			if delErr := s.sandbox.DeleteSnapshot(delCtx, snapshotID); delErr != nil && !vmAlreadyGone(delErr) {
				slog.Warn("keyed golden snapshot orphan delete failed", "key", key, "snapshot_id", snapshotID, "error", delErr)
			}
		}
		return
	}
	if bakeErr == nil {
		s.rememberKeyed(key, snapshotID)
		slog.Info("keyed golden snapshot baked", "key", key, "snapshot_id", snapshotID)
		s.gcSupersededSnapshotsFor(ctx, key, finished)
	}
}
