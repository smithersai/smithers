package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// RepositoryProvisioningProduct preserves the caller's exact transaction;
// it never starts, commits, or rebinds a transaction owned by the deployment.
type RepositoryProvisioningProduct struct{ tx pgx.Tx }

func NewRepositoryProvisioningProduct(tx pgx.Tx) *RepositoryProvisioningProduct {
	return &RepositoryProvisioningProduct{tx: tx}
}
func (p *RepositoryProvisioningProduct) VerifyOwners(ctx context.Context, op RepositoryProvisioningOperation) error {
	return verifyProvisionOwners(ctx, p.tx, op)
}
func (p *RepositoryProvisioningProduct) LockNamespace(ctx context.Context, op RepositoryProvisioningOperation) error {
	return lockRepositoryProvisionNamespace(ctx, p.tx, op)
}
func (p *RepositoryProvisioningProduct) LockRepository(ctx context.Context, id int64) error {
	_, err := p.tx.Exec(ctx, repoOwnershipLockSQL, id)
	return err
}
func (p *RepositoryProvisioningProduct) NamespaceOccupied(ctx context.Context, op RepositoryProvisioningOperation) (bool, error) {
	var exists bool
	err := p.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM repositories WHERE lower_name=$1 AND (($2::bigint IS NOT NULL AND user_id=$2) OR ($3::bigint IS NOT NULL AND org_id=$3)))`, op.LowerName, nullableInt8(op.UserID), nullableInt8(op.OrgID)).Scan(&exists)
	return exists, err
}
func (p *RepositoryProvisioningProduct) ReserveRepositoryID(ctx context.Context) (int64, error) {
	var id int64
	err := p.tx.QueryRow(ctx, `SELECT nextval(pg_get_serial_sequence('repositories','id'))`).Scan(&id)
	return id, err
}
func (p *RepositoryProvisioningProduct) Repository(ctx context.Context, id int64) (db.Repository, error) {
	return db.New(p.tx).GetRepoByID(ctx, id)
}
func (p *RepositoryProvisioningProduct) RepositoryExists(ctx context.Context, id int64) (bool, error) {
	var exists bool
	err := p.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM repositories WHERE id=$1)`, id).Scan(&exists)
	return exists, err
}
func (p *RepositoryProvisioningProduct) PublishRepository(ctx context.Context, op RepositoryProvisioningOperation) error {
	_, err := p.tx.Exec(ctx, `INSERT INTO repositories(id,user_id,org_id,name,lower_name,description,is_public,default_bookmark,is_fork,fork_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, op.RepositoryID, nullableInt8(op.UserID), nullableInt8(op.OrgID), op.Name, op.LowerName, op.Description, op.IsPublic, op.DefaultBookmark, op.IsFork, nullableInt8(op.ForkID))
	return err
}
func (p *RepositoryProvisioningProduct) BindImportReservation(ctx context.Context, reserved, request RepositoryProvisioningOperation) error {
	return bindImportJobReservation(ctx, p.tx, reserved, request)
}
func (p *RepositoryProvisioningProduct) BindPublishedImport(ctx context.Context, current, request RepositoryProvisioningOperation) error {
	return bindPublishedImportJob(ctx, p.tx, current, request)
}
func (p *RepositoryProvisioningProduct) ClearAbortedImport(ctx context.Context, op RepositoryProvisioningOperation, claim string) error {
	result, err := p.tx.Exec(ctx, `UPDATE import_jobs SET provisioning_repository_id=NULL,provisioning_token=NULL,updated_at=NOW() WHERE provisioning_repository_id=$1 AND provisioning_token=$2 AND status='cloning' AND claim_token=$3`, op.RepositoryID, op.Token, claim)
	if err != nil {
		return fmt.Errorf("clear aborted import reservation binding: %w", err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("clear aborted import reservation binding: claim or binding changed")
	}
	return nil
}

// FailUnboundImportJobs is the canonical product mutation used after a host has
// proved its old writers drained. The caller owns the fence transaction.
func (p *RepositoryProvisioningProduct) FailUnboundImportJobs(ctx context.Context, message string) error {
	_, err := p.tx.Exec(ctx, `UPDATE import_jobs SET status='failed',stage='',error=$1,claim_token=NULL,claimed_at=NULL,updated_at=NOW() WHERE status='cloning' AND provisioning_repository_id IS NULL AND provisioning_token IS NULL`, message)
	return err
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
