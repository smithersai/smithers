package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type mockSearchQuerier struct {
	searchRepositoriesFTSFn     func(ctx context.Context, arg db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error)
	countSearchRepositoriesFn   func(ctx context.Context, arg db.CountSearchRepositoriesFTSParams) (int64, error)
	searchIssuesFTSFn           func(ctx context.Context, arg db.SearchIssuesFTSParams) ([]db.SearchIssuesFTSRow, error)
	countSearchIssuesFn         func(ctx context.Context, arg db.CountSearchIssuesFTSParams) (int64, error)
	searchUsersFTSFn            func(ctx context.Context, arg db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error)
	countSearchUsersFn          func(ctx context.Context, query string) (int64, error)
	searchCodeFTSFn             func(ctx context.Context, arg db.SearchCodeFTSParams) ([]db.SearchCodeFTSRow, error)
	countSearchCodeFn           func(ctx context.Context, arg db.CountSearchCodeFTSParams) (int64, error)
	searchRepositoriesWasCalled bool
	searchIssuesWasCalled       bool
	searchUsersWasCalled        bool
	searchCodeWasCalled         bool
}

func (m *mockSearchQuerier) SearchRepositoriesFTS(ctx context.Context, arg db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error) {
	m.searchRepositoriesWasCalled = true
	return m.searchRepositoriesFTSFn(ctx, arg)
}

func (m *mockSearchQuerier) CountSearchRepositoriesFTS(ctx context.Context, arg db.CountSearchRepositoriesFTSParams) (int64, error) {
	return m.countSearchRepositoriesFn(ctx, arg)
}

func (m *mockSearchQuerier) SearchIssuesFTS(ctx context.Context, arg db.SearchIssuesFTSParams) ([]db.SearchIssuesFTSRow, error) {
	m.searchIssuesWasCalled = true
	return m.searchIssuesFTSFn(ctx, arg)
}

func (m *mockSearchQuerier) CountSearchIssuesFTS(ctx context.Context, arg db.CountSearchIssuesFTSParams) (int64, error) {
	return m.countSearchIssuesFn(ctx, arg)
}

func (m *mockSearchQuerier) SearchUsersFTS(ctx context.Context, arg db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error) {
	m.searchUsersWasCalled = true
	return m.searchUsersFTSFn(ctx, arg)
}

func (m *mockSearchQuerier) CountSearchUsersFTS(ctx context.Context, query string) (int64, error) {
	return m.countSearchUsersFn(ctx, query)
}

func (m *mockSearchQuerier) SearchCodeFTS(ctx context.Context, arg db.SearchCodeFTSParams) ([]db.SearchCodeFTSRow, error) {
	m.searchCodeWasCalled = true
	return m.searchCodeFTSFn(ctx, arg)
}

func (m *mockSearchQuerier) CountSearchCodeFTS(ctx context.Context, arg db.CountSearchCodeFTSParams) (int64, error) {
	return m.countSearchCodeFn(ctx, arg)
}

func TestSearchService_SearchRepositories_QueryRequired(t *testing.T) {
	t.Parallel()

	mock := &mockSearchQuerier{
		searchRepositoriesFTSFn: func(ctx context.Context, arg db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error) {
			t.Fatal("query should not execute")
			return nil, nil
		},
		countSearchRepositoriesFn: func(ctx context.Context, arg db.CountSearchRepositoriesFTSParams) (int64, error) {
			t.Fatal("count should not execute")
			return 0, nil
		},
	}
	svc := NewSearchService(mock)

	_, err := svc.SearchRepositories(context.Background(), nil, SearchRepositoriesInput{
		Query: "   ",
	})
	require.Error(t, err)
	apiErr := mustSearchAPIError(t, err)
	assert.Equal(t, 422, apiErr.Status)
	assert.Equal(t, "query required", apiErr.Message)
	assert.False(t, mock.searchRepositoriesWasCalled)
}

