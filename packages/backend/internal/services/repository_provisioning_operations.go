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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

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
	errRepositoryProvisionConflict   = stdErrors.New("repository provisioning namespace is occupied")
	errRepositoryProvisionMismatch   = stdErrors.New("repository provisioning retry does not match reserved operation")
	errRepositoryProvisionMissing    = stdErrors.New("repository provisioning operation is missing")
	errRepositoryProvisionInProgress = stdErrors.New("repository provisioning operation is already being processed")
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

type repositoryProvisioningOperation struct {
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

type postgresRepositoryProvisioningStore struct {
	pool *pgxpool.Pool
}

func newPostgresRepositoryProvisioningStore(pool *pgxpool.Pool) *postgresRepositoryProvisioningStore {
	return &postgresRepositoryProvisioningStore{pool: pool}
}

// Reserve creates the invisible durable identity before repo-host sees the
// token. An exact retry adopts only this operation's reserved ID; owner/name
// alone is never enough.
func (s *postgresRepositoryProvisioningStore) Reserve(
	ctx context.Context,
	wanted repositoryProvisioningOperation,
) (_ repositoryProvisioningOperation, retErr error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return repositoryProvisioningOperation{}, fmt.Errorf("begin repository provision reservation: %w", err)
	}
	defer func() {
		rollbackErr := tx.Rollback(context.Background())
		if rollbackErr != nil && !stdErrors.Is(rollbackErr, pgx.ErrTxClosed) && retErr == nil {
			retErr = fmt.Errorf("rollback repository provision reservation: %w", rollbackErr)
		}
	}()
	if err := verifyProvisionOwners(ctx, tx, wanted); err != nil {
		return repositoryProvisioningOperation{}, err
	}
	if err := lockRepositoryProvisionNamespace(ctx, tx, wanted); err != nil {
		return repositoryProvisioningOperation{}, err
	}

	existing, err := loadProvisionByOwnerName(ctx, tx, wanted)
	if err == nil {
		if !sameRepositoryProvision(existing, wanted) {
			return repositoryProvisioningOperation{}, errRepositoryProvisionMismatch
		}
		if err := bindImportJobReservation(ctx, tx, existing, wanted); err != nil {
			return repositoryProvisioningOperation{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return repositoryProvisioningOperation{}, fmt.Errorf("commit adopted repository provision: %w", err)
		}
		return existing, nil
	}
	if !stdErrors.Is(err, pgx.ErrNoRows) {
		return repositoryProvisioningOperation{}, fmt.Errorf("load repository provision reservation: %w", err)
	}

	var occupied bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM repositories
			WHERE lower_name = $1
			  AND (($2::bigint IS NOT NULL AND user_id = $2)
			       OR ($3::bigint IS NOT NULL AND org_id = $3))
		)
	`, wanted.LowerName, nullableInt8(wanted.UserID), nullableInt8(wanted.OrgID)).Scan(&occupied); err != nil {
		return repositoryProvisioningOperation{}, fmt.Errorf("inspect repository provision namespace: %w", err)
	}
	if occupied {
		return repositoryProvisioningOperation{}, errRepositoryProvisionConflict
	}

	if err := tx.QueryRow(ctx,
		`SELECT nextval(pg_get_serial_sequence('repositories', 'id'))`).Scan(&wanted.RepositoryID); err != nil {
		return repositoryProvisioningOperation{}, fmt.Errorf("reserve repository id: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO repository_provisioning_operations (
			repository_id, operation_type, token, actor_id, storage_set_id,
			owner_name, user_id, org_id, name, lower_name, description,
			is_public, default_bookmark, auto_init, is_fork, fork_id,
			source_repository_id, source_owner, source_repo, source_storage_set_id
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
			$11, $12, $13, $14, $15, $16, $17, $18, $19, $20
		)
	`, wanted.RepositoryID, wanted.OperationType, wanted.Token, wanted.ActorID, wanted.StorageSetID,
		wanted.OwnerName, nullableInt8(wanted.UserID), nullableInt8(wanted.OrgID),
		wanted.Name, wanted.LowerName, wanted.Description, wanted.IsPublic,
		wanted.DefaultBookmark, wanted.AutoInit, wanted.IsFork, nullableInt8(wanted.ForkID),
		nullableInt8(wanted.SourceRepositoryID), nullableText(wanted.SourceOwner),
		nullableText(wanted.SourceRepo), nullableText(wanted.SourceStorageSetID))
	if err != nil {
		var pgErr *pgconn.PgError
		if stdErrors.As(err, &pgErr) && pgErr.Code == "23505" {
			return repositoryProvisioningOperation{}, errRepositoryProvisionConflict
		}
		return repositoryProvisioningOperation{}, fmt.Errorf("insert repository provision reservation: %w", err)
	}
	if err := bindImportJobReservation(ctx, tx, wanted, wanted); err != nil {
		return repositoryProvisioningOperation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		// The commit result can be lost. Re-read only by the unguessable token
		// and require the exact operation before reporting success.
		recovered, recoverErr := s.GetByToken(context.WithoutCancel(ctx), wanted.Token)
		if recoverErr == nil && sameRepositoryProvision(recovered, wanted) {
			return recovered, nil
		}
		return repositoryProvisioningOperation{}, fmt.Errorf("commit repository provision reservation: %w", err)
	}
	return wanted, nil
}

