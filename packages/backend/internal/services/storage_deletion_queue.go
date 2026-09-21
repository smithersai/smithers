package services

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const purgedStorageDeletionClearTimeout = 5 * time.Second

// purgedStorageDeletionClearer is intentionally narrower than the deletion
// cleaner protocol. Services may use it only after a signer returned no
// capability, every generation of the exact object key was confirmed absent,
// and the corresponding metadata reservation was deleted. Normal deletion
// paths must retain their queue fences until previously issued capabilities
// expire.
type purgedStorageDeletionClearer interface {
	ClearPurgedStorageDeletionByExactKey(ctx context.Context, arg db.ClearPurgedStorageDeletionByExactKeyParams) (int64, error)
}

func clearPurgedStorageDeletionKeys(
	ctx context.Context,
	queries purgedStorageDeletionClearer,
	repositoryID int64,
	allocationKey string,
	objectKeys ...string,
) error {
	clearCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), purgedStorageDeletionClearTimeout)
	defer cancel()
	for _, objectKey := range objectKeys {
		if strings.TrimSpace(objectKey) == "" {
			continue
		}
		if _, err := queries.ClearPurgedStorageDeletionByExactKey(clearCtx, db.ClearPurgedStorageDeletionByExactKeyParams{
			RepositoryID:  repositoryID,
			AllocationKey: allocationKey,
			ObjectKey:     objectKey,
		}); err != nil {
			return err
		}
	}
	return nil
}

func releaseAssetStorageAllocationKey(assetID int64) string {
	return fmt.Sprintf("release-asset:%d", assetID)
}

func workflowArtifactStorageAllocationKey(artifactID int64) string {
	return fmt.Sprintf("workflow-artifact:%d", artifactID)
}

func issueArtifactStorageAllocationKey(artifactID int64) string {
	return fmt.Sprintf("issue-artifact:%d", artifactID)
}

func workflowCacheStorageAllocationKey(repositoryID int64, objectKey string) string {
	return fmt.Sprintf("workflow-cache:%d:%s", repositoryID, objectKey)
}

func lfsStorageAllocationKey(repositoryID int64, oid string) string {
	return fmt.Sprintf("lfs:%d:%s", repositoryID, oid)
}
