// Package runtimeports defines deployment-neutral runtime collaborators.
package runtimeports

import (
	"context"
	"time"
)

type GoldenSnapshotVictim struct{ ID, SnapshotID string }
type GoldenSnapshotBuilder struct{ VMID, BuildID string }

// GoldenSnapshotStore supplies persistence; the shared service owns baking and GC policy.
// List methods must return an error for incomplete reads before any provider deletion.
type GoldenSnapshotStore interface {
	LatestReadyGoldenSnapshot(context.Context, string) (string, time.Time, error)
	ClaimGoldenSnapshotBake(context.Context, string) (string, error)
	FinishGoldenSnapshot(context.Context, string, string, string) (string, error)
	ReclaimStaleGoldenSnapshot(context.Context, string, int64) (string, error)
	SupersedeGoldenSnapshots(context.Context, string, string) error
	ExpiredGoldenSnapshots(context.Context, string, int64) ([]GoldenSnapshotVictim, error)
	DeleteGoldenSnapshot(context.Context, string) error
	MarkBadGoldenSnapshot(context.Context, string, string) error
	FailedGoldenSnapshotBuilders(context.Context) ([]GoldenSnapshotBuilder, error)
}