func TestSearchService_SearchRepositories(t *testing.T) {
	t.Parallel()

	t.Run("happy path", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchRepositoriesFn: func(ctx context.Context, arg db.CountSearchRepositoriesFTSParams) (int64, error) {
				assert.Equal(t, "auth", arg.Query)
				assert.Equal(t, int64(42), arg.ViewerID)
				return 2, nil
			},
			searchRepositoriesFTSFn: func(ctx context.Context, arg db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error) {
				assert.Equal(t, "auth", arg.Query)
				assert.Equal(t, int64(42), arg.ViewerID)
				assert.Equal(t, int32(10), arg.PageSize)
				assert.Equal(t, int32(10), arg.PageOffset)
				return []db.SearchRepositoriesFTSRow{
					{ID: 10, OwnerName: "alice", Name: "auth-core", Description: "repo", IsPublic: true},
					{ID: 11, OwnerName: "acme", Name: "auth-ui", Description: "repo", IsPublic: true},
				}, nil
			},
		})

		result, err := svc.SearchRepositories(context.Background(), &db.User{ID: 42}, SearchRepositoriesInput{
			Query:   "auth",
			Page:    2,
			PerPage: 10,
		})
		require.NoError(t, err)
		assert.Equal(t, int64(2), result.TotalCount)
		assert.Equal(t, 2, result.Page)
		assert.Equal(t, 10, result.PerPage)
		require.Len(t, result.Items, 2)
		assert.Equal(t, "alice", result.Items[0].Owner)
	})

	t.Run("pagination clamp", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchRepositoriesFn: func(ctx context.Context, arg db.CountSearchRepositoriesFTSParams) (int64, error) {
				return 0, nil
			},
			searchRepositoriesFTSFn: func(ctx context.Context, arg db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error) {
				assert.Equal(t, int32(100), arg.PageSize)
				assert.Equal(t, int32(0), arg.PageOffset)
				return nil, nil
			},
		})

		result, err := svc.SearchRepositories(context.Background(), nil, SearchRepositoriesInput{
			Query:   "repo",
			Page:    0,
			PerPage: 999,
		})
		require.NoError(t, err)
		assert.Equal(t, 1, result.Page)
		assert.Equal(t, 100, result.PerPage)
	})

	t.Run("count zero skips search query", func(t *testing.T) {
		mock := &mockSearchQuerier{
			countSearchRepositoriesFn: func(ctx context.Context, arg db.CountSearchRepositoriesFTSParams) (int64, error) {
				return 0, nil
			},
			searchRepositoriesFTSFn: func(ctx context.Context, arg db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error) {
				t.Fatal("search should not run when count is zero")
				return nil, nil
			},
		}
		svc := NewSearchService(mock)

		result, err := svc.SearchRepositories(context.Background(), nil, SearchRepositoriesInput{
			Query: "repo",
		})
		require.NoError(t, err)
		assert.Equal(t, int64(0), result.TotalCount)
		assert.Len(t, result.Items, 0)
		assert.False(t, mock.searchRepositoriesWasCalled)
	})

	t.Run("count error", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchRepositoriesFn: func(ctx context.Context, arg db.CountSearchRepositoriesFTSParams) (int64, error) {
				return 0, errors.New("boom")
			},
			searchRepositoriesFTSFn: func(ctx context.Context, arg db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		})

		_, err := svc.SearchRepositories(context.Background(), nil, SearchRepositoriesInput{Query: "repo"})
		require.Error(t, err)
		assert.Equal(t, 500, mustSearchAPIError(t, err).Status)
	})

	t.Run("list error", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchRepositoriesFn: func(ctx context.Context, arg db.CountSearchRepositoriesFTSParams) (int64, error) {
				return 1, nil
			},
			searchRepositoriesFTSFn: func(ctx context.Context, arg db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error) {
				return nil, errors.New("boom")
			},
		})

		_, err := svc.SearchRepositories(context.Background(), nil, SearchRepositoriesInput{Query: "repo"})
		require.Error(t, err)
		assert.Equal(t, 500, mustSearchAPIError(t, err).Status)
	})
}

