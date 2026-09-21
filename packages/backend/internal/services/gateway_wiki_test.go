package services

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type gatewayWikiCredentials struct{}

func (gatewayWikiCredentials) AuthorizeRelay(_ context.Context, id, token string) (RepoGatewayRelayTarget, error) {
	if id != "gateway" || token != "operator" {
		return RepoGatewayRelayTarget{}, pkgerrors.Unauthorized("invalid gateway credentials")
	}
	return RepoGatewayRelayTarget{UserID: 2, RepositoryID: 42}, nil
}

type gatewayWikiUser struct{}

func (gatewayWikiUser) GetUserByIDNotDeleted(context.Context, int64) (db.User, error) {
	return db.User{ID: 2, Username: "collaborator", IsActive: true}, nil
}

func TestGatewayWikiPublication_PersistsRetriesAndEnforcesCurrentRepoAuthority(t *testing.T) {
	ctx := context.Background()
	pages := make(map[string]db.GetWikiPageBySlugRow)
	permission := "write"
	q := &mockWikiQuerier{
		getRepoByOwnerAndLowerNameFn: func(_ context.Context, input db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			repo := sampleWikiRepository()
			if input.LowerName != "demo" {
				repo.ID = 900
			}
			return repo, nil
		},
		getCollaboratorPermissionForRepoFn: func(context.Context, db.GetCollaboratorPermissionForRepoUserParams) (string, error) {
			return permission, nil
		},
		createWikiPageFn: func(_ context.Context, input db.CreateWikiPageParams) (db.WikiPage, error) {
			if _, found := pages[input.Slug]; found {
				return db.WikiPage{}, &pgconn.PgError{Code: "23505"}
			}
			pages[input.Slug] = db.GetWikiPageBySlugRow{ID: int64(len(pages) + 1), RepositoryID: input.RepositoryID, Slug: input.Slug, Title: input.Title, Body: input.Body}
			return db.WikiPage{ID: int64(len(pages)), RepositoryID: input.RepositoryID, Slug: input.Slug, Title: input.Title, Body: input.Body}, nil
		},
		getWikiPageBySlugFn: func(_ context.Context, input db.GetWikiPageBySlugParams) (db.GetWikiPageBySlugRow, error) {
			if page, found := pages[input.Slug]; found {
				return page, nil
			}
			return db.GetWikiPageBySlugRow{}, pgx.ErrNoRows
		},
	}
	publisher := &GatewayWikiPublisher{gateway: gatewayWikiCredentials{}, users: gatewayWikiUser{}, wiki: NewWikiService(q, nil)}
	input := GatewayWikiPublishInput{Repo: "alice/demo", SourceHead: strings.Repeat("a", 40), Pages: []GatewayWikiPage{{ID: "overview", Title: "Overview", Body: "# Actual repository source index"}}}
	first, err := publisher.Publish(ctx, "gateway", "operator", input)
	require.NoError(t, err)
	require.Len(t, first.Pages, 1)
	retry, err := publisher.Publish(ctx, "gateway", "operator", input)
	require.NoError(t, err)
	require.Equal(t, first, retry)
	require.Len(t, pages, 1, "a lost response must not create duplicate pages")

	input.Pages[0].Body = "different content"
	_, err = publisher.Publish(ctx, "gateway", "operator", input)
	require.Equal(t, 409, apiStatus(t, err))
	require.Equal(t, "# Actual repository source index", pages[first.Pages[0].Slug].Body)
	input.Pages[0].Body = "# Actual repository source index"
	input.Repo = "alice/another"
	_, err = publisher.Publish(ctx, "gateway", "operator", input)
	require.Equal(t, 403, apiStatus(t, err))
	input.Repo = "alice/demo"
	_, err = publisher.Publish(ctx, "gateway", "wrong", input)
	require.Equal(t, 401, apiStatus(t, err))
	permission = "read"
	_, err = publisher.Publish(ctx, "gateway", "operator", input)
	require.Equal(t, 403, apiStatus(t, err), "an existing gateway cannot write after collaborator access is revoked")
	permission = "write"
	input.SourceHead = "main"
	_, err = publisher.Publish(ctx, "gateway", "operator", input)
	require.Equal(t, 400, apiStatus(t, err))
	input.SourceHead = strings.Repeat("b", 40)
	input.Pages = append(input.Pages, input.Pages[0])
	_, err = publisher.Publish(ctx, "gateway", "operator", input)
	require.Equal(t, 400, apiStatus(t, err))
	require.Len(t, pages, 1, "invalid batches must be rejected before any writes")
	input.Pages = []GatewayWikiPage{{ID: "overview", Path: "librarian/alice/demo/root.md", Title: "Overview", Body: "See [[librarian/alice/demo/root.md]]"}}
	linked, err := publisher.Publish(ctx, "gateway", "operator", input)
	require.NoError(t, err)
	require.Equal(t, "See [["+linked.Pages[0].Slug+"]]", pages[linked.Pages[0].Slug].Body)
	_, err = publisher.Publish(ctx, "gateway", "operator", input)
	require.NoError(t, err, "retry must compare the rewritten cloud links")
}
