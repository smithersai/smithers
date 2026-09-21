package services

import (
	"context"
	stdErrors "errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

const (
	defaultWorkflowArtifactContentType  = "application/octet-stream"
	defaultWorkflowArtifactPruneBatch   = 100
	defaultWorkflowArtifactRetention    = 90 * 24 * time.Hour
	workflowArtifactUploadGrace         = time.Minute
	workflowArtifactDeletionLease       = 5 * time.Minute
	workflowArtifactDeleteTimeout       = time.Minute
	workflowArtifactClaimReleaseTimeout = 5 * time.Second
	maxWorkflowArtifactNameLength       = 255
	// maxWorkflowArtifactsPerRun caps every live artifact reservation, including
	// pending and deleting rows. Upload URL creation is serialized by the
	// production owner-storage admission lock, so concurrent zero-byte uploads
	// cannot bypass this bound and amplify list/cleanup work without consuming
	// byte quota.
	maxWorkflowArtifactsPerRun = 100
	// DefaultWorkflowArtifactMaxUploadSizeBytes is the default maximum declared
	// size for a workflow artifact upload (10 GiB).
	DefaultWorkflowArtifactMaxUploadSizeBytes int64 = 10 * (1 << 30)
	// MaxWorkflowArtifactUploadSizeBytes is an alias kept for backwards
	// compatibility with callers that reference the old constant.
	MaxWorkflowArtifactUploadSizeBytes = DefaultWorkflowArtifactMaxUploadSizeBytes
)

type WorkflowArtifactUploadInput struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	ContentType string `json:"content_type,omitempty"`
}

type WorkflowArtifactUploadResult struct {
	Artifact      db.WorkflowArtifact `json:"artifact"`
	UploadURL     string              `json:"upload_url"`
	UploadHeaders map[string]string   `json:"upload_headers,omitempty"`
}

type WorkflowArtifactDownloadResult struct {
	Artifact    db.WorkflowArtifact `json:"artifact"`
	DownloadURL string              `json:"download_url"`
}

type WorkflowArtifactService interface {
	IssueUploadURL(ctx context.Context, run db.WorkflowRun, input WorkflowArtifactUploadInput) (WorkflowArtifactUploadResult, error)
	// ConfirmUpload marks a pending artifact as ready after verifying that the
	// blob exists in GCS, its size matches the declared value, and — when
	// declaredSHA256 is non-empty — its SHA-256 digest matches.
	ConfirmUpload(ctx context.Context, run db.WorkflowRun, name, declaredSHA256 string) (db.WorkflowArtifact, error)
	ListArtifacts(ctx context.Context, repositoryID, runID int64) ([]db.WorkflowArtifact, error)
	GetDownloadURL(ctx context.Context, repositoryID, runID int64, name string) (WorkflowArtifactDownloadResult, error)
	DeleteArtifact(ctx context.Context, repositoryID, runID int64, name string) error
	AttachToRelease(ctx context.Context, repositoryID, runID int64, name, releaseTag, releaseAssetName string) (db.WorkflowArtifact, error)
	PruneExpired(ctx context.Context, batchSize int32) (int, error)
}

type WorkflowArtifactQuerier interface {
	purgedStorageDeletionClearer

	GetWorkflowRun(ctx context.Context, arg db.GetWorkflowRunParams) (db.WorkflowRun, error)
	CreateWorkflowArtifact(ctx context.Context, arg db.CreateWorkflowArtifactParams) (db.WorkflowArtifact, error)
	ConfirmWorkflowArtifactUpload(ctx context.Context, arg db.ConfirmWorkflowArtifactUploadParams) (db.WorkflowArtifact, error)
	GetWorkflowDefinitionNameByRunID(ctx context.Context, workflowRunID int64) (string, error)
	ListWorkflowArtifactsByRun(ctx context.Context, workflowRunID int64) ([]db.WorkflowArtifact, error)
	GetWorkflowArtifactByName(ctx context.Context, arg db.GetWorkflowArtifactByNameParams) (db.WorkflowArtifact, error)
	ClaimWorkflowArtifactDeletion(ctx context.Context, arg db.ClaimWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error)
	RetryWorkflowArtifactDeletion(ctx context.Context, arg db.RetryWorkflowArtifactDeletionParams) (db.WorkflowArtifact, error)
	ReleaseWorkflowArtifactDeletionClaim(ctx context.Context, arg db.ReleaseWorkflowArtifactDeletionClaimParams) error
	DeleteClaimedWorkflowArtifact(ctx context.Context, arg db.DeleteClaimedWorkflowArtifactParams) (db.WorkflowArtifact, error)
	ListPrunableWorkflowArtifacts(ctx context.Context, arg db.ListPrunableWorkflowArtifactsParams) ([]db.WorkflowArtifact, error)
	AttachWorkflowArtifactToRelease(ctx context.Context, arg db.AttachWorkflowArtifactToReleaseParams) (db.WorkflowArtifact, error)
}

type workflowArtifactService struct {
	queries            WorkflowArtifactQuerier
	blobs              blob.Store
	signedURLExpiry    time.Duration
	maxUploadSizeBytes int64
	now                func() time.Time
	billing            BillingPolicy
	dispatcher         webhooks.Dispatcher
	workflowRuns       WorkflowRunService
}

type WorkflowArtifactServiceOption func(*workflowArtifactService)

func WithWorkflowArtifactBillingPolicy(policy BillingPolicy) WorkflowArtifactServiceOption {
	return func(s *workflowArtifactService) {
		s.billing = policy
	}
}

