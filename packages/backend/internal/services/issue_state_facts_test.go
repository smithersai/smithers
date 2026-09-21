package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type issueStateTestQueries struct {
	*mockEventQuerier
	head    int64
	rows    []db.IssueStateFact
	loadErr error
	loaded  bool
}

func (q *issueStateTestQueries) GetIssueStateJournal(context.Context, int64) (db.IssueStateJournal, error) {
	return db.IssueStateJournal{Head: q.head, CoverageKind: "from_creation", CoverageStartedAt: time.Now().UTC()}, nil
}
func (q *issueStateTestQueries) ListIssueStateFacts(_ context.Context, arg db.ListIssueStateFactsParams) ([]db.IssueStateFact, error) {
	q.loaded = true
	return q.rows, q.loadErr
}
func TestIssueStateFactsFailClosedOnChangedScopePermissionAndStorage(t *testing.T) {
	for _, test := range []struct {
		name                                      string
		privateBefore, privateAfter, changedAfter bool
		head                                      int64
		wrongScope                                bool
		loadErr                                   error
		message                                   string
	}{
		{name: "private before read", privateBefore: true, message: "permission denied"},
		{name: "private after read", privateAfter: true, message: "permission denied"},
		{name: "repository name reused", changedAfter: true, message: "repository changed"},
		{name: "cross-repository fact", wrongScope: true, message: "scope or position mismatch"},
		{name: "missing retained facts", head: 2, message: "truncated"},
		{name: "storage unavailable", loadErr: fmt.Errorf("offline"), message: "read issue state facts"},
	} {
		t.Run(test.name, func(t *testing.T) {
			q := &issueStateTestQueries{mockEventQuerier: &mockEventQuerier{}, head: test.head, loadErr: test.loadErr}
			q.getRepoFn = func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
				id := int64(1)
				if q.loaded && test.changedAfter {
					id = 2
				}
				return db.Repository{ID: id, IsPublic: !test.privateBefore && (!q.loaded || !test.privateAfter), UserID: pgtype.Int8{Int64: 99, Valid: true}}, nil
			}
			if test.wrongScope {
				q.head = 1
				q.rows = []db.IssueStateFact{{RepositoryID: 2, Sequence: 1, EventID: uuid.NewString(), SchemaVersion: 1, EntityType: "issue", Operation: "deleted", IssueID: 7, EntityKey: "7", RecordedAt: time.Now().UTC()}}
			}
			page, err := NewIssueEventService(q).ListIssueStateFacts(context.Background(), &db.User{ID: 3}, "owner", "repo", 1, 0, 1000)
			require.ErrorContains(t, err, test.message)
			require.Empty(t, page.Events)
			require.Zero(t, page.Cursor)
			if test.privateBefore {
				require.False(t, q.loaded, "private data must not even be read before authorization")
			}
		})
	}
}
