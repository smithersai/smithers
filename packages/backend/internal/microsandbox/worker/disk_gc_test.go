package worker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
)

type fakeDiskCache struct {
	images           []cachedImage
	snapshots        []cachedSnapshot
	removedImages    []string
	removedSnapshots []string
	imageErrors      map[string]error
	snapshotErrors   map[string]error
}

func (f *fakeDiskCache) listImages(context.Context) ([]cachedImage, error) {
	return append([]cachedImage(nil), f.images...), nil
}

func (f *fakeDiskCache) removeImage(_ context.Context, image string) error {
	if err := f.imageErrors[image]; err != nil {
		return err
	}
	f.removedImages = append(f.removedImages, image)
	return nil
}

func (f *fakeDiskCache) listSnapshots(context.Context) ([]cachedSnapshot, error) {
	return append([]cachedSnapshot(nil), f.snapshots...), nil
}

func (f *fakeDiskCache) removeSnapshot(_ context.Context, snapshot string) error {
	if err := f.snapshotErrors[snapshot]; err != nil {
		return err
	}
	f.removedSnapshots = append(f.removedSnapshots, snapshot)
	return nil
}

func TestRunDiskGCProtectsControllerReferencesAndEvictsLRU(t *testing.T) {
	now := time.Now()
	cache := &fakeDiskCache{
		images: []cachedImage{
			{reference: "registry/ready:one", lastUsed: now.Add(-4 * time.Hour)},
			{reference: "registry/snapshot:one", lastUsed: now.Add(-3 * time.Hour)},
			{reference: "registry/oldest:one", lastUsed: now.Add(-2 * time.Hour)},
			{reference: "registry/newer:one", lastUsed: now.Add(-time.Hour)},
		},
		snapshots: []cachedSnapshot{
			{id: "parent", digest: "digest-parent", image: "registry/snapshot:one", createdAt: now.Add(-24 * time.Hour)},
			{id: "golden", digest: "digest-golden", parentDigest: "digest-parent", image: "registry/snapshot:one", createdAt: now.Add(-23 * time.Hour)},
			{id: "orphan", digest: "digest-orphan", image: "registry/orphan:one", createdAt: now.Add(-22 * time.Hour)},
			{id: "handoff", digest: "digest-handoff", image: "registry/handoff:one", createdAt: now.Add(-10 * time.Minute)},
		},
	}
	usageReads := 0
	readUsage := func(string) (DiskUsage, error) {
		usageReads++
		switch usageReads {
		case 1:
			return DiskUsage{TotalBytes: 100, AvailableBytes: 20}, nil
		case 2:
			return DiskUsage{TotalBytes: 100, AvailableBytes: 30}, nil
		default:
			return DiskUsage{TotalBytes: 100, AvailableBytes: 45}, nil
		}
	}

	report, err := runDiskGC(context.Background(), cache, readUsage, "/state", .60, time.Hour, msb.WorkerDiskGCProtection{
		Images: []string{"registry/ready:one"}, Snapshots: []string{"golden"},
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"orphan"}, cache.removedSnapshots)
	assert.Equal(t, []string{"registry/oldest:one", "registry/newer:one"}, cache.removedImages)
	assert.Equal(t, 1, report.SnapshotsRemoved)
	assert.Equal(t, 2, report.ImagesRemoved)
	assert.InDelta(t, .55, report.After.Ratio(), .001)
}

func TestRunDiskGCKeepsImageWhenSnapshotRemovalFails(t *testing.T) {
	now := time.Now().Add(-24 * time.Hour)
	cache := &fakeDiskCache{
		images:         []cachedImage{{reference: "registry/pinned:one", lastUsed: now}},
		snapshots:      []cachedSnapshot{{id: "orphan", digest: "digest", image: "registry/pinned:one", createdAt: now}},
		snapshotErrors: map[string]error{"orphan": errors.New("busy")},
	}
	usage := func(string) (DiskUsage, error) {
		return DiskUsage{TotalBytes: 100, AvailableBytes: 10}, nil
	}

	_, err := runDiskGC(context.Background(), cache, usage, "/state", .60, 0, msb.WorkerDiskGCProtection{})
	require.Error(t, err)
	assert.Empty(t, cache.removedImages)
}

func TestCleanupDiskCacheTemporary(t *testing.T) {
	root := t.TempDir()
	temporary := filepath.Join(root, "cache", "tmp")
	require.NoError(t, os.MkdirAll(filepath.Join(temporary, "aborted.work"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(temporary, "layer.part"), []byte("partial"), 0o600))

	require.NoError(t, cleanupDiskCacheTemporary(root))
	entries, err := os.ReadDir(temporary)
	require.NoError(t, err)
	assert.Empty(t, entries)
}

func TestDiskUsageRatio(t *testing.T) {
	assert.InDelta(t, .75, (DiskUsage{TotalBytes: 200, AvailableBytes: 50}).Ratio(), .001)
	assert.Zero(t, (DiskUsage{}).Ratio())
}