// WithWorkflowArtifactMaxUploadSize sets the maximum declared artifact size
// accepted by IssueUploadURL and verified by ConfirmUpload.
// Values ≤ 0 are ignored; the default (DefaultWorkflowArtifactMaxUploadSizeBytes) is used instead.
func WithWorkflowArtifactMaxUploadSize(maxBytes int64) WorkflowArtifactServiceOption {
	return func(s *workflowArtifactService) {
		if maxBytes > 0 {
			s.maxUploadSizeBytes = maxBytes
		}
	}
}

func WithWorkflowArtifactWebhookDispatcher(dispatcher webhooks.Dispatcher) WorkflowArtifactServiceOption {
	return func(s *workflowArtifactService) {
		s.dispatcher = dispatcher
	}
}

func WithWorkflowArtifactWorkflowRunService(workflowRuns WorkflowRunService) WorkflowArtifactServiceOption {
	return func(s *workflowArtifactService) {
		s.workflowRuns = workflowRuns
	}
}

func NewWorkflowArtifactService(q WorkflowArtifactQuerier, b blob.Store, expiry time.Duration, opts ...WorkflowArtifactServiceOption) WorkflowArtifactService {
	if expiry <= 0 {
		expiry = blob.DefaultSignedURLExpiry
	}
	svc := &workflowArtifactService{
		queries:            q,
		blobs:              b,
		signedURLExpiry:    expiry,
		maxUploadSizeBytes: DefaultWorkflowArtifactMaxUploadSizeBytes,
		now:                time.Now,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(svc)
		}
	}
	return svc
}

func (s *workflowArtifactService) IssueUploadURL(ctx context.Context, run db.WorkflowRun, input WorkflowArtifactUploadInput) (WorkflowArtifactUploadResult, error) {
	if s.queries == nil || s.blobs == nil {
		return WorkflowArtifactUploadResult{}, pkgerrors.Internal("workflow artifact service unavailable")
	}

	name, err := validateWorkflowArtifactName(input.Name)
	if err != nil {
		return WorkflowArtifactUploadResult{}, err
	}
	if input.Size < 0 {
		return WorkflowArtifactUploadResult{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WorkflowArtifact",
			Field:    "size",
			Code:     "invalid",
		})
	}
	if input.Size > s.maxUploadSizeBytes {
		return WorkflowArtifactUploadResult{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WorkflowArtifact",
			Field:    "size",
			Code:     "invalid",
		})
	}

	contentType := normalizeWorkflowArtifactContentType(input.ContentType)
	var artifact db.WorkflowArtifact
	reusePendingReservation := false
	uploadExpiry := s.signedURLExpiry
	resolveAdditionalBytes := func(lockCtx context.Context) (int64, error) {
		current, lookupErr := s.queries.GetWorkflowArtifactByName(lockCtx, db.GetWorkflowArtifactByNameParams{
			WorkflowRunID: run.ID,
			Name:          name,
		})
		if stdErrors.Is(lookupErr, pgx.ErrNoRows) {
			artifacts, listErr := s.queries.ListWorkflowArtifactsByRun(lockCtx, run.ID)
			if listErr != nil {
				return 0, pkgerrors.Internal("failed to count workflow artifacts")
			}
			if len(artifacts) >= maxWorkflowArtifactsPerRun {
				return 0, pkgerrors.ValidationFailed(pkgerrors.FieldError{
					Resource: "WorkflowArtifact",
					Field:    "name",
					Code:     "too_many",
				})
			}
			return input.Size, nil
		}
		if lookupErr != nil {
			return 0, pkgerrors.Internal("failed to load existing workflow artifact")
		}
		if current.RepositoryID != run.RepositoryID || current.WorkflowRunID != run.ID || current.Name != name {
			return 0, pkgerrors.Conflict("workflow artifact changed during upload reservation")
		}
		// A task can be requeued after reserving an immutable artifact but before
		// confirming it. Reissue the upload capability only for that exact
		// still-pending reservation; this is not replacement, consumes no new
		// quota, and retains the same create-only staging/final object keys.
		if current.Status == "pending" && !current.DeletionToken.Valid &&
			current.Size == input.Size && current.ContentType == contentType {
			// Reissuing a capability must not move its validity beyond the
			// reservation's fixed cleanup horizon. Cap retries to the original
			// provider maximum; the cleanup grace then remains a safety margin
			// for signing/clock skew rather than becoming renewable lifetime.
			if !current.CreatedAt.IsZero() {
				remaining := current.CreatedAt.UTC().Add(blob.MaxSignedURLExpiry).Sub(s.now().UTC())
				if remaining <= 0 {
					return 0, pkgerrors.Conflict("workflow artifact upload reservation expired")
				}
				if remaining < uploadExpiry {
					uploadExpiry = remaining
				}
			}
			artifact = current
			reusePendingReservation = true
			return 0, nil
		}
		// Artifact names are stable run outputs. Replacing the row before the new
		// upload is signed and confirmed would destroy a valid prior artifact if
		// the signer fails or the client abandons the new upload. A future
		// replacement feature needs a staged two-row atomic swap.
		return 0, pkgerrors.Conflict("workflow artifact already exists")
	}
	reserve := func(lockCtx context.Context) error {
		if reusePendingReservation {
			return nil
		}
		created, createErr := s.queries.CreateWorkflowArtifact(lockCtx, db.CreateWorkflowArtifactParams{
			RepositoryID:  run.RepositoryID,
			WorkflowRunID: run.ID,
			Name:          name,
			Size:          input.Size,
			ContentType:   contentType,
			ExpiresAt:     s.expiresAt(),
		})
		if createErr != nil {
			if isUniqueViolation(createErr) {
				return pkgerrors.Conflict("workflow artifact already exists")
			}
			return pkgerrors.Internal("failed to create workflow artifact")
		}
		artifact = created
		return nil
	}
	if err := authorizeStorageIncreaseThenCommitDynamic(ctx, s.billing, run.RepositoryID, resolveAdditionalBytes, reserve); err != nil {
		return WorkflowArtifactUploadResult{}, err
	}

	uploadKey, _ := workflowArtifactUploadKey(s.blobs, artifact.GcsKey)
	upload, err := blob.SignedCreateOnlyUpload(ctx, s.blobs, uploadKey, artifact.ContentType, artifact.Size, uploadExpiry)
	if err != nil {
		if reusePendingReservation {
			return WorkflowArtifactUploadResult{}, pkgerrors.Internal("failed to create workflow artifact upload url")
		}
		deleted, cleanupErr := s.deleteWorkflowArtifactWithOwnerLock(ctx, artifact, true)
		if cleanupErr != nil {
			slog.Warn("workflow artifact upload reservation cleanup failed", "artifact_id", artifact.ID, "repository_id", artifact.RepositoryID, "error", cleanupErr)
		} else if deleted {
			if clearErr := clearPurgedStorageDeletionKeys(
				ctx,
				s.queries,
				artifact.RepositoryID,
				workflowArtifactStorageAllocationKey(artifact.ID),
				artifact.GcsKey,
				blob.PendingUploadKey("workflow-artifacts", artifact.GcsKey),
			); clearErr != nil {
				slog.Warn("workflow artifact purged deletion fence cleanup failed", "artifact_id", artifact.ID, "repository_id", artifact.RepositoryID, "error", clearErr)
			}
		}
		return WorkflowArtifactUploadResult{}, pkgerrors.Internal("failed to create workflow artifact upload url")
	}

	return WorkflowArtifactUploadResult{
		Artifact:      artifact,
		UploadURL:     upload.URL,
		UploadHeaders: signedArtifactUploadHeaders(upload.Header, artifact.ContentType),
	}, nil
}

