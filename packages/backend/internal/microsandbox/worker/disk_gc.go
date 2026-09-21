package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	upstream "github.com/superradcompany/microsandbox/sdk/go"
	"golang.org/x/sys/unix"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
)

// DiskUsage is the worker data filesystem's physical utilization.
type DiskUsage struct {
	TotalBytes     uint64
	AvailableBytes uint64
}

func (usage DiskUsage) Ratio() float64 {
	if usage.TotalBytes == 0 || usage.AvailableBytes >= usage.TotalBytes {
		return 0
	}
	return float64(usage.TotalBytes-usage.AvailableBytes) / float64(usage.TotalBytes)
}

// DiskGCReport summarizes one worker-local maintenance pass.
type DiskGCReport struct {
	SnapshotsRemoved int
	ImagesRemoved    int
	Before           DiskUsage
	After            DiskUsage
}

type cachedImage struct {
	reference string
	lastUsed  time.Time
}

type cachedSnapshot struct {
	id           string
	digest       string
	parentDigest string
	image        string
	createdAt    time.Time
}

type diskCacheBackend interface {
	listImages(context.Context) ([]cachedImage, error)
	removeImage(context.Context, string) error
	listSnapshots(context.Context) ([]cachedSnapshot, error)
	removeSnapshot(context.Context, string) error
}

type upstreamDiskCache struct{}

func (upstreamDiskCache) listImages(ctx context.Context) ([]cachedImage, error) {
	handles, err := upstream.Image.List(ctx)
	if err != nil {
		return nil, err
	}
	images := make([]cachedImage, 0, len(handles))
	for _, handle := range handles {
		lastUsed := handle.LastUsedAt()
		if lastUsed.IsZero() {
			lastUsed = handle.CreatedAt()
		}
		images = append(images, cachedImage{reference: handle.Reference(), lastUsed: lastUsed})
	}
	return images, nil
}

func (upstreamDiskCache) removeImage(ctx context.Context, reference string) error {
	// force=false makes the runtime reject removal when any live or suspended
	// sandbox still pins the manifest. Disk GC never overrides that guard.
	return upstream.Image.Remove(ctx, reference, false)
}

func (upstreamDiskCache) listSnapshots(ctx context.Context) ([]cachedSnapshot, error) {
	handles, err := upstream.Snapshot.List(ctx)
	if err != nil {
		return nil, err
	}
	snapshots := make([]cachedSnapshot, 0, len(handles))
	for _, handle := range handles {
		id := handle.Digest()
		if name := handle.Name(); name != nil && strings.TrimSpace(*name) != "" {
			id = strings.TrimSpace(*name)
		}
		parent := ""
		if digest := handle.ParentDigest(); digest != nil {
			parent = strings.TrimSpace(*digest)
		}
		snapshots = append(snapshots, cachedSnapshot{
			id: id, digest: handle.Digest(), parentDigest: parent,
			image: handle.ImageRef(), createdAt: handle.CreatedAt(),
		})
	}
	return snapshots, nil
}

func (upstreamDiskCache) removeSnapshot(ctx context.Context, id string) error {
	return upstream.Snapshot.Remove(ctx, id, true)
}

// DefaultDiskCacheRoot returns the hostPath-backed Microsandbox data root.
func DefaultDiskCacheRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".microsandbox"), nil
}

// CleanupDiskCacheTemporary removes interrupted image downloads and
// materialization work directories. It runs before the SDK starts and after a
// failed create, while the runtime maintenance lock excludes concurrent pulls.
func (r *SDKRuntime) CleanupDiskCacheTemporary(root string) error {
	r.maintenance.Lock()
	defer r.maintenance.Unlock()
	return cleanupDiskCacheTemporary(root)
}

func cleanupDiskCacheTemporary(root string) error {
	temporary := filepath.Join(root, "cache", "tmp")
	if err := os.RemoveAll(temporary); err != nil {
		return fmt.Errorf("remove Microsandbox cache temporary directory: %w", err)
	}
	if err := os.MkdirAll(temporary, 0o700); err != nil {
		return fmt.Errorf("recreate Microsandbox cache temporary directory: %w", err)
	}
	return nil
}

// DiskUsageAt reads utilization for the filesystem containing path.
func DiskUsageAt(path string) (DiskUsage, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return DiskUsage{}, err
	}
	if stat.Bsize <= 0 {
		return DiskUsage{}, errors.New("filesystem reported a non-positive block size")
	}
	blockSize := uint64(stat.Bsize)
	return DiskUsage{
		TotalBytes:     stat.Blocks * blockSize,
		AvailableBytes: stat.Bavail * blockSize,
	}, nil
}

