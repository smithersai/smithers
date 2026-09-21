package services

import (
	"context"
	"encoding/json"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type LandingAppendPin struct {
	ChangeID string `json:"change_id"`
	CommitID string `json:"commit_id"`
}
type LandingAppendPreparation struct {
	Status string `json:"status"`
	repohost.AppendPreparationRequest
	Changes []LandingAppendPin `json:"changes"`
}
type landingAppendPreparer interface {
	PrepareLandAppend(context.Context, string, string, repohost.AppendPreparationRequest) (repohost.AppendPreparation, error)
}

func (s *LandingService) PrepareLandingAppend(ctx context.Context, actor *db.User, owner, repo string, request repohost.AppendPreparationRequest) (LandingAppendPreparation, error) {
	if actor == nil {
		return LandingAppendPreparation{}, pkgerrors.Unauthorized("authentication required")
	}
	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return LandingAppendPreparation{}, err
	}
	if err = s.requireWriteAccess(ctx, repository, actor); err != nil {
		return LandingAppendPreparation{}, err
	}
	if repohost.ValidateBookmarkName(request.TargetBookmark) != nil || !immutableLandingCommit(request.ExpectedCommitID) || !immutableLandingCommit(request.SourceCommitID) || !immutableLandingCommit(request.SourceBaseCommitID) {
		return LandingAppendPreparation{}, pkgerrors.BadRequest("append preparation requires exact immutable commits and target")
	}
	native, ok := s.repoHost.(landingAppendPreparer)
	if !ok {
		return LandingAppendPreparation{}, pkgerrors.New(pkgerrors.CodeAppendPrepareUnavailable, "native append preparation is unavailable")
	}
	result, err := native.PrepareLandAppend(ctx, owner, repo, request)
	if err != nil {
		return LandingAppendPreparation{}, mapLandingRepoHostError(err, "failed to prepare native append")
	}
	if result.Status != "prepared" || result.AppendPreparationRequest != request || len(result.Changes) == 0 || len(result.Changes) > maxLandingStackChanges || result.Changes[len(result.Changes)-1].CommitID != request.SourceCommitID {
		return LandingAppendPreparation{}, pkgerrors.New(pkgerrors.CodeAppendPrepareInvalid, "native append preparation did not match exact source")
	}
	pins := make([]LandingAppendPin, len(result.Changes))
	seen := map[string]bool{}
	for i, change := range result.Changes {
		if !codingChangeID.MatchString(change.ChangeID) || !immutableLandingCommit(change.CommitID) || seen[change.ChangeID] {
			return LandingAppendPreparation{}, pkgerrors.New(pkgerrors.CodeAppendPrepareInvalid, "native append preparation contains invalid identities")
		}
		seen[change.ChangeID] = true
		pins[i] = LandingAppendPin{ChangeID: change.ChangeID, CommitID: change.CommitID}
	}
	if err = s.projectPreparedAppend(ctx, repository.ID, result.Changes); err != nil {
		return LandingAppendPreparation{}, err
	}
	return LandingAppendPreparation{Status: "prepared", AppendPreparationRequest: request, Changes: pins}, nil
}

// Reuse the same native revision projections that ordinary pushes populate.
// These records make exact revisions reviewable; they are not acceptance gates.
type landingAppendProjection interface {
	UpsertChange(context.Context, db.UpsertChangeParams) (db.Change, error)
	RecordChangeRevision(context.Context, db.RecordChangeRevisionParams) (db.ChangeRevision, error)
}

func (t *pgxLandingCreateTx) UpsertChange(ctx context.Context, p db.UpsertChangeParams) (db.Change, error) {
	return t.q.UpsertChange(ctx, p)
}
func (t *pgxLandingCreateTx) RecordChangeRevision(ctx context.Context, p db.RecordChangeRevisionParams) (db.ChangeRevision, error) {
	return t.q.RecordChangeRevision(ctx, p)
}
func (s *LandingService) projectPreparedAppend(ctx context.Context, repositoryID int64, changes []repohost.Change) error {
	if s.createTxManager == nil {
		return pkgerrors.New(pkgerrors.CodeAppendPrepareUnavailable, "native revision projection requires the existing transactional store")
	}
	tx, err := s.createTxManager.BeginCreateTx(ctx)
	if err != nil {
		return pkgerrors.Internal("failed to start native revision projection")
	}
	defer rollbackLandingTx(ctx, tx)
	q, ok := tx.(landingAppendProjection)
	if !ok {
		return pkgerrors.New(pkgerrors.CodeAppendPrepareUnavailable, "native revision projection is unavailable")
	}
	for _, change := range changes {
		parents := change.ParentChangeIDs
		if parents == nil {
			parents = []string{}
		}
		raw, _ := json.Marshal(parents)
		_, err = q.UpsertChange(ctx, db.UpsertChangeParams{RepositoryID: repositoryID, ChangeID: change.ChangeID, CommitID: change.CommitID, Description: change.Description, AuthorName: change.AuthorName, AuthorEmail: change.AuthorEmail, HasConflict: change.HasConflict, IsEmpty: change.IsEmpty, ParentChangeIds: raw})
		if err != nil {
			return pkgerrors.Internal("failed to project native change")
		}
		_, err = q.RecordChangeRevision(ctx, db.RecordChangeRevisionParams{RepositoryID: repositoryID, ChangeID: change.ChangeID, CommitID: change.CommitID, ParentCommitID: change.ParentCommitID, Source: "push", OperationIds: []string{}})
		if err != nil {
			return pkgerrors.Internal("failed to project immutable change revision")
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return pkgerrors.Internal("failed to commit native revision projection")
	}
	return nil
}