func (s *workflowArtifactService) ConfirmUpload(ctx context.Context, run db.WorkflowRun, name, declaredSHA256 string) (db.WorkflowArtifact, error) {
	if s.queries == nil || s.blobs == nil {
		return db.WorkflowArtifact{}, pkgerrors.Internal("workflow artifact service unavailable")
	}

	artifact, err := s.lookupArtifact(ctx, run.ID, name)
	if err != nil {
		return db.WorkflowArtifact{}, err
	}
	if artifact.Status == "ready" {
		return artifact, nil
	}
	if artifact.Status != "pending" {
		return db.WorkflowArtifact{}, pkgerrors.Conflict("workflow artifact is no longer pending")
	}

	validated, err := s.validateWorkflowArtifactUpload(ctx, artifact, declaredSHA256)
	if err != nil {
		return db.WorkflowArtifact{}, err
	}

	// Re-resolve the exact reservation after the owner lock is acquired. A
	// concurrent winner contributes these bytes to authoritative usage before a
	// loser wakes up, so the loser must resolve delta=0 instead of being denied
	// for adding the same bytes twice. A same-name replacement has a different
	// id/object key and must never inherit this blob validation.
	var confirmed db.WorkflowArtifact
	confirmedByThisCall := false
	resolveAdditionalBytes := func(ctx context.Context) (int64, error) {
		current, err := s.lookupArtifact(ctx, run.ID, artifact.Name)
		if err != nil {
			return 0, err
		}
		if !sameWorkflowArtifactReservation(current, artifact) {
			return 0, pkgerrors.Conflict("workflow artifact changed during upload confirmation")
		}
		switch current.Status {
		case "ready":
			confirmed = current
			return 0, nil
		case "pending":
			// The pending reservation's declared size is already part of the
			// owner's authoritative storage footprint.
			return 0, nil
		default:
			return 0, pkgerrors.Conflict("workflow artifact is no longer pending")
		}
	}
	confirm := func(ctx context.Context) error {
		if confirmed.Status == "ready" {
			return nil
		}
		if err := s.prepareWorkflowArtifactFinalBlob(ctx, artifact, validated); err != nil {
			return err
		}
		row, err := s.queries.ConfirmWorkflowArtifactUpload(ctx, db.ConfirmWorkflowArtifactUploadParams{
			ID:            artifact.ID,
			RepositoryID:  artifact.RepositoryID,
			WorkflowRunID: run.ID,
			Name:          artifact.Name,
			GcsKey:        artifact.GcsKey,
		})
		if err == nil {
			confirmed = row
			confirmedByThisCall = true
			return nil
		}
		if !stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Internal("failed to confirm workflow artifact upload")
		}

		// Transaction-less test policies can still race between resolve and CAS.
		// Accept only the same reservation already made ready; a replacement or
		// deletion is an honest conflict/not-found, never an idempotent success.
		current, lookupErr := s.queries.GetWorkflowArtifactByName(ctx, db.GetWorkflowArtifactByNameParams{
			WorkflowRunID: run.ID,
			Name:          artifact.Name,
		})
		if lookupErr == nil && sameWorkflowArtifactReservation(current, artifact) && current.Status == "ready" {
			confirmed = current
			return nil
		}
		// A transient reconciliation failure does not prove that the promoted
		// final object is orphaned. A concurrent confirmer may have won the CAS;
		// deleting here would destroy its immutable artifact.
		if lookupErr != nil && !stdErrors.Is(lookupErr, pgx.ErrNoRows) {
			return pkgerrors.Internal("failed to load workflow artifact after confirmation race")
		}
		if cleanupErr := s.deleteWorkflowArtifactBlobSet(ctx, artifact); cleanupErr != nil {
			return pkgerrors.Internal("failed to clean up unclaimed workflow artifact upload")
		}
		if stdErrors.Is(lookupErr, pgx.ErrNoRows) {
			return pkgerrors.NotFound("workflow artifact not found")
		}
		return pkgerrors.Conflict("workflow artifact changed during upload confirmation")
	}
	if err := authorizeStorageIncreaseThenCommitDynamic(ctx, s.billing, run.RepositoryID, resolveAdditionalBytes, confirm); err != nil {
		return db.WorkflowArtifact{}, err
	}

	if confirmedByThisCall {
		sourceWorkflow := s.resolveSourceWorkflowName(ctx, run.ID)
		s.dispatchConfirmedArtifactWebhook(ctx, run.RepositoryID, confirmed, sourceWorkflow)
		s.dispatchConfirmedArtifactRuns(ctx, run, confirmed, sourceWorkflow)
	}

	return confirmed, nil
}

