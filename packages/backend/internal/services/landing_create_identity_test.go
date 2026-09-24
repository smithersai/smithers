package services

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestLandingCreateIdentityDigestIncludesSessionAndOrderedInput(t *testing.T) {
	p := db.CreateLandingRequestParams{Title: "x", TargetBookmark: "main", AgentAuthored: true, AuthorAgentSessionID: uuid.NewString()}
	initial := landingCreateDigest(p, []string{"a", "b"})
	require.Equal(t, initial, landingCreateDigest(p, []string{"a", "b"}))
	require.NotEqual(t, initial, landingCreateDigest(p, []string{"b", "a"}))
	p.AuthorAgentSessionID = uuid.NewString()
	require.NotEqual(t, initial, landingCreateDigest(p, []string{"a", "b"}))
}
func TestLandingCreateIdentityConcurrentReplayAndImmutability(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	userID, repoID := setupTestUserAndRepo(t, pool)
	q := db.New(pool)
	actor, err := q.GetUserByID(ctx, userID)
	require.NoError(t, err)
	repo, err := q.GetRepoByID(ctx, repoID)
	require.NoError(t, err)
	service := NewLandingServiceWithPool(q, &mockLandingRepoHostClient{}, pool)
	input := CreateLandingRequestInput{RequestID: uuid.NewString(), Title: "idempotent", TargetBookmark: "main", ChangeIDs: []string{"native-a", "native-b"}}
	const count = 8
	results := make(chan LandingRequestResponse, count)
	errs := make(chan error, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := service.CreateLandingRequest(ctx, &actor, actor.Username, repo.Name, input)
			results <- r
			errs <- e
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for e := range errs {
		require.NoError(t, e)
	}
	var number int64
	for r := range results {
		require.Equal(t, input.RequestID, r.RequestID)
		if number == 0 {
			number = r.Number
		}
		require.Equal(t, number, r.Number)
	}
	var rows, children int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM landing_requests WHERE repository_id=$1`, repoID).Scan(&rows))
	require.Equal(t, 1, rows)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM landing_request_changes c JOIN landing_requests r ON r.id=c.landing_request_id WHERE r.repository_id=$1`, repoID).Scan(&children))
	require.Equal(t, 2, children)
	_, err = pool.Exec(ctx, `UPDATE landing_requests SET title='edited after create',state='closed' WHERE repository_id=$1`, repoID)
	require.NoError(t, err)
	replay, err := service.CreateLandingRequest(ctx, &actor, actor.Username, repo.Name, input)
	require.NoError(t, err)
	require.Equal(t, number, replay.Number)
	require.Equal(t, "edited after create", replay.Title)
	config := pool.Config()
	config.MaxConns = 1
	config.MinConns = 0
	single, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)
	defer single.Close()
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	replay, err = NewLandingServiceWithPool(db.New(single), &mockLandingRepoHostClient{}, single).CreateLandingRequest(bounded, &actor, actor.Username, repo.Name, input)
	require.NoError(t, err)
	require.Equal(t, number, replay.Number)

	changed := input
	changed.Body = "different"
	_, err = service.CreateLandingRequest(ctx, &actor, actor.Username, repo.Name, changed)
	require.ErrorContains(t, err, "different input")
	_, err = service.CreateLandingRequest(ctx, nil, actor.Username, repo.Name, input)
	require.Error(t, err)
	_, err = pool.Exec(ctx, `UPDATE landing_requests SET request_id=NULL,create_request_hash=NULL WHERE repository_id=$1`, repoID)
	require.ErrorContains(t, err, "immutable")
	_, err = pool.Exec(ctx, `INSERT INTO landing_requests(repository_id,number,title,author_id,target_bookmark,request_id) VALUES ($1,99,'bad',$2,'main',$3)`, repoID, userID, uuid.NewString())
	require.Error(t, err)
	// Legacy creation remains available and independent of request identity.
	input.RequestID = ""
	_, err = service.CreateLandingRequest(ctx, &actor, actor.Username, repo.Name, input)
	require.NoError(t, err)
}