func (s *postgresRepositoryProvisioningStore) FindExact(
	ctx context.Context,
	wanted repositoryProvisioningOperation,
) (repositoryProvisioningOperation, bool, error) {
	operation, err := scanRepositoryProvision(s.pool.QueryRow(ctx, repositoryProvisionSelect+`
		WHERE lower_name = $1
		  AND (($2::bigint IS NOT NULL AND user_id = $2)
		       OR ($3::bigint IS NOT NULL AND org_id = $3))
	`, wanted.LowerName, nullableInt8(wanted.UserID), nullableInt8(wanted.OrgID)))
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return repositoryProvisioningOperation{}, false, nil
	}
	if err != nil {
		return repositoryProvisioningOperation{}, false, err
	}
	if !sameRepositoryProvision(operation, wanted) {
		return repositoryProvisioningOperation{}, false, errRepositoryProvisionMismatch
	}
	return operation, true, nil
}

func (s *postgresRepositoryProvisioningStore) MarkPublishReady(ctx context.Context, repositoryID int64, token, claimToken string) error {
	result, err := s.pool.Exec(ctx, `
		UPDATE repository_provisioning_operations
		SET publish_ready = TRUE, updated_at = NOW(), last_error = NULL
		WHERE repository_id = $1 AND token = $2 AND claim_token = $3
		  AND claimed_at > NOW() - make_interval(secs => $4::int)
	`, repositoryID, token, claimToken, durationSeconds(repositoryProvisionClaimLease))
	if err != nil {
		return fmt.Errorf("mark repository provision publish-ready: %w", err)
	}
	if result.RowsAffected() != 1 {
		return errRepositoryProvisionInProgress
	}
	return nil
}

func (s *postgresRepositoryProvisioningStore) RenewClaim(
	ctx context.Context,
	repositoryID int64,
	token string,
	claimToken string,
) error {
	result, err := s.pool.Exec(ctx, `
		UPDATE repository_provisioning_operations
		SET claimed_at = NOW(), updated_at = NOW()
		WHERE repository_id = $1 AND token = $2 AND claim_token = $3
	`, repositoryID, token, claimToken)
	if err != nil {
		return fmt.Errorf("renew repository provision claim: %w", err)
	}
	if result.RowsAffected() != 1 {
		return errRepositoryProvisionInProgress
	}
	return nil
}

