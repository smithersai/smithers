package services

import (
	"context"
	"encoding/json"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type landingImportedRevisionQuerier interface {
	UpsertChange(context.Context, db.UpsertChangeParams) (db.Change, error)
	RecordChangeRevision(context.Context, db.RecordChangeRevisionParams) (db.ChangeRevision, error)
}

// Imports can populate repo-host without passing through the push recorder.
// Recover only a current immutable commit belonging to this landing's stored
// change set. Never resolve an arbitrary caller-supplied commit as a new member.
func (s *LandingService) recoverImportedLandingRevision(ctx context.Context, repositoryID int64, owner, repo string, landingID int64, commitID, resource string) (db.ChangeRevision, error) {
	invalid := func() (db.ChangeRevision, error) {
		return db.ChangeRevision{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: resource, Field: "commit_id", Code: "invalid"})
	}
	q, ok := s.queries.(landingImportedRevisionQuerier)
	if !ok {
		return invalid()
	}
	members, err := s.queries.ListLandingRequestChanges(ctx, db.ListLandingRequestChangesParams{
		LandingRequestID: landingID, PageSize: maxLandingStackChanges + 1,
	})
	if err != nil {
		return db.ChangeRevision{}, pkgerrors.Internal("failed to load landing changes")
	}
	if len(members) == 0 || len(members) > maxLandingStackChanges {
		return invalid()
	}
	for _, member := range members {
		change, err := s.repoHost.GetChange(ctx, owner, repo, member.ChangeID)
		if err != nil {
			return db.ChangeRevision{}, mapLandingRepoHostError(err, "failed to load landing change")
		}
		if change.ChangeID != member.ChangeID || change.CommitID != commitID {
			continue
		}
		if change.ParentChangeIDs == nil {
			change.ParentChangeIDs = []string{}
		}
		parents, err := json.Marshal(change.ParentChangeIDs)
		if err != nil {
			return db.ChangeRevision{}, pkgerrors.Internal("failed to encode landing change parents")
		}
		if _, err := q.UpsertChange(ctx, db.UpsertChangeParams{
			RepositoryID: repositoryID, ChangeID: change.ChangeID, CommitID: change.CommitID,
			Description: change.Description, AuthorName: change.AuthorName, AuthorEmail: change.AuthorEmail,
			HasConflict: change.HasConflict, IsEmpty: change.IsEmpty, ParentChangeIds: parents,
		}); err != nil {
			return db.ChangeRevision{}, pkgerrors.Internal("failed to store imported landing change")
		}
		revision, err := q.RecordChangeRevision(ctx, db.RecordChangeRevisionParams{
			RepositoryID: repositoryID, ChangeID: change.ChangeID, CommitID: change.CommitID,
			ParentCommitID: change.ParentCommitID, Source: "push", OperationIds: []string{},
		})
		if err != nil {
			return db.ChangeRevision{}, pkgerrors.Internal("failed to store imported landing revision")
		}
		return revision, nil
	}
	return invalid()
}