type validatedWorkflowArtifactUpload struct {
	sourceKey string
	staged    bool
	sha256    string
}

func (s *workflowArtifactService) validateWorkflowArtifactUpload(ctx context.Context, artifact db.WorkflowArtifact, declaredSHA256 string) (validatedWorkflowArtifactUpload, error) {
	uploadKey, staged := workflowArtifactUploadKey(s.blobs, artifact.GcsKey)
	sourceKey := uploadKey
	attrs, err := s.blobs.Stat(ctx, sourceKey)
	if stdErrors.Is(err, blob.ErrObjectNotFound) && staged {
		// Promotion precedes the metadata CAS. A valid immutable final object
		// with no staging object is an interrupted confirmation that may be
		// adopted; it is never overwritten.
		sourceKey = artifact.GcsKey
		attrs, err = s.blobs.Stat(ctx, sourceKey)
	}
	if stdErrors.Is(err, blob.ErrObjectNotFound) {
		return validatedWorkflowArtifactUpload{}, pkgerrors.BadRequest("artifact blob does not exist")
	}
	if err != nil {
		return validatedWorkflowArtifactUpload{}, pkgerrors.Internal("failed to verify workflow artifact upload")
	}

	isMemoryStore := false
	actualSizeBytes := attrs.Size
	if actualSizeBytes == blob.UnknownObjectSize {
		if _, ok := s.blobs.(*blob.MemoryStore); !ok {
			return validatedWorkflowArtifactUpload{}, pkgerrors.Internal("artifact blob size could not be verified")
		}
		actualSizeBytes = artifact.Size
		isMemoryStore = true
	}
	if actualSizeBytes < 0 {
		return validatedWorkflowArtifactUpload{}, pkgerrors.Internal("artifact blob returned an invalid size")
	}
	if actualSizeBytes != artifact.Size {
		validationErr := pkgerrors.BadRequest("artifact blob size did not match declared size")
		return validatedWorkflowArtifactUpload{}, s.cleanupInvalidWorkflowArtifactObject(ctx, sourceKey, validationErr)
	}
	if actualSizeBytes > s.maxUploadSizeBytes {
		validationErr := pkgerrors.BadRequest("artifact blob exceeds configured size limit")
		return validatedWorkflowArtifactUpload{}, s.cleanupInvalidWorkflowArtifactObject(ctx, sourceKey, validationErr)
	}

	if declaredSHA256 != "" && !isMemoryStore {
		actualSHA256, digestErr := blob.ComputeSHA256(ctx, s.blobs, sourceKey)
		if stdErrors.Is(digestErr, blob.ErrObjectNotFound) {
			return validatedWorkflowArtifactUpload{}, pkgerrors.BadRequest("artifact blob does not exist")
		}
		if digestErr != nil {
			return validatedWorkflowArtifactUpload{}, pkgerrors.Internal("failed to compute workflow artifact digest")
		}
		if actualSHA256 != declaredSHA256 {
			validationErr := pkgerrors.BadRequest("artifact blob sha256 did not match declared hash")
			return validatedWorkflowArtifactUpload{}, s.cleanupInvalidWorkflowArtifactObject(ctx, sourceKey, validationErr)
		}
	}
	return validatedWorkflowArtifactUpload{sourceKey: sourceKey, staged: staged, sha256: declaredSHA256}, nil
}

func (s *workflowArtifactService) prepareWorkflowArtifactFinalBlob(ctx context.Context, artifact db.WorkflowArtifact, validated validatedWorkflowArtifactUpload) error {
	var promotionErr error
	createdDestination := false
	if validated.staged && validated.sourceKey != artifact.GcsKey {
		promoter, ok := s.blobs.(blob.CreateOnlyPromoter)
		if !ok {
			return pkgerrors.Internal("workflow artifact promotion is unavailable")
		}
		promotionErr = promoter.PromoteCreateOnly(ctx, validated.sourceKey, artifact.GcsKey)
		createdDestination = promotionErr == nil
	}

	attrs, err := s.blobs.Stat(ctx, artifact.GcsKey)
	if stdErrors.Is(err, blob.ErrObjectNotFound) {
		if promotionErr != nil && !stdErrors.Is(promotionErr, blob.ErrObjectNotFound) {
			return pkgerrors.Internal("failed to promote workflow artifact upload")
		}
		return pkgerrors.BadRequest("artifact blob does not exist")
	}
	if err != nil {
		return pkgerrors.Internal("failed to verify promoted workflow artifact")
	}
	if validationErr := s.validateWorkflowArtifactObject(artifact, attrs); validationErr != nil {
		if !createdDestination {
			return pkgerrors.Conflict("workflow artifact destination already exists with different content")
		}
		return s.cleanupInvalidWorkflowArtifactObject(ctx, artifact.GcsKey, validationErr)
	}
	if validated.sha256 != "" {
		if _, ok := s.blobs.(*blob.MemoryStore); !ok {
			actualSHA256, digestErr := blob.ComputeSHA256(ctx, s.blobs, artifact.GcsKey)
			if digestErr != nil {
				return pkgerrors.Internal("failed to compute promoted workflow artifact digest")
			}
			if actualSHA256 != validated.sha256 {
				if !createdDestination {
					return pkgerrors.Conflict("workflow artifact destination already exists with different content")
				}
				validationErr := pkgerrors.BadRequest("artifact blob sha256 did not match declared hash")
				return s.cleanupInvalidWorkflowArtifactObject(ctx, artifact.GcsKey, validationErr)
			}
		}
	}
	if err := s.purgePendingWorkflowArtifactUpload(ctx, artifact); err != nil {
		return pkgerrors.Internal("failed to clean up workflow artifact staging upload")
	}
	return nil
}

