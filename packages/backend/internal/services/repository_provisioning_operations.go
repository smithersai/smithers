package services

import (
	"context"
	stdErrors "errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const (
	repositoryProvisionInit   = "init"
	repositoryProvisionFork   = "fork"
	repositoryProvisionImport = "import"

	repositoryProvisionGrace      = repoHostMutationConsistencyTimeout + 5*time.Minute
	repositoryProvisionClaimLease = 15 * time.Minute
	repositoryProvisionInterval   = time.Minute
	repositoryProvisionBatchSize  = int32(1)
)

var (
	ErrRepositoryProvisionConflict   = stdErrors.New("repository provisioning namespace is occupied")
	ErrRepositoryProvisionMismatch   = stdErrors.New("repository provisioning retry does not match reserved operation")
	ErrRepositoryProvisionMissing    = stdErrors.New("repository provisioning operation is missing")
	ErrRepositoryProvisionInProgress = stdErrors.New("repository provisioning operation is already being processed")
)

func newRepositoryProvisionClaimToken() string {
	return strings.ReplaceAll(uuid.NewString(), "-", "") + strings.Repeat("0", 32)
}

type repoHostProvisioningClient interface {
	PrepareStagedInit(context.Context, string, string, string, string, bool) (repohost.StagedProvision, error)
	PrepareStagedFork(context.Context, string, string, string, string, string) (repohost.StagedProvision, error)
	ExecuteStagedProvision(context.Context, repohost.StagedProvision) error
	PublishStagedProvision(context.Context, repohost.StagedProvision) error
	FinalizeStagedProvision(context.Context, repohost.StagedProvision) error
	AbortStagedProvision(context.Context, repohost.StagedProvision) error
}

type RepositoryProvisioningOperation struct {
	RepositoryID       int64
	OperationType      string
	Token              string
	ActorID            int64
	StorageSetID       string
	OwnerName          string
	UserID             pgtype.Int8
	OrgID              pgtype.Int8
	Name               string
	LowerName          string
	Description        string
	IsPublic           bool
	DefaultBookmark    string
	AutoInit           bool
	IsFork             bool
	ForkID             pgtype.Int8
	SourceRepositoryID pgtype.Int8
	SourceOwner        pgtype.Text
	SourceRepo         pgtype.Text
	SourceStorageSetID pgtype.Text
	PublishReady       bool
	ClaimToken         pgtype.Text
	ClaimedAt          pgtype.Timestamptz
	Attempts           int32
	LastError          pgtype.Text
	CreatedAt          time.Time
	UpdatedAt          time.Time
	// ImportJob* is a transient coordinator binding, persisted on import_jobs
	// rather than duplicated in the provisioning operation.
	ImportJobID         string
	ImportJobClaimToken string
}

// repositoryProvisioningOperation is the canonical operation value used by both
// product import reservations and an injected deployment journal.
type repositoryProvisioningOperation = RepositoryProvisioningOperation

// RepositoryProvisioningStore supplies durable placement-journal operations.
// Implementations retain their own transaction through publication or abort.
type RepositoryProvisioningStore interface {
	githubImportProvisioningStore
	FindExact(context.Context, RepositoryProvisioningOperation) (RepositoryProvisioningOperation, bool, error)
	ClaimReady(context.Context, string) ([]RepositoryProvisioningOperation, error)
}

func (operation repositoryProvisioningOperation) staged() repohost.StagedProvision {
	return repohost.StagedProvision{
		StorageSetID: operation.StorageSetID,
		Token:        operation.Token, OperationType: operation.repoHostOperationType(),
		Owner: operation.OwnerName, Repo: operation.Name,
		DefaultBookmark: operation.DefaultBookmark, AutoInit: operation.AutoInit,
		SrcOwner: operation.SourceOwner.String, SrcRepo: operation.SourceRepo.String,
	}
}

func (operation repositoryProvisioningOperation) repoHostOperationType() string {
	switch operation.OperationType {
	case repositoryProvisionFork, repositoryProvisionImport:
		return operation.OperationType
	default:
		return repositoryProvisionInit
	}
}

func newInitProvisioningOperation(
	actorID int64,
	userID, orgID pgtype.Int8,
	owner string,
	params repositoryProvisionParams,
	staged repohost.StagedProvision,
	operationType string,
) repositoryProvisioningOperation {
	return repositoryProvisioningOperation{
		OperationType: operationType, Token: staged.Token, ActorID: actorID, StorageSetID: staged.StorageSetID,
		OwnerName: owner, UserID: userID, OrgID: orgID,
		Name: params.Name, LowerName: params.LowerName, Description: params.Description,
		IsPublic: params.IsPublic, DefaultBookmark: params.DefaultBookmark, AutoInit: params.AutoInit,
	}
}

