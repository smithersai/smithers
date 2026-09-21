package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestAlphaAccess_H_IsUserWhitelistedAndInputErrors(t *testing.T) {
	ctx := context.Background()

	allowed, err := NewAlphaAccessService(&mockAlphaAccessQuerier{}).IsUserWhitelisted(ctx, nil)
	require.NoError(t, err)
	assert.False(t, allowed)

	allowed, err = NewAlphaAccessService(&mockAlphaAccessQuerier{}).IsUserWhitelisted(ctx, &db.User{IsAdmin: true})
	require.NoError(t, err)
	assert.True(t, allowed)

	queries := 0
	svc := NewAlphaAccessService(&mockAlphaAccessQuerier{
		isWhitelistedIdentityFn: func(context.Context, db.IsWhitelistedIdentityParams) (bool, error) {
			queries++
			return false, errors.New("db down")
		},
	})
	_, err = svc.IsUserWhitelisted(ctx, &db.User{Username: "alice"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
	assert.Equal(t, 1, queries)

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		isWhitelistedIdentityFn: func(context.Context, db.IsWhitelistedIdentityParams) (bool, error) {
			return false, nil
		},
	})
	allowed, err = svc.IsUserWhitelisted(ctx, &db.User{
		Username:      "",
		Email:         pgtype.Text{String: "nobody@example.com", Valid: true},
		WalletAddress: pgtype.Text{String: "0xABCDEFabcdef1234567890123456789012345678", Valid: true},
	})
	require.NoError(t, err)
	assert.False(t, allowed)

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{})
	for _, input := range []WaitlistJoinInput{
		{Email: "user@example.com", Note: strings.Repeat("n", 2001)},
		{Email: "user@example.com", GithubUsername: strings.Repeat("u", 256)},
		{Email: "user@example.com", GithubAvatarURL: strings.Repeat("a", 2049)},
		{Email: "user@example.com", Source: strings.Repeat("s", 33)},
	} {
		_, err := svc.JoinWaitlist(ctx, input)
		require.Error(t, err)
		assert.Equal(t, 400, apiStatus(t, err))
	}

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		upsertWaitlistEntryFn: func(context.Context, db.UpsertWaitlistEntryParams) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{}, errors.New("insert failed")
		},
	})
	_, err = svc.JoinWaitlist(ctx, WaitlistJoinInput{Email: "user@example.com"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))
}

