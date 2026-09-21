package services

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestAlphaAccess_Cov_IsUserWhitelistedBranches(t *testing.T) {
	svc := NewAlphaAccessService(&mockAlphaAccessQuerier{})
	allowed, err := svc.IsUserWhitelisted(context.Background(), nil)
	require.NoError(t, err)
	assert.False(t, allowed)

	allowed, err = svc.IsUserWhitelisted(context.Background(), &db.User{IsAdmin: true})
	require.NoError(t, err)
	assert.True(t, allowed)

	var checked []db.IsWhitelistedIdentityParams
	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		isWhitelistedIdentityFn: func(ctx context.Context, arg db.IsWhitelistedIdentityParams) (bool, error) {
			checked = append(checked, arg)
			return arg.IdentityType == WhitelistIdentityWallet, nil
		},
	})
	user := &db.User{
		Username:      "Alice",
		Email:         pgtype.Text{String: "ALICE@example.COM", Valid: true},
		WalletAddress: pgtype.Text{String: "0x1234567890abcdef1234567890abcdef12345678", Valid: true},
	}
	allowed, err = svc.IsUserWhitelisted(context.Background(), user)
	require.NoError(t, err)
	assert.True(t, allowed)
	require.Len(t, checked, 3)
	assert.Equal(t, "alice", checked[0].LowerIdentityValue)
	assert.Equal(t, "alice@example.com", checked[1].LowerIdentityValue)
	assert.Equal(t, WhitelistIdentityWallet, checked[2].IdentityType)

	svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
		isWhitelistedIdentityFn: func(context.Context, db.IsWhitelistedIdentityParams) (bool, error) {
			return false, assert.AnError
		},
	})
	_, err = svc.IsUserWhitelisted(context.Background(), &db.User{Username: "bob"})
	require.Error(t, err)
	assert.Equal(t, http.StatusInternalServerError, alphaAccessCovStatus(t, err))
}

func TestAlphaAccess_Cov_ListEntriesAndValidationBranches(t *testing.T) {
	now := time.Now().UTC()
	svc := NewAlphaAccessService(&mockAlphaAccessQuerier{
		listWaitlistEntriesFn: func(ctx context.Context, arg db.ListWaitlistEntriesParams) ([]db.AlphaWaitlistEntry, error) {
			assert.Equal(t, int32(200), arg.PageSize)
			assert.Equal(t, int32(200), arg.PageOffset)
			assert.Equal(t, WaitlistStatusApproved, arg.StatusFilter)
			return []db.AlphaWaitlistEntry{{
				ID:         1,
				Email:      "a@example.com",
				Status:     WaitlistStatusApproved,
				Source:     "cli",
				ApprovedAt: pgtype.Timestamptz{Time: now, Valid: true},
				ApprovedBy: pgtype.Int8{Int64: 9, Valid: true},
				CreatedAt:  now,
				UpdatedAt:  now,
			}}, nil
		},
		countWaitlistEntriesFn: func(ctx context.Context, status string) (int64, error) {
			assert.Equal(t, WaitlistStatusApproved, status)
			return 3, nil
		},
		listWhitelistEntriesFn: func(context.Context) ([]db.AlphaWhitelistEntry, error) {
			return []db.AlphaWhitelistEntry{{
				ID:            2,
				IdentityType:  WhitelistIdentityUsername,
				IdentityValue: "alice",
				CreatedBy:     pgtype.Int8{Int64: 7, Valid: true},
				CreatedAt:     now,
				UpdatedAt:     now,
			}}, nil
		},
	})

	waitlist, err := svc.ListWaitlistEntries(context.Background(), ListWaitlistInput{Page: 2, PerPage: 500, Status: " APPROVED "})
	require.NoError(t, err)
	assert.Equal(t, int64(3), waitlist.TotalCount)
	assert.Equal(t, 2, waitlist.Page)
	assert.Equal(t, 200, waitlist.PerPage)
	require.Len(t, waitlist.Items, 1)
	require.NotNil(t, waitlist.Items[0].ApprovedBy)
	assert.Equal(t, int64(9), *waitlist.Items[0].ApprovedBy)

	whitelist, err := svc.ListWhitelistEntries(context.Background())
	require.NoError(t, err)
	require.Len(t, whitelist, 1)
	require.NotNil(t, whitelist[0].CreatedBy)
	assert.Equal(t, int64(7), *whitelist[0].CreatedBy)

	_, err = svc.ListWaitlistEntries(context.Background(), ListWaitlistInput{Status: "bogus"})
	require.Error(t, err)
	assert.Equal(t, http.StatusBadRequest, alphaAccessCovStatus(t, err))
}