func newForkProvisioningOperation(
	actor *db.User,
	owner string,
	params repositoryProvisionParams,
	source db.Repository,
	sourceOwner string,
	staged repohost.StagedProvision,
) repositoryProvisioningOperation {
	return repositoryProvisioningOperation{
		OperationType: repositoryProvisionFork, Token: staged.Token, ActorID: actor.ID, StorageSetID: staged.StorageSetID,
		OwnerName: owner, UserID: pgtype.Int8{Int64: actor.ID, Valid: true},
		Name: params.Name, LowerName: params.LowerName, Description: params.Description,
		IsPublic: params.IsPublic, DefaultBookmark: params.DefaultBookmark,
		IsFork: true, ForkID: pgtype.Int8{Int64: source.ID, Valid: true},
		SourceRepositoryID: pgtype.Int8{Int64: source.ID, Valid: true},
		SourceOwner:        pgtype.Text{String: sourceOwner, Valid: true},
		SourceRepo:         pgtype.Text{String: source.Name, Valid: true},
		SourceStorageSetID: pgtype.Text{String: staged.StorageSetID, Valid: true},
	}
}

type repositoryProvisionParams struct {
	Name            string
	LowerName       string
	Description     string
	IsPublic        bool
	DefaultBookmark string
	AutoInit        bool
}

func lockRepositoryProvisionNamespace(ctx context.Context, tx pgx.Tx, operation repositoryProvisioningOperation) error {
	ownerType := BillingOwnerTypeUser
	ownerID := operation.UserID.Int64
	if operation.OrgID.Valid {
		ownerType = BillingOwnerTypeOrg
		ownerID = operation.OrgID.Int64
	}
	key := fmt.Sprintf("repository-provision:%s:%d:%s", ownerType, ownerID, operation.LowerName)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key); err != nil {
		return fmt.Errorf("lock repository provision namespace: %w", err)
	}
	return nil
}

func verifyProvisionOwners(ctx context.Context, tx pgx.Tx, operation repositoryProvisioningOperation) error {
	canonical, err := repositoryOwnerNameInTx(ctx, tx, operation.UserID, operation.OrgID)
	if resultErr := classifyRepositoryProvisionIdentity(err, canonical == operation.OwnerName); resultErr != nil {
		return resultErr
	}
	if operation.OperationType != repositoryProvisionFork {
		return nil
	}
	source, err := loadRepositoryStorageIdentity(ctx, tx, operation.SourceRepositoryID.Int64)
	sourceMatches := repositoryMatchesStorageIdentity(source, source.UserID, source.OrgID, operation.SourceRepo.String) &&
		operation.SourceStorageSetID.Valid
	if resultErr := classifyRepositoryProvisionIdentity(err, sourceMatches); resultErr != nil {
		return resultErr
	}
	sourceOwner, err := repositoryOwnerNameInTx(ctx, tx, source.UserID, source.OrgID)
	if resultErr := classifyRepositoryProvisionIdentity(err, sourceOwner == operation.SourceOwner.String); resultErr != nil {
		return resultErr
	}
	return nil
}

// classifyRepositoryProvisionIdentity distinguishes a stale/missing durable
// identity from an inability to read it. Callers may safely map the former to
// a namespace conflict, while database/transport failures must remain
// retryable internal errors instead of masquerading as a mismatch.
func classifyRepositoryProvisionIdentity(err error, matches bool) error {
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return errRepositoryProvisionMismatch
		}
		return err
	}
	if !matches {
		return errRepositoryProvisionMismatch
	}
	return nil
}

func sameRepositoryProvision(a, b repositoryProvisioningOperation) bool {
	return a.OperationType == b.OperationType &&
		a.ActorID == b.ActorID && a.StorageSetID == b.StorageSetID && a.OwnerName == b.OwnerName &&
		a.UserID == b.UserID && a.OrgID == b.OrgID && a.Name == b.Name &&
		a.LowerName == b.LowerName && a.Description == b.Description &&
		a.IsPublic == b.IsPublic && a.DefaultBookmark == b.DefaultBookmark &&
		a.AutoInit == b.AutoInit && a.IsFork == b.IsFork && a.ForkID == b.ForkID &&
		a.SourceRepositoryID == b.SourceRepositoryID && a.SourceOwner == b.SourceOwner &&
		a.SourceRepo == b.SourceRepo && a.SourceStorageSetID == b.SourceStorageSetID
}

func repositoryMatchesProvision(repository db.Repository, operation repositoryProvisioningOperation) bool {
	return repository.ID == operation.RepositoryID && repository.UserID == operation.UserID &&
		repository.OrgID == operation.OrgID && repository.Name == operation.Name &&
		repository.LowerName == operation.LowerName && repository.Description == operation.Description &&
		repository.IsPublic == operation.IsPublic &&
		repository.DefaultBookmark == operation.DefaultBookmark && repository.IsFork == operation.IsFork &&
		repository.ForkID == operation.ForkID
}

// RepositoryProvisioningReconciler resumes only publish-ready operations.
// Import preparations remain invisible until their durable import job marks
// the staged mirror ready; they are never auto-published as empty repositories.
type RepositoryProvisioningReconciler struct {
	store    RepositoryProvisioningStore
	repoHost repoHostProvisioningClient
}

func NewRepositoryProvisioningReconciler(store RepositoryProvisioningStore, repoHost repoHostProvisioningClient) *RepositoryProvisioningReconciler {
	if store == nil || repoHost == nil {
		return nil
	}
	return &RepositoryProvisioningReconciler{store: store, repoHost: repoHost}
}