func (s *postgresRepositoryProvisioningStore) AcquireProcessing(
	ctx context.Context,
	repositoryID int64,
	token string,
	claimToken string,
) error {
	result, err := s.pool.Exec(ctx, `
		UPDATE repository_provisioning_operations
		SET claim_token = $1, claimed_at = NOW(), attempts = attempts + 1, updated_at = NOW()
		WHERE repository_id = $2 AND token = $3
		  AND (claim_token IS NULL OR claimed_at <= NOW() - make_interval(secs => $4::int))
	`, claimToken, repositoryID, token, durationSeconds(repositoryProvisionClaimLease))
	if err != nil {
		return fmt.Errorf("claim repository provision: %w", err)
	}
	if result.RowsAffected() == 1 {
		return nil
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM repository_provisioning_operations
			WHERE repository_id = $1 AND token = $2
		)
	`, repositoryID, token).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errRepositoryProvisionMissing
	}
	return errRepositoryProvisionInProgress
}

func (s *postgresRepositoryProvisioningStore) Publish(
	ctx context.Context,
	operation repositoryProvisioningOperation,
	claimToken string,
) (_ db.Repository, retErr error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return db.Repository{}, fmt.Errorf("begin repository provision publication: %w", err)
	}
	defer func() {
		rollbackErr := tx.Rollback(context.Background())
		if rollbackErr != nil && !stdErrors.Is(rollbackErr, pgx.ErrTxClosed) && retErr == nil {
			retErr = fmt.Errorf("rollback repository provision publication: %w", rollbackErr)
		}
	}()
	if _, err := tx.Exec(ctx, repoOwnershipLockSQL, operation.RepositoryID); err != nil {
		return db.Repository{}, fmt.Errorf("lock reserved repository id: %w", err)
	}
	if err := lockRepositoryProvisionNamespace(ctx, tx, operation); err != nil {
		return db.Repository{}, err
	}
	current, err := loadProvisionByIDAndClaim(ctx, tx, operation.RepositoryID, claimToken)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return db.Repository{}, errRepositoryProvisionInProgress
		}
		return db.Repository{}, fmt.Errorf("load repository provision publication: %w", err)
	}
	if !sameRepositoryProvision(current, operation) || !current.PublishReady {
		return db.Repository{}, errRepositoryProvisionMismatch
	}

	q := db.New(tx)
	existing, err := q.GetRepoByID(ctx, operation.RepositoryID)
	if err == nil {
		if !repositoryMatchesProvision(existing, current) {
			return db.Repository{}, errRepositoryProvisionConflict
		}
		if err := bindPublishedImportJob(ctx, tx, current, operation); err != nil {
			return db.Repository{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return db.Repository{}, fmt.Errorf("commit adopted repository publication: %w", err)
		}
		return existing, nil
	}
	if !stdErrors.Is(err, pgx.ErrNoRows) {
		return db.Repository{}, fmt.Errorf("inspect reserved repository row: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('smithers.repository_provisioning_token', $1, TRUE)`, current.Token); err != nil {
		return db.Repository{}, fmt.Errorf("authorize repository publication: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO repositories (
			id, user_id, org_id, name, lower_name, description,
			is_public, default_bookmark, is_fork, fork_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`, current.RepositoryID, nullableInt8(current.UserID), nullableInt8(current.OrgID),
		current.Name, current.LowerName, current.Description,
		current.IsPublic, current.DefaultBookmark, current.IsFork, nullableInt8(current.ForkID))
	if err != nil {
		return db.Repository{}, fmt.Errorf("publish reserved repository row: %w", err)
	}
	repository, err := q.GetRepoByID(ctx, current.RepositoryID)
	if err != nil {
		return db.Repository{}, fmt.Errorf("load published repository row: %w", err)
	}
	if err := bindPublishedImportJob(ctx, tx, current, operation); err != nil {
		return db.Repository{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		// Publication may have committed. Reconcile only by reserved stable ID.
		recovered, recoverErr := db.New(s.pool).GetRepoByID(context.WithoutCancel(ctx), current.RepositoryID)
		if recoverErr == nil && repositoryMatchesProvision(recovered, current) {
			return recovered, nil
		}
		return db.Repository{}, fmt.Errorf("commit repository publication: %w", err)
	}
	return repository, nil
}

func (s *postgresRepositoryProvisioningStore) Complete(ctx context.Context, repositoryID int64, token, claimToken string) error {
	result, err := s.pool.Exec(ctx, `
		DELETE FROM repository_provisioning_operations
		WHERE repository_id = $1 AND token = $2 AND claim_token = $3
		  AND claimed_at > NOW() - make_interval(secs => $4::int)
	`, repositoryID, token, claimToken, durationSeconds(repositoryProvisionClaimLease))
	if err != nil {
		return fmt.Errorf("complete repository provision: %w", err)
	}
	if result.RowsAffected() != 1 {
		return errRepositoryProvisionMissing
	}
	return nil
}

// Abort serializes storage compensation with publication by holding the same
// provisioning row lock that the INSERT fence takes. Storage is never removed
// after the reserved repository row can become visible.
func (s *postgresRepositoryProvisioningStore) Abort(
	ctx context.Context,
	operation repositoryProvisioningOperation,
	claimToken string,
	abortStorage func(context.Context) error,
) (retErr error) {
	if abortStorage == nil {
		return fmt.Errorf("repository provision abort requires storage callback")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin repository provision abort: %w", err)
	}
	defer func() {
		rollbackErr := tx.Rollback(context.Background())
		if rollbackErr != nil && !stdErrors.Is(rollbackErr, pgx.ErrTxClosed) && retErr == nil {
			retErr = fmt.Errorf("rollback repository provision abort: %w", rollbackErr)
		}
	}()
	current, err := loadProvisionByIDAndClaim(ctx, tx, operation.RepositoryID, claimToken)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return errRepositoryProvisionInProgress
		}
		return err
	}
	if current.Token != operation.Token || !sameRepositoryProvision(current, operation) {
		return errRepositoryProvisionMismatch
	}
	var published bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM repositories WHERE id = $1)`, operation.RepositoryID).Scan(&published); err != nil {
		return err
	}
	if published {
		return errRepositoryProvisionConflict
	}
	if err := abortStorage(ctx); err != nil {
		return err
	}
	if current.OperationType == repositoryProvisionImport {
		result, err := tx.Exec(ctx, `
			UPDATE import_jobs
			SET provisioning_repository_id = NULL,
				provisioning_token = NULL,
				updated_at = NOW()
			WHERE provisioning_repository_id = $1
			  AND provisioning_token = $2
			  AND status = 'cloning'
			  AND claim_token = $3
		`, operation.RepositoryID, operation.Token, claimToken)
		if err != nil {
			return fmt.Errorf("clear aborted import reservation binding: %w", err)
		}
		if result.RowsAffected() != 1 {
			return fmt.Errorf("clear aborted import reservation binding: claim or binding changed")
		}
	}
	result, err := tx.Exec(ctx, `
		DELETE FROM repository_provisioning_operations
		WHERE repository_id = $1 AND token = $2
	`, operation.RepositoryID, operation.Token)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errRepositoryProvisionMissing
	}
	return tx.Commit(ctx)
}