// RunDiskGC removes controller-unreferenced snapshots, then evicts unprotected
// cached images in LRU order until the host filesystem is below highWater.
// Registered ready images arrive through the signed controller heartbeat.
func (r *SDKRuntime) RunDiskGC(ctx context.Context, root string, highWater float64, orphanGrace time.Duration, protection msb.WorkerDiskGCProtection) (DiskGCReport, error) {
	r.maintenance.Lock()
	defer r.maintenance.Unlock()
	return runDiskGC(ctx, upstreamDiskCache{}, DiskUsageAt, root, highWater, orphanGrace, protection)
}

type diskUsageReader func(string) (DiskUsage, error)

func runDiskGC(ctx context.Context, backend diskCacheBackend, readUsage diskUsageReader, root string, highWater float64, orphanGrace time.Duration, protection msb.WorkerDiskGCProtection) (DiskGCReport, error) {
	if highWater <= 0 || highWater >= 1 {
		return DiskGCReport{}, fmt.Errorf("disk GC high-water ratio must be between 0 and 1")
	}
	if orphanGrace < 0 {
		orphanGrace = 0
	}
	report := DiskGCReport{}
	var maintenanceErrors []error

	snapshots, err := backend.listSnapshots(ctx)
	if err != nil {
		return report, fmt.Errorf("list Microsandbox snapshots: %w", err)
	}
	protectedSnapshots := make(map[string]struct{}, len(protection.Snapshots))
	for _, id := range protection.Snapshots {
		if id = strings.TrimSpace(id); id != "" {
			protectedSnapshots[id] = struct{}{}
		}
	}
	// A protected child requires its complete parent chain. The controller
	// references snapshots by local name while the local index links by digest.
	byDigest := make(map[string]cachedSnapshot, len(snapshots))
	for _, snapshot := range snapshots {
		byDigest[snapshot.digest] = snapshot
	}
	for _, snapshot := range snapshots {
		if _, protected := protectedSnapshots[snapshot.id]; !protected {
			continue
		}
		for parent := snapshot.parentDigest; parent != ""; {
			ancestor, exists := byDigest[parent]
			if !exists {
				break
			}
			protectedSnapshots[ancestor.id] = struct{}{}
			parent = ancestor.parentDigest
		}
	}

	now := time.Now()
	retainedSnapshotImages := make(map[string]struct{})
	for _, snapshot := range snapshots {
		_, protected := protectedSnapshots[snapshot.id]
		tooYoung := !snapshot.createdAt.IsZero() && now.Sub(snapshot.createdAt) < orphanGrace
		if protected || tooYoung {
			if snapshot.image != "" {
				retainedSnapshotImages[snapshot.image] = struct{}{}
			}
			continue
		}
		if err := backend.removeSnapshot(ctx, snapshot.id); err != nil {
			maintenanceErrors = append(maintenanceErrors, fmt.Errorf("remove unreferenced snapshot %s: %w", snapshot.id, err))
			// A failed deletion still pins its backing image.
			if snapshot.image != "" {
				retainedSnapshotImages[snapshot.image] = struct{}{}
			}
			continue
		}
		report.SnapshotsRemoved++
	}

	report.Before, err = readUsage(root)
	if err != nil {
		return report, errors.Join(append(maintenanceErrors, fmt.Errorf("read worker disk usage: %w", err))...)
	}
	report.After = report.Before
	if report.Before.Ratio() <= highWater {
		return report, errors.Join(maintenanceErrors...)
	}

	images, err := backend.listImages(ctx)
	if err != nil {
		return report, errors.Join(append(maintenanceErrors, fmt.Errorf("list cached images: %w", err))...)
	}
	protectedImages := make(map[string]struct{}, len(protection.Images)+len(retainedSnapshotImages))
	for _, image := range protection.Images {
		if image = strings.TrimSpace(image); image != "" {
			protectedImages[image] = struct{}{}
		}
	}
	for image := range retainedSnapshotImages {
		protectedImages[image] = struct{}{}
	}
	sort.Slice(images, func(i, j int) bool {
		if images[i].lastUsed.Equal(images[j].lastUsed) {
			return images[i].reference < images[j].reference
		}
		return images[i].lastUsed.Before(images[j].lastUsed)
	})
	for _, image := range images {
		if report.After.Ratio() <= highWater {
			break
		}
		if _, protected := protectedImages[image.reference]; protected {
			continue
		}
		if err := backend.removeImage(ctx, image.reference); err != nil {
			// In-use images are expected candidates: the upstream force=false
			// guard is the final race-free protection for live/stopped guests.
			slog.Debug("Microsandbox disk GC kept cached image", "image", image.reference, "error", err)
			continue
		}
		report.ImagesRemoved++
		usage, usageErr := readUsage(root)
		if usageErr != nil {
			maintenanceErrors = append(maintenanceErrors, fmt.Errorf("refresh worker disk usage: %w", usageErr))
			break
		}
		report.After = usage
	}
	return report, errors.Join(maintenanceErrors...)
}