func TestSearchService_SearchIssues(t *testing.T) {
	t.Parallel()

	t.Run("happy path", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchIssuesFn: func(ctx context.Context, arg db.CountSearchIssuesFTSParams) (int64, error) {
				assert.Equal(t, "bug", arg.Query)
				assert.Equal(t, "open", arg.StateFilter)
				assert.Equal(t, "bug", arg.LabelFilter)
				assert.Equal(t, "alice", arg.AssigneeFilter)
				assert.Equal(t, "v1.0", arg.MilestoneFilter)
				return 1, nil
			},
			searchIssuesFTSFn: func(ctx context.Context, arg db.SearchIssuesFTSParams) ([]db.SearchIssuesFTSRow, error) {
				assert.Equal(t, "bug", arg.Query)
				assert.Equal(t, int32(25), arg.PageSize)
				assert.Equal(t, int32(25), arg.PageOffset)
				assert.Equal(t, "open", arg.StateFilter)
				assert.Equal(t, "bug", arg.LabelFilter)
				assert.Equal(t, "alice", arg.AssigneeFilter)
				assert.Equal(t, "v1.0", arg.MilestoneFilter)
				return []db.SearchIssuesFTSRow{
					{
						ID:             99,
						RepositoryID:   55,
						RepositoryName: "core",
						OwnerName:      "alice",
						Number:         10,
						Title:          "bug in auth",
						State:          "open",
					},
				}, nil
			},
		})

		result, err := svc.SearchIssues(context.Background(), &db.User{ID: 7}, SearchIssuesInput{
			Query:     "bug",
			State:     "open",
			Label:     " Bug ",
			Assignee:  " Alice ",
			Milestone: " V1.0 ",
			Page:      2,
			PerPage:   25,
		})
		require.NoError(t, err)
		assert.Equal(t, int64(1), result.TotalCount)
		require.Len(t, result.Items, 1)
		assert.Equal(t, int64(10), result.Items[0].Number)
	})

	t.Run("invalid state", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchIssuesFn: func(ctx context.Context, arg db.CountSearchIssuesFTSParams) (int64, error) {
				t.Fatal("count should not run")
				return 0, nil
			},
			searchIssuesFTSFn: func(ctx context.Context, arg db.SearchIssuesFTSParams) ([]db.SearchIssuesFTSRow, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		})

		_, err := svc.SearchIssues(context.Background(), nil, SearchIssuesInput{
			Query: "bug",
			State: "invalid",
		})
		require.Error(t, err)
		assert.Equal(t, 422, mustSearchAPIError(t, err).Status)
	})

	t.Run("count error", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchIssuesFn: func(ctx context.Context, arg db.CountSearchIssuesFTSParams) (int64, error) {
				return 0, errors.New("boom")
			},
			searchIssuesFTSFn: func(ctx context.Context, arg db.SearchIssuesFTSParams) ([]db.SearchIssuesFTSRow, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		})

		_, err := svc.SearchIssues(context.Background(), nil, SearchIssuesInput{
			Query: "bug",
		})
		require.Error(t, err)
		assert.Equal(t, 500, mustSearchAPIError(t, err).Status)
	})

	t.Run("list error", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchIssuesFn: func(ctx context.Context, arg db.CountSearchIssuesFTSParams) (int64, error) {
				return 1, nil
			},
			searchIssuesFTSFn: func(ctx context.Context, arg db.SearchIssuesFTSParams) ([]db.SearchIssuesFTSRow, error) {
				return nil, errors.New("boom")
			},
		})

		_, err := svc.SearchIssues(context.Background(), nil, SearchIssuesInput{
			Query: "bug",
		})
		require.Error(t, err)
		assert.Equal(t, 500, mustSearchAPIError(t, err).Status)
	})
}