func bindImportJobReservation(
	ctx context.Context,
	tx pgx.Tx,
	reserved repositoryProvisioningOperation,
	request repositoryProvisioningOperation,
) error {
	if reserved.OperationType != repositoryProvisionImport {
		return nil
	}
	if strings.TrimSpace(request.ImportJobID) == "" || strings.TrimSpace(request.ImportJobClaimToken) == "" {
		return fmt.Errorf("import repository reservation requires a claimed import job")
	}
	result, err := tx.Exec(ctx, `
		UPDATE import_jobs
		SET provisioning_repository_id = $1,
			provisioning_token = $2,
			repo_name = $3,
			updated_at = NOW()
		WHERE id = $4
		  AND user_id = $5
		  AND status = 'cloning'
		  AND claim_token = $6
		  AND (provisioning_repository_id IS NULL OR provisioning_repository_id = $1)
		  AND (provisioning_token IS NULL OR provisioning_token = $2)
	`, reserved.RepositoryID, reserved.Token, reserved.Name, request.ImportJobID,
		reserved.ActorID, request.ImportJobClaimToken)
	if err != nil {
		return fmt.Errorf("bind import job to repository reservation: %w", err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("bind import job to repository reservation: claim or binding changed")
	}
	return nil
}

func bindPublishedImportJob(
	ctx context.Context,
	tx pgx.Tx,
	current repositoryProvisioningOperation,
	request repositoryProvisioningOperation,
) error {
	if current.OperationType != repositoryProvisionImport {
		return nil
	}
	if strings.TrimSpace(request.ImportJobID) == "" || strings.TrimSpace(request.ImportJobClaimToken) == "" {
		return fmt.Errorf("import repository publication requires a claimed import job")
	}
	result, err := tx.Exec(ctx, `
		UPDATE import_jobs
		SET repository_id = $1, repo_name = $2, updated_at = NOW()
		WHERE id = $3
		  AND user_id = $4
		  AND status = 'cloning'
		  AND claim_token = $5
		  AND provisioning_repository_id = $1
		  AND provisioning_token = $6
	`, current.RepositoryID, current.Name, request.ImportJobID, current.ActorID,
		request.ImportJobClaimToken, current.Token)
	if err != nil {
		return fmt.Errorf("bind published repository to import job: %w", err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("bind published repository to import job: claim or binding changed")
	}
	return nil
}

func (s *postgresRepositoryProvisioningStore) GetByToken(ctx context.Context, token string) (repositoryProvisioningOperation, error) {
	return scanRepositoryProvision(s.pool.QueryRow(ctx, repositoryProvisionSelect+` WHERE token = $1`, token))
}

func (s *postgresRepositoryProvisioningStore) GetPublished(
	ctx context.Context,
	operation repositoryProvisioningOperation,
) (db.Repository, bool, error) {
	repository, err := db.New(s.pool).GetRepoByID(ctx, operation.RepositoryID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return db.Repository{}, false, nil
	}
	if err != nil {
		return db.Repository{}, false, err
	}
	if !repositoryMatchesProvision(repository, operation) {
		return db.Repository{}, false, errRepositoryProvisionConflict
	}
	return repository, true, nil
}

func (s *postgresRepositoryProvisioningStore) ClaimReady(ctx context.Context, claimToken string) ([]repositoryProvisioningOperation, error) {
	rows, err := s.pool.Query(ctx, `
		WITH candidates AS (
			SELECT repository_id
			FROM repository_provisioning_operations
			WHERE operation_type IN ('init', 'fork')
			  AND created_at <= NOW() - make_interval(secs => $1::int)
			  AND (claim_token IS NULL OR claimed_at <= NOW() - make_interval(secs => $2::int))
				-- Failed operations move behind untouched work because ReleaseClaim
				-- advances updated_at. With LIMIT 1 this prevents one poison journal
				-- from starving every later recovery forever.
				ORDER BY updated_at, created_at, repository_id
			FOR UPDATE SKIP LOCKED
			LIMIT $3
		)
		UPDATE repository_provisioning_operations AS operation
		SET claim_token = $4, claimed_at = NOW(), attempts = attempts + 1, updated_at = NOW()
		FROM candidates
		WHERE operation.repository_id = candidates.repository_id
		RETURNING operation.repository_id, operation.operation_type, operation.token,
			operation.actor_id, operation.storage_set_id, operation.owner_name, operation.user_id, operation.org_id,
			operation.name, operation.lower_name, operation.description, operation.is_public,
			operation.default_bookmark, operation.auto_init, operation.is_fork, operation.fork_id,
			operation.source_repository_id, operation.source_owner, operation.source_repo,
			operation.source_storage_set_id, operation.publish_ready, operation.claim_token,
			operation.claimed_at, operation.attempts, operation.last_error,
			operation.created_at, operation.updated_at
	`, durationSeconds(repositoryProvisionGrace), durationSeconds(repositoryProvisionClaimLease),
		repositoryProvisionBatchSize, claimToken)
	if err != nil {
		return nil, fmt.Errorf("list ready repository provisions: %w", err)
	}
	defer rows.Close()
	operations := make([]repositoryProvisioningOperation, 0)
	for rows.Next() {
		operation, scanErr := scanRepositoryProvision(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		operations = append(operations, operation)
	}
	return operations, rows.Err()
}

func (s *postgresRepositoryProvisioningStore) ReleaseClaim(ctx context.Context, operation repositoryProvisioningOperation, claimToken string, processErr error) {
	_, _ = s.pool.Exec(ctx, `
		UPDATE repository_provisioning_operations
		SET claim_token = NULL, claimed_at = NULL, last_error = $1, updated_at = NOW()
		WHERE repository_id = $2 AND claim_token = $3
	`, repositoryProvisionErrorText(processErr), operation.RepositoryID, claimToken)
}

func repositoryProvisionErrorText(err error) any {
	if err == nil {
		return nil
	}
	message := err.Error()
	if len(message) > 4096 {
		message = message[:4096]
	}
	return message
}

const repositoryProvisionSelect = `
	SELECT repository_id, operation_type, token, actor_id, storage_set_id,
		owner_name, user_id, org_id, name, lower_name, description,
		is_public, default_bookmark, auto_init, is_fork, fork_id,
		source_repository_id, source_owner, source_repo, source_storage_set_id,
		publish_ready, claim_token, claimed_at, attempts, last_error, created_at, updated_at
	FROM repository_provisioning_operations`

type provisionScanner interface{ Scan(...any) error }

func scanRepositoryProvision(row provisionScanner) (repositoryProvisioningOperation, error) {
	var operation repositoryProvisioningOperation
	err := row.Scan(
		&operation.RepositoryID, &operation.OperationType, &operation.Token, &operation.ActorID, &operation.StorageSetID,
		&operation.OwnerName, &operation.UserID, &operation.OrgID, &operation.Name,
		&operation.LowerName, &operation.Description, &operation.IsPublic,
		&operation.DefaultBookmark, &operation.AutoInit, &operation.IsFork, &operation.ForkID,
		&operation.SourceRepositoryID, &operation.SourceOwner, &operation.SourceRepo,
		&operation.SourceStorageSetID, &operation.PublishReady, &operation.ClaimToken,
		&operation.ClaimedAt, &operation.Attempts, &operation.LastError,
		&operation.CreatedAt, &operation.UpdatedAt,
	)
	return operation, err
}

func loadProvisionByOwnerName(ctx context.Context, tx pgx.Tx, operation repositoryProvisioningOperation) (repositoryProvisioningOperation, error) {
	return scanRepositoryProvision(tx.QueryRow(ctx, repositoryProvisionSelect+`
		WHERE lower_name = $1
		  AND (($2::bigint IS NOT NULL AND user_id = $2)
		       OR ($3::bigint IS NOT NULL AND org_id = $3))
		FOR UPDATE
	`, operation.LowerName, nullableInt8(operation.UserID), nullableInt8(operation.OrgID)))
}

func loadProvisionByIDAndClaim(
	ctx context.Context,
	tx pgx.Tx,
	repositoryID int64,
	claimToken string,
) (repositoryProvisioningOperation, error) {
	return scanRepositoryProvision(tx.QueryRow(ctx, repositoryProvisionSelect+`
		WHERE repository_id = $1
		  AND claim_token = $2
		  AND claimed_at > NOW() - make_interval(secs => $3::int)
		FOR UPDATE
	`, repositoryID, claimToken, durationSeconds(repositoryProvisionClaimLease)))
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
	store    *postgresRepositoryProvisioningStore
	repoHost repoHostProvisioningClient
}

func NewRepositoryProvisioningReconciler(pool *pgxpool.Pool, repoHost repoHostProvisioningClient) *RepositoryProvisioningReconciler {
	if pool == nil || repoHost == nil {
		return nil
	}
	return &RepositoryProvisioningReconciler{store: newPostgresRepositoryProvisioningStore(pool), repoHost: repoHost}
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
