package services

import (
	"context"
	"log/slog"
	"time"
)

// A failed bake is terminal. Its builder is infrastructure, never a workspace.
// Keep failed cleanup discoverable in the placement table until DeleteSandbox
// completes; do not remove the build row or its snapshots here.
const failedGoldenSnapshotBuildersSQL = `
SELECT i.id, g.id::text
FROM sandbox_instances i
JOIN sandbox_golden_snapshots g ON g.id::text=i.resource_id
WHERE i.resource_kind='golden_snapshot_bake'
  AND i.deleted_at IS NULL AND g.status='failed'
ORDER BY i.created_at
LIMIT 20;`

func (s *GoldenSnapshotService) cleanupFailedBuilders(ctx context.Context) {
	if s == nil || s.db == nil || s.sandbox == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, failedGoldenSnapshotBuildersSQL)
	if err != nil {
		slog.Warn("failed golden builder lookup failed", "error", err)
		return
	}
	type builder struct{ vm, build string }
	var pending []builder
	for rows.Next() {
		var item builder
		if err := rows.Scan(&item.vm, &item.build); err != nil {
			rows.Close()
			slog.Warn("failed golden builder scan failed", "error", err)
			return
		}
		pending = append(pending, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		slog.Warn("failed golden builder lookup failed", "error", err)
		return
	}
	for _, item := range pending {
		if ctx.Err() != nil {
			return
		}
		if err := s.sandbox.DeleteSandbox(ctx, item.vm); err != nil {
			slog.Warn("failed golden builder cleanup will retry", "vm_id", item.vm, "build_id", item.build, "error", err)
		}
	}
}

func (s *GoldenSnapshotService) cleanupFailedBuildersLoop(ctx context.Context) {
	s.cleanupFailedBuilders(ctx)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.cleanupFailedBuilders(ctx)
		}
	}
}
