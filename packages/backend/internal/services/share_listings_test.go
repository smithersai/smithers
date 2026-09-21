package services

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type shareListingEventKey struct {
	listingID string
	userID    int64
	eventType string
}

type fakeShareListingStore struct {
	rows        map[string]db.ShareListing
	cooldowns   map[shareListingEventKey]time.Time
	nextID      int
	createCalls int
}

func newFakeShareListingStore() *fakeShareListingStore {
	return &fakeShareListingStore{
		rows:      make(map[string]db.ShareListing),
		cooldowns: make(map[shareListingEventKey]time.Time),
	}
}

func (f *fakeShareListingStore) CreateShareListing(_ context.Context, arg db.CreateShareListingParams) (db.ShareListing, error) {
	f.createCalls++
	for _, row := range f.rows {
		if !row.UnpublishedAt.Valid && row.Kind == arg.Kind && row.Slug == arg.Slug {
			return db.ShareListing{}, &pgconnUniqueViolation
		}
	}
	f.nextID++
	now := time.Date(2026, 8, 5, 19, 30, f.nextID, 0, time.UTC)
	row := db.ShareListing{
		ID:              fmt.Sprintf("00000000-0000-4000-8000-%012d", f.nextID),
		Kind:            arg.Kind,
		Name:            arg.Name,
		Slug:            arg.Slug,
		Description:     arg.Description,
		OwnerUserID:     arg.OwnerUserID,
		SourceRepoOwner: arg.SourceRepoOwner,
		SourceRepoName:  arg.SourceRepoName,
		SourcePath:      arg.SourcePath,
		ContentSnapshot: arg.ContentSnapshot,
		PublishedAt:     now,
		UpdatedAt:       now,
	}
	f.rows[row.ID] = row
	return row, nil
}

// pgconnUniqueViolation is a reusable PostgreSQL unique-violation error.
var pgconnUniqueViolation = pgconn.PgError{Code: "23505"}

func (f *fakeShareListingStore) GetLiveShareListing(_ context.Context, id string) (db.ShareListing, error) {
	row, ok := f.rows[id]
	if !ok || row.UnpublishedAt.Valid {
		return db.ShareListing{}, pgx.ErrNoRows
	}
	return row, nil
}

func (f *fakeShareListingStore) GetShareListingAnyState(_ context.Context, id string) (db.ShareListing, error) {
	row, ok := f.rows[id]
	if !ok {
		return db.ShareListing{}, pgx.ErrNoRows
	}
	return row, nil
}