func TestAlphaAccess_Cov_AddRemoveApproveErrorBranches(t *testing.T) {
	t.Run("add remove list query errors", func(t *testing.T) {
		svc := NewAlphaAccessService(&mockAlphaAccessQuerier{
			addWhitelistEntryFn: func(context.Context, db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
				return db.AlphaWhitelistEntry{}, assert.AnError
			},
			removeWhitelistEntryFn: func(context.Context, db.RemoveWhitelistEntryParams) (int64, error) {
				return 0, assert.AnError
			},
			listWhitelistEntriesFn: func(context.Context) ([]db.AlphaWhitelistEntry, error) {
				return nil, assert.AnError
			},
		})

		_, err := svc.AddWhitelistEntry(context.Background(), nil, AddWhitelistEntryInput{
			IdentityType:  WhitelistIdentityUsername,
			IdentityValue: "alice",
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusInternalServerError, alphaAccessCovStatus(t, err))

		err = svc.RemoveWhitelistEntry(context.Background(), RemoveWhitelistEntryInput{
			IdentityType:  WhitelistIdentityUsername,
			IdentityValue: "alice",
		})
		require.Error(t, err)
		assert.Equal(t, http.StatusInternalServerError, alphaAccessCovStatus(t, err))

		_, err = svc.ListWhitelistEntries(context.Background())
		require.Error(t, err)
		assert.Equal(t, http.StatusInternalServerError, alphaAccessCovStatus(t, err))
	})

	t.Run("approve already approved preserves approval metadata", func(t *testing.T) {
		approvedAt := time.Now().Add(-time.Hour).UTC()
		svc := NewAlphaAccessService(&mockAlphaAccessQuerier{
			getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
				return db.AlphaWaitlistEntry{
					Email:      "done@example.com",
					Status:     WaitlistStatusApproved,
					ApprovedBy: pgtype.Int8{Int64: 2, Valid: true},
					ApprovedAt: pgtype.Timestamptz{Time: approvedAt, Valid: true},
				}, nil
			},
			addWhitelistEntryFn: func(context.Context, db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
				return db.AlphaWhitelistEntry{}, nil
			},
			approveWaitlistByLowerEmailFn: func(context.Context, db.ApproveWaitlistEntryByLowerEmailParams) (db.AlphaWaitlistEntry, error) {
				return db.AlphaWaitlistEntry{
					Email:      "done@example.com",
					Status:     WaitlistStatusApproved,
					ApprovedBy: pgtype.Int8{Int64: 99, Valid: true},
					ApprovedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
				}, nil
			},
		})

		entry, err := svc.ApproveWaitlistEntry(context.Background(), &db.User{ID: 8}, "done@example.com")
		require.NoError(t, err)
		require.NotNil(t, entry.ApprovedBy)
		assert.Equal(t, int64(2), *entry.ApprovedBy)
		require.NotNil(t, entry.ApprovedAt)
		assert.Equal(t, approvedAt, *entry.ApprovedAt)
	})

	t.Run("approve auth and lookup errors", func(t *testing.T) {
		svc := NewAlphaAccessService(&mockAlphaAccessQuerier{})
		_, err := svc.ApproveWaitlistEntry(context.Background(), nil, "a@example.com")
		require.Error(t, err)
		assert.Equal(t, http.StatusUnauthorized, alphaAccessCovStatus(t, err))

		svc = NewAlphaAccessService(&mockAlphaAccessQuerier{
			getWaitlistEntryByLowerEmailFn: func(context.Context, string) (db.AlphaWaitlistEntry, error) {
				return db.AlphaWaitlistEntry{}, pgx.ErrTxClosed
			},
		})
		_, err = svc.ApproveWaitlistEntry(context.Background(), &db.User{ID: 1}, "a@example.com")
		require.Error(t, err)
		assert.Equal(t, http.StatusInternalServerError, alphaAccessCovStatus(t, err))
	})
}

func alphaAccessCovStatus(t *testing.T, err error) int {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	return apiErr.Status
}