func TestAlphaAccess_H_ListAddRemoveApproveBranches(t *testing.T) {
	ctx := context.Background()

	svc := NewAlphaAccessService(&mockAlphaAccessQuerier{
		listWaitlistEntriesFn: func(context.Context, db.ListWaitlistEntriesParams) ([]db.AlphaWaitlistEntry, error) {
			return nil, errors.New("list failed")
		},
	})
	_, err := svc.ListWaitlistEntries(ctx, ListWaitlistInput{})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		listWaitlistEntriesFn: func(context.Context, db.ListWaitlistEntriesParams) ([]db.AlphaWaitlistEntry, error) {
			return []db.AlphaWaitlistEntry{{ID: 1, Email: "a@example.com"}}, nil
		},
		countWaitlistEntriesFn: func(context.Context, string) (int64, error) {
			return 0, errors.New("count failed")
		},
	})
	_, err = svc.ListWaitlistEntries(ctx, ListWaitlistInput{Page: -1, PerPage: 999})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		addWhitelistEntryFn: func(context.Context, db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
			return db.AlphaWhitelistEntry{}, errors.New("insert failed")
		},
	})
	_, err = svc.AddWhitelistEntry(ctx, nil, AddWhitelistEntryInput{IdentityType: WhitelistIdentityEmail, IdentityValue: "bad"})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	_, err = svc.AddWhitelistEntry(ctx, nil, AddWhitelistEntryInput{IdentityType: WhitelistIdentityUsername, IdentityValue: "alice"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		removeWhitelistEntryFn: func(context.Context, db.RemoveWhitelistEntryParams) (int64, error) {
			return 0, errors.New("delete failed")
		},
	})
	err = svc.RemoveWhitelistEntry(ctx, RemoveWhitelistEntryInput{IdentityType: WhitelistIdentityUsername, IdentityValue: "alice"})
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	err = svc.RemoveWhitelistEntry(ctx, RemoveWhitelistEntryInput{IdentityType: WhitelistIdentityWallet, IdentityValue: "bad"})
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		removeWhitelistEntryFn: func(context.Context, db.RemoveWhitelistEntryParams) (int64, error) {
			return 1, nil
		},
	})
	require.NoError(t, svc.RemoveWhitelistEntry(ctx, RemoveWhitelistEntryInput{IdentityType: WhitelistIdentityUsername, IdentityValue: "alice"}))

	_, err = NewAlphaAccessService(&mockAlphaAccessQuerier{}).ApproveWaitlistEntry(ctx, nil, "user@example.com")
	require.Error(t, err)
	assert.Equal(t, 401, apiStatus(t, err))

	_, err = NewAlphaAccessService(&mockAlphaAccessQuerier{}).ApproveWaitlistEntry(ctx, &db.User{ID: 5}, "bad-email")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{}, errors.New("load failed")
		},
	})
	_, err = svc.ApproveWaitlistEntry(ctx, &db.User{ID: 5}, "user@example.com")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{Email: "user@example.com", Status: WaitlistStatusPending}, nil
		},
		addWhitelistEntryFn: func(context.Context, db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
			return db.AlphaWhitelistEntry{}, errors.New("whitelist failed")
		},
	})
	_, err = svc.ApproveWaitlistEntry(ctx, &db.User{ID: 5}, "user@example.com")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	existingApprovedAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{
				Email:      "user@example.com",
				Status:     WaitlistStatusApproved,
				ApprovedBy: pgtype.Int8{Int64: 99, Valid: true},
				ApprovedAt: pgtype.Timestamptz{Time: existingApprovedAt, Valid: true},
			}, nil
		},
		addWhitelistEntryFn: func(context.Context, db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
			return db.AlphaWhitelistEntry{}, nil
		},
		approveWaitlistByLowerEmailFn: func(context.Context, db.ApproveWaitlistEntryByLowerEmailParams) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{Email: "user@example.com", Status: WaitlistStatusApproved}, nil
		},
	})
	entry, err := svc.ApproveWaitlistEntry(ctx, &db.User{ID: 5}, "user@example.com")
	require.NoError(t, err)
	require.NotNil(t, entry.ApprovedBy)
	assert.Equal(t, int64(99), *entry.ApprovedBy)
	require.NotNil(t, entry.ApprovedAt)
	assert.Equal(t, existingApprovedAt, *entry.ApprovedAt)

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{Email: "user@example.com", Status: WaitlistStatusPending}, nil
		},
		addWhitelistEntryFn: func(context.Context, db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
			return db.AlphaWhitelistEntry{}, nil
		},
		approveWaitlistByLowerEmailFn: func(context.Context, db.ApproveWaitlistEntryByLowerEmailParams) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{}, errors.New("approve failed")
		},
	})
	_, err = svc.ApproveWaitlistEntry(ctx, &db.User{ID: 5}, "user@example.com")
	require.Error(t, err)
	assert.Equal(t, 500, apiStatus(t, err))

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{}, pgx.ErrNoRows
		},
	})
	_, err = svc.ApproveWaitlistEntry(ctx, &db.User{ID: 5}, "user@example.com")
	require.Error(t, err)
	assert.Equal(t, 404, apiStatus(t, err))
}

func TestAlphaAccess_H_NormalizeIdentityBranches(t *testing.T) {
	for _, tc := range []struct {
		kind  string
		value string
	}{
		{"", "x"},
		{WhitelistIdentityEmail, ""},
		{WhitelistIdentityEmail, "bad-email"},
		{WhitelistIdentityWallet, "0x123"},
		{WhitelistIdentityWallet, "0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"},
		{WhitelistIdentityUsername, strings.Repeat("u", 256)},
		{"unknown", "x"},
	} {
		_, _, _, err := NormalizeWhitelistIdentity(tc.kind, tc.value)
		require.Error(t, err)
		assert.Equal(t, 400, apiStatus(t, err))
	}

	kind, value, lower, err := NormalizeWhitelistIdentity(WhitelistIdentityWallet, "0xABCDEFabcdef1234567890123456789012345678")
	require.NoError(t, err)
	assert.Equal(t, WhitelistIdentityWallet, kind)
	assert.Equal(t, strings.ToLower("0xABCDEFabcdef1234567890123456789012345678"), value)
	assert.Equal(t, value, lower)

	_, _, err = normalizeWaitlistEmail(" ")
	require.Error(t, err)
	assert.Equal(t, 400, apiStatus(t, err))
}
