package services

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type landingStatusQuerier interface {
	GetLatestCommitStatusesByChangeIDsAndContexts(context.Context, db.GetLatestCommitStatusesByChangeIDsAndContextsParams) ([]db.GetLatestCommitStatusesByChangeIDsAndContextsRow, error)
}

type landingRevisionStatusQuerier interface {
	ListFailingLandingRevisionChecks(context.Context, db.ListFailingLandingRevisionChecksParams) ([]string, error)
}

func landingRevisionPins(revisions json.RawMessage) (map[string]string, error) {
	var snapshot map[string]approvalRevision
	if err := json.Unmarshal(revisions, &snapshot); err != nil {
		return nil, err
	}
	pins := make(map[string]string, len(snapshot))
	for change, revision := range snapshot {
		pins[change] = revision.CommitID
	}
	return pins, nil
}

// Production checks statuses in one query against the same immutable revisions
// as ownership and storage. Legacy test doubles use one query per change so a
// passing stack member can never mask a different member's failed check.
func failingLandingStatusContexts(ctx context.Context, q landingStatusQuerier, repositoryID int64, changeIDs, contexts []string, pinned ...map[string]string) ([]string, error) {
	if len(changeIDs) == 0 {
		return contexts, nil
	}
	if revisionQueries, ok := q.(landingRevisionStatusQuerier); ok {
		if len(pinned) == 0 {
			return nil, fmt.Errorf("landing revision snapshot is required")
		}
		for _, id := range changeIDs {
			if pinned[0][id] == "" {
				return nil, fmt.Errorf("missing landing revision for %s", id)
			}
		}
		revisions, err := json.Marshal(pinned[0])
		if err != nil {
			return nil, err
		}
		return revisionQueries.ListFailingLandingRevisionChecks(ctx, db.ListFailingLandingRevisionChecksParams{RepositoryID: repositoryID, Revisions: revisions, Contexts: contexts})
	}
	failed := make(map[string]bool, len(contexts))
	for _, changeID := range changeIDs {
		rows, err := q.GetLatestCommitStatusesByChangeIDsAndContexts(ctx, db.GetLatestCommitStatusesByChangeIDsAndContextsParams{RepositoryID: repositoryID, ChangeIds: []string{changeID}, Contexts: contexts})
		if err != nil {
			return nil, err
		}
		latest := make(map[string]string, len(rows))
		for _, row := range rows {
			latest[row.Context] = row.Status
		}
		for _, context := range contexts {
			failed[context] = failed[context] || latest[context] != "success"
		}
	}
	var failing []string
	for _, context := range contexts {
		if failed[context] {
			failing = append(failing, context)
		}
	}
	return failing, nil
}