func (s *workflowArtifactService) validateWorkflowArtifactObject(artifact db.WorkflowArtifact, attrs blob.ObjectAttrs) error {
	actualSizeBytes := attrs.Size
	if actualSizeBytes == blob.UnknownObjectSize {
		if _, ok := s.blobs.(*blob.MemoryStore); !ok {
			return pkgerrors.Internal("artifact blob size could not be verified")
		}
		actualSizeBytes = artifact.Size
	}
	if actualSizeBytes < 0 {
		return pkgerrors.Internal("artifact blob returned an invalid size")
	}
	if actualSizeBytes != artifact.Size {
		return pkgerrors.BadRequest("artifact blob size did not match declared size")
	}
	if actualSizeBytes > s.maxUploadSizeBytes {
		return pkgerrors.BadRequest("artifact blob exceeds configured size limit")
	}
	return nil
}

// cleanupInvalidWorkflowArtifactObject removes a definitively invalid object
// while retaining the exact pending metadata reservation. Retaining the row
// keeps the still-live signed capability metered and lets the caller reuse that
// create-only URL after the bad generation has been hard-purged.
func (s *workflowArtifactService) cleanupInvalidWorkflowArtifactObject(ctx context.Context, key string, validationErr error) error {
	var apiErr *pkgerrors.APIError
	if !stdErrors.As(validationErr, &apiErr) || apiErr.Status != http.StatusBadRequest {
		return validationErr
	}
	if err := blob.PurgeAllGenerations(ctx, s.blobs, key); err != nil && !stdErrors.Is(err, blob.ErrObjectNotFound) {
		return pkgerrors.Internal("failed to clean up invalid workflow artifact upload")
	}
	return validationErr
}

func sameWorkflowArtifactReservation(current, captured db.WorkflowArtifact) bool {
	return current.ID == captured.ID &&
		current.RepositoryID == captured.RepositoryID &&
		current.WorkflowRunID == captured.WorkflowRunID &&
		current.Name == captured.Name &&
		current.GcsKey == captured.GcsKey &&
		current.Size == captured.Size
}

func (s *workflowArtifactService) ListArtifacts(ctx context.Context, repositoryID, runID int64) ([]db.WorkflowArtifact, error) {
	if s.queries == nil {
		return nil, pkgerrors.Internal("workflow artifact service unavailable")
	}
	if _, err := s.requireRun(ctx, repositoryID, runID); err != nil {
		return nil, err
	}

	rows, err := s.queries.ListWorkflowArtifactsByRun(ctx, runID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list workflow artifacts")
	}

	artifacts := make([]db.WorkflowArtifact, 0, len(rows))
	for _, artifact := range rows {
		if artifact.Status != "ready" {
			continue
		}
		artifacts = append(artifacts, artifact)
	}
	return artifacts, nil
}

func (s *workflowArtifactService) GetDownloadURL(ctx context.Context, repositoryID, runID int64, name string) (WorkflowArtifactDownloadResult, error) {
	if s.queries == nil || s.blobs == nil {
		return WorkflowArtifactDownloadResult{}, pkgerrors.Internal("workflow artifact service unavailable")
	}
	if _, err := s.requireRun(ctx, repositoryID, runID); err != nil {
		return WorkflowArtifactDownloadResult{}, err
	}

	artifact, err := s.lookupArtifact(ctx, runID, name)
	if err != nil {
		return WorkflowArtifactDownloadResult{}, err
	}
	if artifact.Status != "ready" {
		return WorkflowArtifactDownloadResult{}, pkgerrors.NotFound("workflow artifact not found")
	}

	exists, err := s.blobs.Exists(ctx, artifact.GcsKey)
	if err != nil {
		return WorkflowArtifactDownloadResult{}, pkgerrors.Internal("failed to verify workflow artifact blob")
	}
	if !exists {
		return WorkflowArtifactDownloadResult{}, pkgerrors.NotFound("workflow artifact blob not found")
	}

	downloadURL, err := s.blobs.SignedDownloadURL(ctx, artifact.GcsKey, s.signedURLExpiry)
	if err != nil {
		return WorkflowArtifactDownloadResult{}, pkgerrors.Internal("failed to create workflow artifact download url")
	}

	return WorkflowArtifactDownloadResult{
		Artifact:    artifact,
		DownloadURL: downloadURL,
	}, nil
}