func TestSearchService_SearchUsers(t *testing.T) {
	t.Parallel()

	t.Run("happy path", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchUsersFn: func(ctx context.Context, query string) (int64, error) {
				assert.Equal(t, "alice", query)
				return 1, nil
			},
			searchUsersFTSFn: func(ctx context.Context, arg db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error) {
				assert.Equal(t, "alice", arg.Query)
				assert.Equal(t, int32(30), arg.PageSize)
				assert.Equal(t, int32(0), arg.PageOffset)
				return []db.SearchUsersFTSRow{
					{ID: 1, Username: "alice", DisplayName: "Alice"},
				}, nil
			},
		})

		result, err := svc.SearchUsers(context.Background(), SearchUsersInput{Query: "alice"})
		require.NoError(t, err)
		assert.Equal(t, int64(1), result.TotalCount)
		require.Len(t, result.Items, 1)
		assert.Equal(t, "alice", result.Items[0].Username)
	})

	t.Run("query required", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchUsersFn: func(ctx context.Context, query string) (int64, error) {
				t.Fatal("count should not run")
				return 0, nil
			},
			searchUsersFTSFn: func(ctx context.Context, arg db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		})

		_, err := svc.SearchUsers(context.Background(), SearchUsersInput{Query: "   "})
		require.Error(t, err)
		assert.Equal(t, 422, mustSearchAPIError(t, err).Status)
	})

	t.Run("db errors", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchUsersFn: func(ctx context.Context, query string) (int64, error) {
				return 0, errors.New("boom")
			},
			searchUsersFTSFn: func(ctx context.Context, arg db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		})

		_, err := svc.SearchUsers(context.Background(), SearchUsersInput{Query: "alice"})
		require.Error(t, err)
		assert.Equal(t, 500, mustSearchAPIError(t, err).Status)
	})

	t.Run("count zero skips search query", func(t *testing.T) {
		mock := &mockSearchQuerier{
			countSearchUsersFn: func(ctx context.Context, query string) (int64, error) {
				return 0, nil
			},
			searchUsersFTSFn: func(ctx context.Context, arg db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		}
		svc := NewSearchService(mock)

		result, err := svc.SearchUsers(context.Background(), SearchUsersInput{Query: "alice"})
		require.NoError(t, err)
		assert.Equal(t, int64(0), result.TotalCount)
		assert.Len(t, result.Items, 0)
		assert.False(t, mock.searchUsersWasCalled)
	})
}

func TestSearchService_SearchCode(t *testing.T) {
	t.Parallel()

	t.Run("query required", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchCodeFn: func(ctx context.Context, arg db.CountSearchCodeFTSParams) (int64, error) {
				t.Fatal("count should not run")
				return 0, nil
			},
			searchCodeFTSFn: func(ctx context.Context, arg db.SearchCodeFTSParams) ([]db.SearchCodeFTSRow, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		})

		_, err := svc.SearchCode(context.Background(), nil, SearchCodeInput{Query: "   "})
		require.Error(t, err)
		assert.Equal(t, 422, mustSearchAPIError(t, err).Status)
	})

	t.Run("happy path", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchCodeFn: func(ctx context.Context, arg db.CountSearchCodeFTSParams) (int64, error) {
				assert.Equal(t, "README", arg.Query)
				assert.Equal(t, int64(33), arg.ViewerID)
				return 1, nil
			},
			searchCodeFTSFn: func(ctx context.Context, arg db.SearchCodeFTSParams) ([]db.SearchCodeFTSRow, error) {
				assert.Equal(t, "README", arg.Query)
				assert.Equal(t, int64(33), arg.ViewerID)
				assert.Equal(t, int32(0), arg.PageOffset)
				assert.Equal(t, int32(30), arg.PageSize)
				return []db.SearchCodeFTSRow{
					{
						RepositoryID:   77,
						RepositoryName: "core",
						OwnerName:      "alice",
						FilePath:       "README.md",
						Snippet:        []byte("hello from readme"),
					},
				}, nil
			},
		})

		result, err := svc.SearchCode(context.Background(), &db.User{ID: 33}, SearchCodeInput{Query: "README"})
		require.NoError(t, err)
		assert.Equal(t, int64(1), result.TotalCount)
		require.Len(t, result.Items, 1)
		assert.Equal(t, "README.md", result.Items[0].Path)
	})

	t.Run("count zero skips search query", func(t *testing.T) {
		mock := &mockSearchQuerier{
			countSearchCodeFn: func(ctx context.Context, arg db.CountSearchCodeFTSParams) (int64, error) {
				return 0, nil
			},
			searchCodeFTSFn: func(ctx context.Context, arg db.SearchCodeFTSParams) ([]db.SearchCodeFTSRow, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		}
		svc := NewSearchService(mock)

		result, err := svc.SearchCode(context.Background(), nil, SearchCodeInput{Query: "README"})
		require.NoError(t, err)
		assert.Equal(t, int64(0), result.TotalCount)
		assert.Len(t, result.Items, 0)
		assert.False(t, mock.searchCodeWasCalled)
	})

	t.Run("count error", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchCodeFn: func(ctx context.Context, arg db.CountSearchCodeFTSParams) (int64, error) {
				return 0, errors.New("boom")
			},
			searchCodeFTSFn: func(ctx context.Context, arg db.SearchCodeFTSParams) ([]db.SearchCodeFTSRow, error) {
				t.Fatal("list should not run")
				return nil, nil
			},
		})

		_, err := svc.SearchCode(context.Background(), nil, SearchCodeInput{Query: "README"})
		require.Error(t, err)
		assert.Equal(t, 500, mustSearchAPIError(t, err).Status)
	})

	t.Run("list error", func(t *testing.T) {
		svc := NewSearchService(&mockSearchQuerier{
			countSearchCodeFn: func(ctx context.Context, arg db.CountSearchCodeFTSParams) (int64, error) {
				return 1, nil
			},
			searchCodeFTSFn: func(ctx context.Context, arg db.SearchCodeFTSParams) ([]db.SearchCodeFTSRow, error) {
				return nil, errors.New("boom")
			},
		})

		_, err := svc.SearchCode(context.Background(), nil, SearchCodeInput{Query: "README"})
		require.Error(t, err)
		assert.Equal(t, 500, mustSearchAPIError(t, err).Status)
	})
}

