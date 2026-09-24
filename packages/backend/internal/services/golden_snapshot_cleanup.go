package services

import (
	"context"
	"log/slog"
	"time"
)

func (s *GoldenSnapshotService) cleanupFailedBuilders(ctx context.Context) {
	if s == nil || s.db == nil || s.sandbox == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pending, err := s.db.FailedGoldenSnapshotBuilders(ctx)
	if err != nil {
		slog.Warn("failed golden builder lookup failed", "error", err)
		return
	}

	for _, item := range pending {
		if ctx.Err() != nil {
			return
		}
		if err := s.sandbox.DeleteSandbox(ctx, item.VMID); err != nil {
			slog.Warn("failed golden builder cleanup will retry", "vm_id", item.VMID, "build_id", item.BuildID, "error", err)
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