func (f *fakeShareListingStore) liveRows(kind, q pgtype.Text) []db.ShareListing {
	rows := make([]db.ShareListing, 0, len(f.rows))
	for _, row := range f.rows {
		if row.UnpublishedAt.Valid || (kind.Valid && row.Kind != kind.String) {
			continue
		}
		if q.Valid {
			haystack := strings.ToLower(row.Name + "\n" + row.Slug + "\n" + row.Description)
			if !strings.Contains(haystack, strings.ToLower(strings.ReplaceAll(q.String, `\`, ""))) {
				continue
			}
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].PublishedAt.After(rows[j].PublishedAt) })
	return rows
}

func (f *fakeShareListingStore) ListLiveShareListings(_ context.Context, arg db.ListLiveShareListingsParams) ([]db.ShareListing, error) {
	rows := f.liveRows(arg.Kind, arg.Q)
	start := int(arg.ResultOffset)
	if start >= len(rows) {
		return []db.ShareListing{}, nil
	}
	end := start + int(arg.ResultLimit)
	if end > len(rows) {
		end = len(rows)
	}
	return rows[start:end], nil
}

func (f *fakeShareListingStore) CountLiveShareListings(_ context.Context, arg db.CountLiveShareListingsParams) (int64, error) {
	return int64(len(f.liveRows(arg.Kind, arg.Q))), nil
}

func (f *fakeShareListingStore) ListShareListingsForOwner(_ context.Context, arg db.ListShareListingsForOwnerParams) ([]db.ShareListing, error) {
	rows := make([]db.ShareListing, 0)
	for _, row := range f.rows {
		if row.OwnerUserID == arg.OwnerUserID && !row.UnpublishedAt.Valid {
			rows = append(rows, row)
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].PublishedAt.After(rows[j].PublishedAt) })
	start := int(arg.ResultOffset)
	if start >= len(rows) {
		return []db.ShareListing{}, nil
	}
	end := start + int(arg.ResultLimit)
	if end > len(rows) {
		end = len(rows)
	}
	return rows[start:end], nil
}

func (f *fakeShareListingStore) CountShareListingsForOwner(_ context.Context, ownerUserID int64) (int64, error) {
	var count int64
	for _, row := range f.rows {
		if row.OwnerUserID == ownerUserID && !row.UnpublishedAt.Valid {
			count++
		}
	}
	return count, nil
}

func (f *fakeShareListingStore) UnpublishShareListing(_ context.Context, arg db.UnpublishShareListingParams) (db.ShareListing, error) {
	row, ok := f.rows[arg.ID]
	if !ok || row.OwnerUserID != arg.OwnerUserID || row.UnpublishedAt.Valid {
		return db.ShareListing{}, pgx.ErrNoRows
	}
	row.UnpublishedAt = pgtype.Timestamptz{Time: row.UpdatedAt.Add(time.Minute), Valid: true}
	row.UpdatedAt = row.UnpublishedAt.Time
	f.rows[row.ID] = row
	return row, nil
}

func (f *fakeShareListingStore) RecordShareListingEvent(_ context.Context, arg db.RecordShareListingEventParams) (db.RecordShareListingEventRow, error) {
	row, ok := f.rows[arg.ListingID]
	if !ok || row.UnpublishedAt.Valid {
		return db.RecordShareListingEventRow{ListingFound: false}, nil
	}
	key := shareListingEventKey{listingID: arg.ListingID, userID: arg.UserID, eventType: arg.EventType}
	last, seen := f.cooldowns[key]
	counted := !seen || !last.After(arg.DedupeCutoff)
	if counted {
		f.cooldowns[key] = arg.CountedAt
		switch arg.EventType {
		case ShareListingEventInstall:
			row.InstallCount++
		case ShareListingEventRun:
			row.UseCount++
		}
		row.UpdatedAt = arg.CountedAt
		f.rows[row.ID] = row
	}
	return db.RecordShareListingEventRow{
		ListingFound: true,
		Counted:      counted,
		InstallCount: row.InstallCount,
		UseCount:     row.UseCount,
	}, nil
}

func validShareListingInput() PublishShareListingInput {
	return PublishShareListingInput{
		Kind:            " workflow ",
		Name:            " Release Triage ",
		Description:     " Routes new release failures ",
		SourceRepoOwner: " smithers-ai ",
		SourceRepoName:  " workflows ",
		SourcePath:      " .smithers/workflows/release.tsx ",
		ContentSnapshot: `export default <Workflow name="release-triage" />`,
	}
}

func requireShareListingAPIStatus(t *testing.T, err error, status int) *pkgerrors.APIError {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.True(t, errors.As(err, &apiErr), "expected APIError, got %v", err)
	require.Equal(t, status, apiErr.Status)
	return apiErr
}

func TestShareListingService_PublishUnpublishRoundTripAndOwnership(t *testing.T) {
	store := newFakeShareListingStore()
	svc := NewShareListingService(store)
	ctx := context.Background()

	listing, err := svc.Publish(ctx, 41, validShareListingInput())
	require.NoError(t, err)
	assert.Equal(t, "workflow", listing.Kind)
	assert.Equal(t, "Release Triage", listing.Name)
	assert.Equal(t, "release-triage", listing.Slug)
	assert.Equal(t, int64(41), listing.OwnerUserID)
	assert.Equal(t, `export default <Workflow name="release-triage" />`, listing.ContentSnapshot)

	page, err := svc.List(ctx, ShareListingQuery{})
	require.NoError(t, err)
	require.Len(t, page.Listings, 1)
	assert.Equal(t, int64(1), page.Total)

	err = svc.Unpublish(ctx, 99, listing.ID)
	requireShareListingAPIStatus(t, err, 403)
	_, err = svc.Get(ctx, listing.ID)
	require.NoError(t, err, "a stranger's failed DELETE must leave the listing public")

	require.NoError(t, svc.Unpublish(ctx, 41, listing.ID))
	_, err = svc.Get(ctx, listing.ID)
	requireShareListingAPIStatus(t, err, 404)
	page, err = svc.List(ctx, ShareListingQuery{})
	require.NoError(t, err)
	assert.Empty(t, page.Listings)
	assert.Zero(t, page.Total)
	require.NoError(t, svc.Unpublish(ctx, 41, listing.ID), "owner unpublish is idempotent")
}

func TestShareListingService_EventsIncrementAndDeduplicate(t *testing.T) {
	store := newFakeShareListingStore()
	now := time.Date(2026, 8, 5, 20, 0, 0, 0, time.UTC)
	svc := NewShareListingService(store, WithShareListingClock(func() time.Time { return now }))
	ctx := context.Background()
	listing, err := svc.Publish(ctx, 41, validShareListingInput())
	require.NoError(t, err)

	install, err := svc.RecordEvent(ctx, 7, listing.ID, "install")
	require.NoError(t, err)
	assert.True(t, install.Counted)
	assert.Equal(t, int64(1), install.InstallCount)
	assert.Zero(t, install.UseCount)

	repeat, err := svc.RecordEvent(ctx, 7, listing.ID, "install")
	require.NoError(t, err)
	assert.False(t, repeat.Counted)
	assert.Equal(t, int64(1), repeat.InstallCount)

	run, err := svc.RecordEvent(ctx, 7, listing.ID, "run")
	require.NoError(t, err)
	assert.True(t, run.Counted)
	assert.Equal(t, int64(1), run.UseCount)

	otherUser, err := svc.RecordEvent(ctx, 8, listing.ID, "install")
	require.NoError(t, err)
	assert.True(t, otherUser.Counted)
	assert.Equal(t, int64(2), otherUser.InstallCount)

	now = now.Add(2 * time.Minute)
	laterRun, err := svc.RecordEvent(ctx, 7, listing.ID, "run")
	require.NoError(t, err)
	assert.True(t, laterRun.Counted)
	assert.Equal(t, int64(2), laterRun.UseCount)

	require.NoError(t, svc.Unpublish(ctx, 41, listing.ID))
	_, err = svc.RecordEvent(ctx, 7, listing.ID, "run")
	requireShareListingAPIStatus(t, err, 404)
}

func TestShareListingService_RejectsCredentialMaterialBeforeStorage(t *testing.T) {
	tests := map[string]string{
		"bearer literal":  `headers: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456" }`,
		"api key literal": `api_key: "u9N4mK8pR2xV7qL5cB3jH6sT1wZ0dF4a"`,
		"token literal":   `token = "Ab9zY7xW6vU5tS4rQ3pO2nM1"`,
		"pem block":       "-----BEGIN " + "PRIVATE KEY-----\nnot-allowed\n-----END PRIVATE KEY-----",
	}

	for name, snapshot := range tests {
		t.Run(name, func(t *testing.T) {
			store := newFakeShareListingStore()
			svc := NewShareListingService(store)
			input := validShareListingInput()
			input.ContentSnapshot = snapshot

			_, err := svc.Publish(context.Background(), 41, input)
			apiErr := requireShareListingAPIStatus(t, err, 400)
			assert.Equal(t, ShareListingSecretDetectedCode, apiErr.Code)
			assert.Contains(t, apiErr.Message, "consumers supply their own credentials")
			assert.NotContains(t, apiErr.Message, snapshot)
			assert.Zero(t, store.createCalls)
		})
	}
}

func TestShareListingService_AllowsCredentialReferences(t *testing.T) {
	store := newFakeShareListingStore()
	input := validShareListingInput()
	input.ContentSnapshot = `
const token = process.env.GITHUB_TOKEN
headers: { Authorization: "Bearer ${SLACK_TOKEN}" }
apiKey: "your-api-key"
secret: connectors.github.token
`

	listing, err := NewShareListingService(store).Publish(context.Background(), 41, input)
	require.NoError(t, err)
	assert.Equal(t, input.ContentSnapshot, listing.ContentSnapshot)
	assert.Equal(t, 1, store.createCalls)
}