func (r *RepositoryProvisioningReconciler) Start(ctx context.Context) {
	if r == nil {
		return
	}
	ticker := time.NewTicker(repositoryProvisionInterval)
	defer ticker.Stop()
	for {
		if err := r.reconcile(ctx); err != nil && !stdErrors.Is(err, context.Canceled) {
			slog.Error("repository provisioning reconciliation failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *RepositoryProvisioningReconciler) reconcile(ctx context.Context) error {
	claimToken := newRepositoryProvisionClaimToken()
	operations, err := r.store.ClaimReady(ctx, claimToken)
	if err != nil {
		return err
	}
	for _, operation := range operations {
		processCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), repoHostMutationConsistencyTimeout)
		processErr := r.finish(processCtx, operation, claimToken)
		cancel()
		if processErr != nil {
			r.store.ReleaseClaim(context.WithoutCancel(ctx), operation, claimToken, processErr)
			slog.Error("repository provisioning operation remains retryable",
				"repo_id", operation.RepositoryID, "operation", operation.OperationType, "error", processErr)
		}
	}
	return nil
}

func (r *RepositoryProvisioningReconciler) finish(
	ctx context.Context,
	operation repositoryProvisioningOperation,
	claimToken string,
) error {
	staged := operation.staged()
	if _, published, err := r.store.GetPublished(ctx, operation); err != nil {
		return err
	} else if published {
		if err := r.store.RenewClaim(ctx, operation.RepositoryID, operation.Token, claimToken); err != nil {
			return err
		}
		if err := r.repoHost.FinalizeStagedProvision(ctx, staged); err != nil {
			return fmt.Errorf("finalize published repository provision: %w", err)
		}
		if err := r.store.RenewClaim(ctx, operation.RepositoryID, operation.Token, claimToken); err != nil {
			return err
		}
		if err := r.store.Complete(ctx, operation.RepositoryID, operation.Token, claimToken); err != nil &&
			!stdErrors.Is(err, errRepositoryProvisionMissing) {
			return err
		}
		return nil
	}
	if err := r.repoHost.ExecuteStagedProvision(ctx, staged); err != nil {
		if isDefinitiveProvisionConflict(err) {
			if abortErr := r.store.Abort(ctx, operation, claimToken, func(abortCtx context.Context) error {
				return r.repoHost.AbortStagedProvision(abortCtx, staged)
			}); abortErr != nil && !stdErrors.Is(abortErr, errRepositoryProvisionMissing) {
				return fmt.Errorf("abort occupied repository provision: %w", abortErr)
			}
			return nil
		}
		return fmt.Errorf("resume staged repository provision: %w", err)
	}
	if err := r.store.RenewClaim(ctx, operation.RepositoryID, operation.Token, claimToken); err != nil {
		return err
	}
	if err := r.repoHost.PublishStagedProvision(ctx, staged); err != nil {
		if isDefinitiveProvisionConflict(err) {
			if abortErr := r.store.Abort(ctx, operation, claimToken, func(abortCtx context.Context) error {
				return r.repoHost.AbortStagedProvision(abortCtx, staged)
			}); abortErr != nil && !stdErrors.Is(abortErr, errRepositoryProvisionMissing) {
				return fmt.Errorf("abort occupied repository provision: %w", abortErr)
			}
			return nil
		}
		return fmt.Errorf("publish staged repository provision: %w", err)
	}
	if err := r.store.RenewClaim(ctx, operation.RepositoryID, operation.Token, claimToken); err != nil {
		return err
	}
	if !operation.PublishReady {
		if err := r.store.MarkPublishReady(ctx, operation.RepositoryID, operation.Token, claimToken); err != nil {
			return err
		}
		operation.PublishReady = true
	}
	if _, err := r.store.Publish(ctx, operation, claimToken); err != nil {
		return err
	}
	if err := r.store.RenewClaim(ctx, operation.RepositoryID, operation.Token, claimToken); err != nil {
		return err
	}
	if err := r.repoHost.FinalizeStagedProvision(ctx, staged); err != nil {
		return fmt.Errorf("finalize staged repository provision: %w", err)
	}
	if err := r.store.RenewClaim(ctx, operation.RepositoryID, operation.Token, claimToken); err != nil {
		return err
	}
	if err := r.store.Complete(ctx, operation.RepositoryID, operation.Token, claimToken); err != nil && !stdErrors.Is(err, errRepositoryProvisionMissing) {
		return err
	}
	return nil
}

var errRepositoryProvisionConflict = ErrRepositoryProvisionConflict

var errRepositoryProvisionMismatch = ErrRepositoryProvisionMismatch

var errRepositoryProvisionMissing = ErrRepositoryProvisionMissing

var errRepositoryProvisionInProgress = ErrRepositoryProvisionInProgress

func SameRepositoryProvision(a, b RepositoryProvisioningOperation) bool {
	return sameRepositoryProvision(a, b)
}
func RepositoryMatchesProvision(r db.Repository, op RepositoryProvisioningOperation) bool {
	return repositoryMatchesProvision(r, op)
}
