package services

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestSearch_Z_SearchIssuesZeroCountSkipsQuery(t *testing.T) {
	mock := &mockSearchQuerier{
		countSearchIssuesFn: func(context.Context, db.CountSearchIssuesFTSParams) (int64, error) {
			return 0, nil
		},
		searchIssuesFTSFn: func(context.Context, db.SearchIssuesFTSParams) ([]db.SearchIssuesFTSRow, error) {
			t.Fatal("search should not execute when count is zero")
			return nil, nil
		},
	}
	page, err := NewSearchService(mock).SearchIssues(context.Background(), nil, SearchIssuesInput{Query: "bug"})
	require.NoError(t, err)
	assert.Empty(t, page.Items)
	assert.Equal(t, int64(0), page.TotalCount)
	assert.False(t, mock.searchIssuesWasCalled)
}