// TestSearchService_InputHardening covers malformed / adversarial query strings
// across all four search domains.
func TestSearchService_InputHardening(t *testing.T) {
	t.Parallel()

	// rejectsMock returns a mock that fails the test if any DB call is made.
	rejectsMock := func(t *testing.T) *mockSearchQuerier {
		t.Helper()
		return &mockSearchQuerier{
			countSearchRepositoriesFn: func(_ context.Context, _ db.CountSearchRepositoriesFTSParams) (int64, error) {
				t.Fatal("DB should not be called")
				return 0, nil
			},
			searchRepositoriesFTSFn: func(_ context.Context, _ db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error) {
				t.Fatal("DB should not be called")
				return nil, nil
			},
			countSearchIssuesFn: func(_ context.Context, _ db.CountSearchIssuesFTSParams) (int64, error) {
				t.Fatal("DB should not be called")
				return 0, nil
			},
			searchIssuesFTSFn: func(_ context.Context, _ db.SearchIssuesFTSParams) ([]db.SearchIssuesFTSRow, error) {
				t.Fatal("DB should not be called")
				return nil, nil
			},
			countSearchUsersFn: func(_ context.Context, _ string) (int64, error) {
				t.Fatal("DB should not be called")
				return 0, nil
			},
			searchUsersFTSFn: func(_ context.Context, _ db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error) {
				t.Fatal("DB should not be called")
				return nil, nil
			},
			countSearchCodeFn: func(_ context.Context, _ db.CountSearchCodeFTSParams) (int64, error) {
				t.Fatal("DB should not be called")
				return 0, nil
			},
			searchCodeFTSFn: func(_ context.Context, _ db.SearchCodeFTSParams) ([]db.SearchCodeFTSRow, error) {
				t.Fatal("DB should not be called")
				return nil, nil
			},
		}
	}

	// acceptsMock returns a mock that records the query passed to the DB.
	acceptsMock := func() (*mockSearchQuerier, *string) {
		var captured string
		m := &mockSearchQuerier{
			countSearchRepositoriesFn: func(_ context.Context, arg db.CountSearchRepositoriesFTSParams) (int64, error) {
				captured = arg.Query
				return 1, nil
			},
			searchRepositoriesFTSFn: func(_ context.Context, arg db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error) {
				return []db.SearchRepositoriesFTSRow{{ID: 1, OwnerName: "o", Name: "r", IsPublic: true}}, nil
			},
			countSearchIssuesFn: func(_ context.Context, arg db.CountSearchIssuesFTSParams) (int64, error) {
				captured = arg.Query
				return 1, nil
			},
			searchIssuesFTSFn: func(_ context.Context, arg db.SearchIssuesFTSParams) ([]db.SearchIssuesFTSRow, error) {
				return []db.SearchIssuesFTSRow{{ID: 1, RepositoryID: 1, RepositoryName: "r", OwnerName: "o", Number: 1, Title: "t", State: "open"}}, nil
			},
			countSearchUsersFn: func(_ context.Context, q string) (int64, error) {
				captured = q
				return 1, nil
			},
			searchUsersFTSFn: func(_ context.Context, arg db.SearchUsersFTSParams) ([]db.SearchUsersFTSRow, error) {
				return []db.SearchUsersFTSRow{{ID: 1, Username: "alice"}}, nil
			},
			countSearchCodeFn: func(_ context.Context, arg db.CountSearchCodeFTSParams) (int64, error) {
				captured = arg.Query
				return 1, nil
			},
			searchCodeFTSFn: func(_ context.Context, arg db.SearchCodeFTSParams) ([]db.SearchCodeFTSRow, error) {
				return []db.SearchCodeFTSRow{{RepositoryID: 1, RepositoryName: "r", OwnerName: "o", FilePath: "f.go", Snippet: []byte("hello")}}, nil
			},
		}
		return m, &captured
	}

	t.Run("empty string rejected with 422", func(t *testing.T) {
		t.Parallel()
		svc := NewSearchService(rejectsMock(t))
		queries := []string{"", "   ", "\t\n"}
		for _, q := range queries {
			_, err := svc.SearchRepositories(context.Background(), nil, SearchRepositoriesInput{Query: q})
			require.Error(t, err)
			assert.Equal(t, 422, mustSearchAPIError(t, err).Status, "query=%q", q)

			_, err = svc.SearchIssues(context.Background(), nil, SearchIssuesInput{Query: q})
			require.Error(t, err)
			assert.Equal(t, 422, mustSearchAPIError(t, err).Status, "query=%q", q)

			_, err = svc.SearchUsers(context.Background(), SearchUsersInput{Query: q})
			require.Error(t, err)
			assert.Equal(t, 422, mustSearchAPIError(t, err).Status, "query=%q", q)

			_, err = svc.SearchCode(context.Background(), nil, SearchCodeInput{Query: q})
			require.Error(t, err)
			assert.Equal(t, 422, mustSearchAPIError(t, err).Status, "query=%q", q)
		}
	})

	t.Run("multi-word phrase passed through unchanged", func(t *testing.T) {
		t.Parallel()
		phrase := "hello world foo"

		m, captured := acceptsMock()
		svc := NewSearchService(m)
		_, err := svc.SearchRepositories(context.Background(), nil, SearchRepositoriesInput{Query: phrase})
		require.NoError(t, err)
		assert.Equal(t, phrase, *captured)

		m, captured = acceptsMock()
		svc = NewSearchService(m)
		_, err = svc.SearchIssues(context.Background(), nil, SearchIssuesInput{Query: phrase})
		require.NoError(t, err)
		assert.Equal(t, phrase, *captured)

		m, captured = acceptsMock()
		svc = NewSearchService(m)
		_, err = svc.SearchUsers(context.Background(), SearchUsersInput{Query: phrase})
		require.NoError(t, err)
		assert.Equal(t, phrase, *captured)

		m, captured = acceptsMock()
		svc = NewSearchService(m)
		_, err = svc.SearchCode(context.Background(), nil, SearchCodeInput{Query: phrase})
		require.NoError(t, err)
		assert.Equal(t, phrase, *captured)
	})

	t.Run("special characters & | : ! passed through to DB without 500", func(t *testing.T) {
		t.Parallel()
		// websearch_to_tsquery handles these gracefully; the service must not
		// reject them and must pass them to the DB layer verbatim.
		specials := []string{
			"foo & bar",
			"foo | bar",
			"foo:bar",
			"!important",
			"a & b | c !d",
		}
		for _, q := range specials {
			m, captured := acceptsMock()
			svc := NewSearchService(m)
			_, err := svc.SearchRepositories(context.Background(), nil, SearchRepositoriesInput{Query: q})
			require.NoError(t, err, "query=%q", q)
			assert.Equal(t, q, *captured, "query=%q", q)
		}
	})

	t.Run("query exactly at limit (500 chars) is accepted", func(t *testing.T) {
		t.Parallel()
		q := strings.Repeat("a", searchMaxQueryLen)
		m, _ := acceptsMock()
		svc := NewSearchService(m)
		_, err := svc.SearchRepositories(context.Background(), nil, SearchRepositoriesInput{Query: q})
		require.NoError(t, err)
	})

	t.Run("query exceeding 500 chars rejected with 400", func(t *testing.T) {
		t.Parallel()
		long := strings.Repeat("x", searchMaxQueryLen+1)
		svc := NewSearchService(rejectsMock(t))

		_, err := svc.SearchRepositories(context.Background(), nil, SearchRepositoriesInput{Query: long})
		require.Error(t, err)
		assert.Equal(t, 400, mustSearchAPIError(t, err).Status)

		_, err = svc.SearchIssues(context.Background(), nil, SearchIssuesInput{Query: long})
		require.Error(t, err)
		assert.Equal(t, 400, mustSearchAPIError(t, err).Status)

		_, err = svc.SearchUsers(context.Background(), SearchUsersInput{Query: long})
		require.Error(t, err)
		assert.Equal(t, 400, mustSearchAPIError(t, err).Status)

		_, err = svc.SearchCode(context.Background(), nil, SearchCodeInput{Query: long})
		require.Error(t, err)
		assert.Equal(t, 400, mustSearchAPIError(t, err).Status)
	})

	t.Run("snippet XSS characters are HTML-escaped in code results", func(t *testing.T) {
		t.Parallel()
		xssSnippet := `<script>alert("xss")</script>`
		m := &mockSearchQuerier{
			countSearchCodeFn: func(_ context.Context, _ db.CountSearchCodeFTSParams) (int64, error) {
				return 1, nil
			},
			searchCodeFTSFn: func(_ context.Context, _ db.SearchCodeFTSParams) ([]db.SearchCodeFTSRow, error) {
				return []db.SearchCodeFTSRow{
					{RepositoryID: 1, RepositoryName: "r", OwnerName: "o", FilePath: "f.go", Snippet: []byte(xssSnippet)},
				}, nil
			},
		}
		svc := NewSearchService(m)
		result, err := svc.SearchCode(context.Background(), nil, SearchCodeInput{Query: "script"})
		require.NoError(t, err)
		require.Len(t, result.Items, 1)
		assert.NotContains(t, result.Items[0].Snippet, "<script>")
		assert.NotContains(t, result.Items[0].Snippet, "</script>")
		assert.Contains(t, result.Items[0].Snippet, "&lt;script&gt;")
	})

	t.Run("pagination max 100 enforced", func(t *testing.T) {
		t.Parallel()
		// The service must clamp per_page > 100 to exactly 100.
		var capturedSize int32
		m := &mockSearchQuerier{
			countSearchRepositoriesFn: func(_ context.Context, _ db.CountSearchRepositoriesFTSParams) (int64, error) {
				return 1, nil
			},
			searchRepositoriesFTSFn: func(_ context.Context, arg db.SearchRepositoriesFTSParams) ([]db.SearchRepositoriesFTSRow, error) {
				capturedSize = arg.PageSize
				return []db.SearchRepositoriesFTSRow{{ID: 1, OwnerName: "o", Name: "r", IsPublic: true}}, nil
			},
		}
		svc := NewSearchService(m)
		result, err := svc.SearchRepositories(context.Background(), nil, SearchRepositoriesInput{
			Query:   "test",
			PerPage: 9999,
		})
		require.NoError(t, err)
		assert.Equal(t, 100, result.PerPage)
		assert.Equal(t, int32(100), capturedSize)
	})
}

func mustSearchAPIError(t *testing.T, err error) *pkgerrors.APIError {
	t.Helper()

	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected APIError")
	return apiErr
}