func (s *workflowArtifactService) DeleteArtifact(ctx context.Context, repositoryID, runID int64, name string) error {
	if s.queries == nil || s.blobs == nil {
		return pkgerrors.Internal("workflow artifact service unavailable")
	}
	if _, err := s.requireRun(ctx, repositoryID, runID); err != nil {
		return err
	}

	artifact, err := s.lookupArtifact(ctx, runID, name)
	if err != nil {
		return err
	}
	if artifact.RepositoryID != repositoryID {
		return pkgerrors.NotFound("workflow artifact not found")
	}
	deleted, err := s.deleteWorkflowArtifactWithOwnerLock(ctx, artifact, false)
	if err != nil {
		return err
	}
	if !deleted {
		return pkgerrors.Conflict("workflow artifact deletion is already in progress")
	}
	return nil
}

func (s *workflowArtifactService) AttachToRelease(ctx context.Context, repositoryID, runID int64, name, releaseTag, releaseAssetName string) (db.WorkflowArtifact, error) {
	if s.queries == nil {
		return db.WorkflowArtifact{}, pkgerrors.Internal("workflow artifact service unavailable")
	}
	if _, err := s.requireRun(ctx, repositoryID, runID); err != nil {
		return db.WorkflowArtifact{}, err
	}

	artifact, err := s.lookupArtifact(ctx, runID, name)
	if err != nil {
		return db.WorkflowArtifact{}, err
	}
	if artifact.Status != "ready" {
		return db.WorkflowArtifact{}, pkgerrors.Conflict("workflow artifact is not ready")
	}

	tag := strings.TrimSpace(releaseTag)
	if tag == "" {
		return db.WorkflowArtifact{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WorkflowArtifact",
			Field:    "release_tag",
			Code:     "missing_field",
		})
	}

	assetName := strings.TrimSpace(releaseAssetName)
	if assetName == "" {
		assetName = artifact.Name
	}

	attached, err := s.queries.AttachWorkflowArtifactToRelease(ctx, db.AttachWorkflowArtifactToReleaseParams{
		ReleaseTag:       pgtype.Text{String: tag, Valid: true},
		ReleaseAssetName: pgtype.Text{String: assetName, Valid: true},
		WorkflowRunID:    runID,
		Name:             artifact.Name,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.WorkflowArtifact{}, pkgerrors.NotFound("workflow artifact not found")
		}
		return db.WorkflowArtifact{}, pkgerrors.Internal("failed to attach workflow artifact to release")
	}
	return attached, nil
}

func (s *workflowArtifactService) PruneExpired(ctx context.Context, batchSize int32) (int, error) {
	if s.queries == nil || s.blobs == nil {
		return 0, pkgerrors.Internal("workflow artifact service unavailable")
	}
	if batchSize <= 0 {
		batchSize = defaultWorkflowArtifactPruneBatch
	}

	now := s.now().UTC()
	deletedCount := 0
	var firstErr error
	seen := make(map[int64]struct{})
	for {
		rows, err := s.queries.ListPrunableWorkflowArtifacts(ctx, db.ListPrunableWorkflowArtifactsParams{
			// Rows do not persist the exact issued capability expiry. Fence against
			// the provider maximum so a restart with a lower configured expiry cannot
			// remove metadata while a URL minted by the old process remains usable.
			PendingCreatedBefore: now.Add(-(blob.MaxSignedURLExpiry + workflowArtifactUploadGrace)),
			ReadyExpiresBefore:   now,
			DeletionStaleBefore:  now.Add(-workflowArtifactDeletionLease),
			LimitRows:            batchSize,
		})
		if err != nil {
			if firstErr != nil {
				return deletedCount, firstErr
			}
			return deletedCount, pkgerrors.Internal("failed to list prunable workflow artifacts")
		}
		unseen := 0
		for _, artifact := range rows {
			if _, ok := seen[artifact.ID]; ok {
				continue
			}
			seen[artifact.ID] = struct{}{}
			unseen++
			deleted, deleteErr := s.deleteWorkflowArtifactWithOwnerLockIf(ctx, artifact, true, func(current db.WorkflowArtifact) bool {
				return workflowArtifactPrunableAt(current, now)
			})
			if deleteErr != nil {
				if firstErr == nil {
					firstErr = deleteErr
				}
				slog.Warn("workflow artifact cleanup failed", "artifact_id", artifact.ID, "repository_id", artifact.RepositoryID, "error", deleteErr)
				continue
			}
			if deleted {
				deletedCount++
			}
		}
		// A short page proves the current backlog is drained. A full page with
		// no unseen rows means failing/leased rows fill the query window; stop
		// instead of spinning forever on the same candidates.
		if len(rows) < int(batchSize) || unseen == 0 {
			break
		}
	}
	return deletedCount, firstErr
}

func (s *workflowArtifactService) deleteWorkflowArtifactWithOwnerLock(ctx context.Context, captured db.WorkflowArtifact, missingOK bool) (bool, error) {
	return s.deleteWorkflowArtifactWithOwnerLockIf(ctx, captured, missingOK, nil)
}

func (s *workflowArtifactService) deleteWorkflowArtifactWithOwnerLockIf(
	ctx context.Context,
	captured db.WorkflowArtifact,
	missingOK bool,
	eligible func(db.WorkflowArtifact) bool,
) (bool, error) {
	stillCurrent := false
	resolve := func(lockCtx context.Context) (int64, error) {
		current, err := s.queries.GetWorkflowArtifactByName(lockCtx, db.GetWorkflowArtifactByNameParams{
			WorkflowRunID: captured.WorkflowRunID,
			Name:          captured.Name,
		})
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		if err != nil {
			return 0, pkgerrors.Internal("failed to load workflow artifact for deletion")
		}
		stillCurrent = sameWorkflowArtifactReservation(current, captured) && (eligible == nil || eligible(current))
		if stillCurrent {
			captured = current
		}
		return 0, nil
	}
	deleted := false
	commit := func(lockCtx context.Context) error {
		if !stillCurrent {
			return nil
		}
		var err error
		deleted, err = s.deleteWorkflowArtifactReservation(lockCtx, captured)
		return err
	}
	if err := authorizeStorageIncreaseThenCommitDynamic(ctx, s.billing, captured.RepositoryID, resolve, commit); err != nil {
		return false, err
	}
	if !stillCurrent && !missingOK {
		return false, pkgerrors.Conflict("workflow artifact changed during deletion")
	}
	return deleted, nil
}

