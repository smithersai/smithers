package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fixedRepoPlacement struct {
	storageSetID string
	err          error
	seenID       int64
}

func (p *fixedRepoPlacement) StorageSetForRepository(_ context.Context, id int64) (string, error) {
	p.seenID = id
	return p.storageSetID, p.err
}

type stubStorageSetQuerier struct {
	repo db.Repository
	err  error
}

func (s *stubStorageSetQuerier) GetRepoByOwnerAndLowerName(_ context.Context, _ db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
	if s.err != nil {
		return db.Repository{}, s.err
	}
	return s.repo, nil
}

func TestDBStorageSetResolverResolveURL_UsesStorageSetTemplate(t *testing.T) {
	t.Parallel()

	resolver := NewDBStorageSetResolver(&stubStorageSetQuerier{
		repo: db.Repository{ID: 42},
	}, "http://smithers-repo-host-%s:8080", &fixedRepoPlacement{storageSetID: "s1"})

	got, err := resolver.ResolveURL(context.Background(), "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, "http://smithers-repo-host-s1:8080", got)
}

func TestDBStorageSetResolverResolveURL_AllowsStaticBaseURL(t *testing.T) {
	t.Parallel()

	resolver := NewDBStorageSetResolver(&stubStorageSetQuerier{
		repo: db.Repository{ID: 42},
	}, "http://repo-host:8080", &fixedRepoPlacement{storageSetID: "s1"})

	got, err := resolver.ResolveURL(context.Background(), "alice", "demo")
	require.NoError(t, err)
	assert.Equal(t, "http://repo-host:8080", got)
}

func TestDBStorageSetResolverResolveURL_NotFound(t *testing.T) {
	t.Parallel()

	resolver := NewDBStorageSetResolver(&stubStorageSetQuerier{err: pgx.ErrNoRows}, "http://repo-host:8080")

	_, err := resolver.ResolveURL(context.Background(), "alice", "demo")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "repository alice/demo not found")
}

func TestBuildStorageSetResolverTemplate_UsesActiveStorageSetHostname(t *testing.T) {
	t.Parallel()

	got := BuildStorageSetResolverTemplate("http://smithers-repo-host-s1:8080", "s1")

	assert.Equal(t, "http://smithers-repo-host-%s:8080", got)
}

func TestBuildStorageSetResolverTemplate_UsesActiveStorageSetFQDN(t *testing.T) {
	t.Parallel()

	got := BuildStorageSetResolverTemplate(
		"http://smithers-repo-host-s1.smithers.svc.cluster.local:8080",
		"s1",
	)

	assert.Equal(t, "http://smithers-repo-host-%s.smithers.svc.cluster.local:8080", got)
}

func TestBuildStorageSetResolverTemplate_KeepsStaticURLWhenActiveStorageSetDoesNotMatch(t *testing.T) {
	t.Parallel()

	got := BuildStorageSetResolverTemplate("http://repo-host:8080", "s1")

	assert.Equal(t, "http://repo-host:8080", got)
}
