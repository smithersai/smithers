package db

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func createShareListingFixture(t *testing.T, q *Queries, ownerUserID int64) ShareListing {
	t.Helper()
	listing, err := q.CreateShareListing(context.Background(), CreateShareListingParams{
		Kind:            "workflow",
		Name:            "Release Triage",
		Slug:            "release-triage",
		Description:     "Routes release failures",
		OwnerUserID:     ownerUserID,
		SourceRepoOwner: "smithers-ai",
		SourceRepoName:  "workflows",
		SourcePath:      ".smithers/workflows/release.tsx",
		ContentSnapshot: `export default <Workflow name="release-triage" />`,
	})
	require.NoError(t, err)
	return listing
}

func TestShareListingsQueries_PublishEventsAndUnpublishRoundTrip(t *testing.T) {
	q, tx := newQueries(t)
	ownerID := mustCreateUser(t, tx, uniqueTestUsername(t))
	consumerOneID := mustCreateUser(t, tx, uniqueTestUsername(t))
	consumerTwoID := mustCreateUser(t, tx, uniqueTestUsername(t))
	ctx := context.Background()

	listing := createShareListingFixture(t, q, ownerID)
	assert.Equal(t, int64(0), listing.InstallCount)
	assert.Equal(t, int64(0), listing.UseCount)
	assert.Equal(t, `export default <Workflow name="release-triage" />`, listing.ContentSnapshot)

	total, err := q.CountLiveShareListings(ctx, CountLiveShareListingsParams{})
	require.NoError(t, err)
	assert.Equal(t, int64(1), total)
	public, err := q.ListLiveShareListings(ctx, ListLiveShareListingsParams{
		Kind: pgtype.Text{String: "workflow", Valid: true}, ResultLimit: 25,
	})
	require.NoError(t, err)
	require.Len(t, public, 1)
	assert.Equal(t, listing.ContentSnapshot, public[0].ContentSnapshot)

	now := time.Date(2026, 8, 5, 21, 0, 0, 0, time.UTC)
	record := func(userID int64, eventType string, at time.Time, cooldown time.Duration) RecordShareListingEventRow {
		t.Helper()
		row, recordErr := q.RecordShareListingEvent(ctx, RecordShareListingEventParams{
			ListingID: listing.ID, UserID: userID, EventType: eventType,
			CountedAt: at, DedupeCutoff: at.Add(-cooldown),
		})
		require.NoError(t, recordErr)
		return row
	}

	firstInstall := record(consumerOneID, "install", now, 24*time.Hour)
	assert.True(t, firstInstall.ListingFound)
	assert.True(t, firstInstall.Counted)
	assert.Equal(t, int64(1), firstInstall.InstallCount)

	repeatedInstall := record(consumerOneID, "install", now.Add(time.Minute), 24*time.Hour)
	assert.False(t, repeatedInstall.Counted)
	assert.Equal(t, int64(1), repeatedInstall.InstallCount)

	otherInstall := record(consumerTwoID, "install", now.Add(time.Minute), 24*time.Hour)
	assert.True(t, otherInstall.Counted)
	assert.Equal(t, int64(2), otherInstall.InstallCount)

	firstRun := record(consumerOneID, "run", now, time.Minute)
	assert.True(t, firstRun.Counted)
	assert.Equal(t, int64(1), firstRun.UseCount)
	laterRun := record(consumerOneID, "run", now.Add(2*time.Minute), time.Minute)
	assert.True(t, laterRun.Counted)
	assert.Equal(t, int64(2), laterRun.UseCount)

	detail, err := q.GetLiveShareListing(ctx, listing.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), detail.InstallCount)
	assert.Equal(t, int64(2), detail.UseCount)

	_, err = q.UnpublishShareListing(ctx, UnpublishShareListingParams{ID: listing.ID, OwnerUserID: consumerOneID})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = q.GetLiveShareListing(ctx, listing.ID)
	require.NoError(t, err, "a stranger's failed unpublish must not hide the listing")

	_, err = q.UnpublishShareListing(ctx, UnpublishShareListingParams{ID: listing.ID, OwnerUserID: ownerID})
	require.NoError(t, err)
	_, err = q.GetLiveShareListing(ctx, listing.ID)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	total, err = q.CountLiveShareListings(ctx, CountLiveShareListingsParams{})
	require.NoError(t, err)
	assert.Zero(t, total)

	afterUnpublish := record(consumerOneID, "run", now.Add(4*time.Minute), time.Minute)
	assert.False(t, afterUnpublish.ListingFound)
	assert.False(t, afterUnpublish.Counted)
}

func TestShareListingsQueries_ConcurrentDuplicateEventCountsOnce(t *testing.T) {
	ctx := context.Background()
	q := New(sharedPool)
	ownerID := mustCreateUser(t, sharedPool, uniqueTestUsername(t))
	consumerID := mustCreateUser(t, sharedPool, uniqueTestUsername(t))
	t.Cleanup(func() {
		_, _ = sharedPool.Exec(context.Background(), `DELETE FROM users WHERE id IN ($1, $2)`, ownerID, consumerID)
	})
	listing := createShareListingFixture(t, q, ownerID)

	const attempts = 12
	now := time.Date(2026, 8, 5, 21, 30, 0, 0, time.UTC)
	results := make(chan RecordShareListingEventRow, attempts)
	errs := make(chan error, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			row, err := q.RecordShareListingEvent(ctx, RecordShareListingEventParams{
				ListingID: listing.ID, UserID: consumerID, EventType: "run",
				CountedAt: now, DedupeCutoff: now.Add(-time.Minute),
			})
			if err != nil {
				errs <- err
				return
			}
			results <- row
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}

	counted := 0
	for row := range results {
		assert.True(t, row.ListingFound)
		if row.Counted {
			counted++
		}
	}
	assert.Equal(t, 1, counted)
	detail, err := q.GetLiveShareListing(ctx, listing.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), detail.UseCount)
}