func workflowArtifactPrunableAt(artifact db.WorkflowArtifact, now time.Time) bool {
	now = now.UTC()
	switch artifact.Status {
	case "pending":
		return !artifact.CreatedAt.After(now.Add(-(blob.MaxSignedURLExpiry + workflowArtifactUploadGrace)))
	case "ready":
		return !artifact.ExpiresAt.After(now)
	case "deleting":
		return !artifact.UpdatedAt.After(now.Add(-workflowArtifactDeletionLease))
	default:
		return false
	}
}

func (s *workflowArtifactService) deleteWorkflowArtifactReservation(ctx context.Context, artifact db.WorkflowArtifact) (bool, error) {
	token := uuid.NewString()
	tokenValue := pgtype.Text{String: token, Valid: true}
	var claimed db.WorkflowArtifact
	var err error
	switch artifact.Status {
	case "pending", "ready":
		claimed, err = s.queries.ClaimWorkflowArtifactDeletion(ctx, db.ClaimWorkflowArtifactDeletionParams{
			ID:             artifact.ID,
			RepositoryID:   artifact.RepositoryID,
			WorkflowRunID:  artifact.WorkflowRunID,
			Name:           artifact.Name,
			GcsKey:         artifact.GcsKey,
			ExpectedStatus: artifact.Status,
			DeletionToken:  tokenValue,
		})
	case "deleting":
		claimed, err = s.queries.RetryWorkflowArtifactDeletion(ctx, db.RetryWorkflowArtifactDeletionParams{
			ID:            artifact.ID,
			RepositoryID:  artifact.RepositoryID,
			WorkflowRunID: artifact.WorkflowRunID,
			Name:          artifact.Name,
			GcsKey:        artifact.GcsKey,
			DeletionToken: tokenValue,
			StaleBefore:   s.now().UTC().Add(-workflowArtifactDeletionLease),
		})
	default:
		return false, nil
	}
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, pkgerrors.Internal("failed to claim workflow artifact deletion")
	}

	deleteCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), workflowArtifactDeleteTimeout)
	deleteErr := s.deleteWorkflowArtifactBlobSet(deleteCtx, claimed)
	cancel()
	if deleteErr != nil {
		s.releaseWorkflowArtifactDeletionClaim(ctx, claimed, tokenValue)
		return false, pkgerrors.Internal("failed to delete workflow artifact blob")
	}

	_, err = s.queries.DeleteClaimedWorkflowArtifact(ctx, db.DeleteClaimedWorkflowArtifactParams{
		ID:            claimed.ID,
		RepositoryID:  claimed.RepositoryID,
		WorkflowRunID: claimed.WorkflowRunID,
		Name:          claimed.Name,
		GcsKey:        claimed.GcsKey,
		DeletionToken: tokenValue,
	})
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		s.releaseWorkflowArtifactDeletionClaim(ctx, claimed, tokenValue)
		return false, pkgerrors.Internal("failed to delete workflow artifact metadata")
	}
	return true, nil
}

func (s *workflowArtifactService) releaseWorkflowArtifactDeletionClaim(ctx context.Context, artifact db.WorkflowArtifact, token pgtype.Text) {
	releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), workflowArtifactClaimReleaseTimeout)
	defer cancel()
	if err := s.queries.ReleaseWorkflowArtifactDeletionClaim(releaseCtx, db.ReleaseWorkflowArtifactDeletionClaimParams{
		ID:            artifact.ID,
		RepositoryID:  artifact.RepositoryID,
		WorkflowRunID: artifact.WorkflowRunID,
		Name:          artifact.Name,
		GcsKey:        artifact.GcsKey,
		DeletionToken: token,
	}); err != nil {
		slog.Warn("workflow artifact deletion claim release failed", "artifact_id", artifact.ID, "repository_id", artifact.RepositoryID, "error", err)
	}
}

func workflowArtifactUploadKey(store blob.Store, finalKey string) (string, bool) {
	if _, ok := store.(blob.CreateOnlyPromoter); ok {
		return blob.PendingUploadKey("workflow-artifacts", finalKey), true
	}
	return finalKey, false
}

func (s *workflowArtifactService) purgePendingWorkflowArtifactUpload(ctx context.Context, artifact db.WorkflowArtifact) error {
	err := blob.PurgeAllGenerations(ctx, s.blobs, blob.PendingUploadKey("workflow-artifacts", artifact.GcsKey))
	if stdErrors.Is(err, blob.ErrObjectNotFound) {
		return nil
	}
	return err
}

func (s *workflowArtifactService) deleteWorkflowArtifactBlobSet(ctx context.Context, artifact db.WorkflowArtifact) error {
	var firstErr error
	if err := s.purgePendingWorkflowArtifactUpload(ctx, artifact); err != nil {
		firstErr = err
	}
	if err := blob.PurgeAllGenerations(ctx, s.blobs, artifact.GcsKey); err != nil && !stdErrors.Is(err, blob.ErrObjectNotFound) && firstErr == nil {
		firstErr = err
	}
	return firstErr
}

