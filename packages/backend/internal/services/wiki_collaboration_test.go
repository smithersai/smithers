package services

import (
	"context"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type wikiHistoryFixture struct {
	*db.Queries
	rows []db.WikiPageRevision
}

func (f *wikiHistoryFixture) CountWikiRevisions(context.Context, db.CountWikiRevisionsParams) (int64, error) {
	return int64(len(f.rows)), nil
}
func (f *wikiHistoryFixture) ListWikiRevisions(context.Context, db.ListWikiRevisionsParams) ([]db.WikiPageRevision, error) {
	return f.rows, nil
}