func (s *workflowArtifactService) requireRun(ctx context.Context, repositoryID, runID int64) (db.WorkflowRun, error) {
	run, err := s.queries.GetWorkflowRun(ctx, db.GetWorkflowRunParams{
		ID:           runID,
		RepositoryID: repositoryID,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.WorkflowRun{}, pkgerrors.NotFound("workflow run not found")
		}
		return db.WorkflowRun{}, pkgerrors.Internal("failed to load workflow run")
	}
	return run, nil
}

func (s *workflowArtifactService) lookupArtifact(ctx context.Context, runID int64, name string) (db.WorkflowArtifact, error) {
	normalized, err := validateWorkflowArtifactName(name)
	if err != nil {
		return db.WorkflowArtifact{}, err
	}

	artifact, err := s.queries.GetWorkflowArtifactByName(ctx, db.GetWorkflowArtifactByNameParams{
		WorkflowRunID: runID,
		Name:          normalized,
	})
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.WorkflowArtifact{}, pkgerrors.NotFound("workflow artifact not found")
		}
		return db.WorkflowArtifact{}, pkgerrors.Internal("failed to load workflow artifact")
	}
	return artifact, nil
}

func (s *workflowArtifactService) resolveSourceWorkflowName(ctx context.Context, workflowRunID int64) string {
	if s.queries == nil {
		return ""
	}

	name, err := s.queries.GetWorkflowDefinitionNameByRunID(ctx, workflowRunID)
	if err == nil {
		return strings.TrimSpace(name)
	}
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return ""
	}

	slog.Error("failed to resolve workflow artifact source workflow",
		"workflow_run_id", workflowRunID,
		"error", err,
	)
	return ""
}

func (s *workflowArtifactService) dispatchConfirmedArtifactWebhook(
	ctx context.Context,
	repositoryID int64,
	artifact db.WorkflowArtifact,
	sourceWorkflow string,
) {
	if s.dispatcher == nil {
		return
	}

	var confirmedAt *time.Time
	if artifact.ConfirmedAt.Valid {
		t := artifact.ConfirmedAt.Time
		confirmedAt = &t
	}

	payload := webhooks.WorkflowArtifactEventPayload{
		Action: "ready",
		Artifact: webhooks.WorkflowArtifactPayload{
			ID:             artifact.ID,
			WorkflowRunID:  artifact.WorkflowRunID,
			Name:           artifact.Name,
			Size:           artifact.Size,
			ContentType:    artifact.ContentType,
			Status:         artifact.Status,
			SourceWorkflow: sourceWorkflow,
			CreatedAt:      artifact.CreatedAt,
			UpdatedAt:      artifact.UpdatedAt,
			ConfirmedAt:    confirmedAt,
		},
		Repository: webhooks.RepositoryPayload{ID: repositoryID},
	}

	if err := s.dispatcher.DispatchEvent(ctx, repositoryID, webhooks.EventTypeWorkflowArtifact, payload); err != nil {
		slog.Error("failed to dispatch workflow artifact webhook event",
			"repository_id", repositoryID,
			"workflow_run_id", artifact.WorkflowRunID,
			"artifact_name", artifact.Name,
			"error", err,
		)
	}
}

func (s *workflowArtifactService) dispatchConfirmedArtifactRuns(
	ctx context.Context,
	run db.WorkflowRun,
	artifact db.WorkflowArtifact,
	sourceWorkflow string,
) {
	if s.workflowRuns == nil {
		return
	}

	_, err := s.workflowRuns.DispatchForEvent(ctx, DispatchForEventInput{
		RepositoryID: run.RepositoryID,
		Event: TriggerEvent{
			Type:           "workflow_artifact",
			Ref:            run.TriggerRef,
			CommitSHA:      run.TriggerCommitSha,
			Action:         "ready",
			ArtifactName:   artifact.Name,
			SourceWorkflow: sourceWorkflow,
		},
	})
	if err != nil {
		slog.Error("failed to dispatch workflow artifact trigger",
			"repository_id", run.RepositoryID,
			"workflow_run_id", run.ID,
			"artifact_name", artifact.Name,
			"source_workflow", sourceWorkflow,
			"error", err,
		)
	}
}

func (s *workflowArtifactService) expiresAt() time.Time {
	return s.now().UTC().Add(defaultWorkflowArtifactRetention)
}

// signedArtifactUploadHeaders returns an isolated copy of every header the
// signer covered. Legacy/test stores use the plain signer fallback, which does
// not return its signed Content-Type, so preserve that required header too.
func signedArtifactUploadHeaders(signed map[string]string, contentType string) map[string]string {
	headers := make(map[string]string, len(signed)+1)
	for name, value := range signed {
		headers[name] = value
	}
	if _, ok := headers["Content-Type"]; !ok && strings.TrimSpace(contentType) != "" {
		headers["Content-Type"] = contentType
	}
	return headers
}

func normalizeWorkflowArtifactContentType(raw string) string {
	contentType := strings.TrimSpace(raw)
	if contentType == "" {
		return defaultWorkflowArtifactContentType
	}
	return contentType
}

func validateWorkflowArtifactName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WorkflowArtifact",
			Field:    "name",
			Code:     "missing_field",
		})
	}
	if len(name) > maxWorkflowArtifactNameLength {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WorkflowArtifact",
			Field:    "name",
			Code:     "too_long",
		})
	}
	if name == "." || name == ".." {
		return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
			Resource: "WorkflowArtifact",
			Field:    "name",
			Code:     "invalid",
		})
	}
	for _, r := range name {
		if r == '/' || r == '\\' || unicode.IsControl(r) {
			return "", pkgerrors.ValidationFailed(pkgerrors.FieldError{
				Resource: "WorkflowArtifact",
				Field:    "name",
				Code:     "invalid",
			})
		}
	}
	return name, nil
}
