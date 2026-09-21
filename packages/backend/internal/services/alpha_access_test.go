package services

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockAlphaAccessQuerier struct {
	addWhitelistEntryFn            func(ctx context.Context, arg db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error)
	removeWhitelistEntryFn         func(ctx context.Context, arg db.RemoveWhitelistEntryParams) (int64, error)
	listWhitelistEntriesFn         func(ctx context.Context) ([]db.AlphaWhitelistEntry, error)
	isWhitelistedIdentityFn        func(ctx context.Context, arg db.IsWhitelistedIdentityParams) (bool, error)
	upsertWaitlistEntryFn          func(ctx context.Context, arg db.UpsertWaitlistEntryParams) (db.AlphaWaitlistEntry, error)
	getWaitlistEntryByLowerEmailFn func(ctx context.Context, lowerEmail string) (db.AlphaWaitlistEntry, error)
	listWaitlistEntriesFn          func(ctx context.Context, arg db.ListWaitlistEntriesParams) ([]db.AlphaWaitlistEntry, error)
	countWaitlistEntriesFn         func(ctx context.Context, statusFilter string) (int64, error)
	approveWaitlistByLowerEmailFn  func(ctx context.Context, arg db.ApproveWaitlistEntryByLowerEmailParams) (db.AlphaWaitlistEntry, error)
}

func (m *mockAlphaAccessQuerier) AddWhitelistEntry(ctx context.Context, arg db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
	return m.addWhitelistEntryFn(ctx, arg)
}

func (m *mockAlphaAccessQuerier) RemoveWhitelistEntry(ctx context.Context, arg db.RemoveWhitelistEntryParams) (int64, error) {
	return m.removeWhitelistEntryFn(ctx, arg)
}

func (m *mockAlphaAccessQuerier) ListWhitelistEntries(ctx context.Context) ([]db.AlphaWhitelistEntry, error) {
	return m.listWhitelistEntriesFn(ctx)
}

func (m *mockAlphaAccessQuerier) IsWhitelistedIdentity(ctx context.Context, arg db.IsWhitelistedIdentityParams) (bool, error) {
	return m.isWhitelistedIdentityFn(ctx, arg)
}

func (m *mockAlphaAccessQuerier) UpsertWaitlistEntry(ctx context.Context, arg db.UpsertWaitlistEntryParams) (db.AlphaWaitlistEntry, error) {
	return m.upsertWaitlistEntryFn(ctx, arg)
}

func (m *mockAlphaAccessQuerier) GetWaitlistEntryByLowerEmail(ctx context.Context, lowerEmail string) (db.AlphaWaitlistEntry, error) {
	return m.getWaitlistEntryByLowerEmailFn(ctx, lowerEmail)
}

func (m *mockAlphaAccessQuerier) ListWaitlistEntries(ctx context.Context, arg db.ListWaitlistEntriesParams) ([]db.AlphaWaitlistEntry, error) {
	return m.listWaitlistEntriesFn(ctx, arg)
}

func (m *mockAlphaAccessQuerier) CountWaitlistEntries(ctx context.Context, statusFilter string) (int64, error) {
	return m.countWaitlistEntriesFn(ctx, statusFilter)
}

func (m *mockAlphaAccessQuerier) ApproveWaitlistEntryByLowerEmail(ctx context.Context, arg db.ApproveWaitlistEntryByLowerEmailParams) (db.AlphaWaitlistEntry, error) {
	return m.approveWaitlistByLowerEmailFn(ctx, arg)
}

func TestAlphaAccessService_JoinWaitlist(t *testing.T) {
	t.Parallel()

	svc := NewAlphaAccessService(&mockAlphaAccessQuerier{
		upsertWaitlistEntryFn: func(ctx context.Context, arg db.UpsertWaitlistEntryParams) (db.AlphaWaitlistEntry, error) {
			require.Equal(t, "someone@example.com", arg.Email)
			require.Equal(t, "someone@example.com", arg.LowerEmail)
			require.Equal(t, "octocat", arg.GithubUsername)
			require.Equal(t, "https://avatars.example/octocat.png", arg.GithubAvatarUrl)
			require.Equal(t, "cli", arg.Source)
			return db.AlphaWaitlistEntry{
				ID:              11,
				Email:           arg.Email,
				LowerEmail:      arg.LowerEmail,
				GithubUsername:  arg.GithubUsername,
				GithubAvatarUrl: arg.GithubAvatarUrl,
				Note:            arg.Note,
				Status:          WaitlistStatusPending,
				Source:          arg.Source,
				CreatedAt:       time.Now().UTC(),
				UpdatedAt:       time.Now().UTC(),
			}, nil
		},
	})

	entry, err := svc.JoinWaitlist(context.Background(), WaitlistJoinInput{
		Email:           "someone@example.com",
		GithubUsername:  "octocat",
		GithubAvatarURL: "https://avatars.example/octocat.png",
		Note:            "please invite me",
		Source:          "cli",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(11), entry.ID)
	assert.Equal(t, "someone@example.com", entry.Email)
	assert.Equal(t, "octocat", entry.GithubUsername)
	assert.Equal(t, "https://avatars.example/octocat.png", entry.GithubAvatarURL)
	assert.Equal(t, WaitlistStatusPending, entry.Status)
}

func TestAlphaAccessService_JoinWaitlist_RejectsInvalidEmail(t *testing.T) {
	t.Parallel()

	svc := NewAlphaAccessService(&mockAlphaAccessQuerier{})
	_, err := svc.JoinWaitlist(context.Background(), WaitlistJoinInput{Email: "bad-email"})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid email")
}

func TestAlphaAccessService_AddWhitelistEntry_NormalizesEmail(t *testing.T) {
	t.Parallel()

	svc := NewAlphaAccessService(&mockAlphaAccessQuerier{
		addWhitelistEntryFn: func(ctx context.Context, arg db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
			assert.Equal(t, WhitelistIdentityEmail, arg.IdentityType)
			assert.Equal(t, "alice@example.com", arg.IdentityValue)
			assert.Equal(t, "alice@example.com", arg.LowerIdentityValue)
			assert.True(t, arg.CreatedBy.Valid)
			assert.Equal(t, int64(42), arg.CreatedBy.Int64)
			return db.AlphaWhitelistEntry{
				ID:                 7,
				IdentityType:       arg.IdentityType,
				IdentityValue:      arg.IdentityValue,
				LowerIdentityValue: arg.LowerIdentityValue,
				CreatedBy:          arg.CreatedBy,
				CreatedAt:          time.Now().UTC(),
				UpdatedAt:          time.Now().UTC(),
			}, nil
		},
	})

	entry, err := svc.AddWhitelistEntry(context.Background(), &db.User{ID: 42}, AddWhitelistEntryInput{
		IdentityType:  WhitelistIdentityEmail,
		IdentityValue: "Alice@Example.com",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(7), entry.ID)
	assert.Equal(t, "alice@example.com", entry.IdentityValue)
	require.NotNil(t, entry.CreatedBy)
	assert.Equal(t, int64(42), *entry.CreatedBy)
}

func TestAlphaAccessService_RemoveWhitelistEntry_NotFound(t *testing.T) {
	t.Parallel()

	svc := NewAlphaAccessService(&mockAlphaAccessQuerier{
		removeWhitelistEntryFn: func(ctx context.Context, arg db.RemoveWhitelistEntryParams) (int64, error) {
			return 0, nil
		},
	})

	err := svc.RemoveWhitelistEntry(context.Background(), RemoveWhitelistEntryInput{
		IdentityType:  WhitelistIdentityUsername,
		IdentityValue: "alice",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestAlphaAccessService_ApproveWaitlistEntry(t *testing.T) {
	t.Parallel()

	approvedAt := time.Now().UTC()
	svc := NewAlphaAccessService(&mockAlphaAccessQuerier{
		getWaitlistEntryByLowerEmailFn: func(ctx context.Context, lowerEmail string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{
				ID:         99,
				Email:      "new-user@example.com",
				LowerEmail: lowerEmail,
				Status:     WaitlistStatusPending,
			}, nil
		},
		addWhitelistEntryFn: func(ctx context.Context, arg db.AddWhitelistEntryParams) (db.AlphaWhitelistEntry, error) {
			return db.AlphaWhitelistEntry{
				ID:                 10,
				IdentityType:       arg.IdentityType,
				IdentityValue:      arg.IdentityValue,
				LowerIdentityValue: arg.LowerIdentityValue,
				CreatedBy:          arg.CreatedBy,
			}, nil
		},
		approveWaitlistByLowerEmailFn: func(ctx context.Context, arg db.ApproveWaitlistEntryByLowerEmailParams) (db.AlphaWaitlistEntry, error) {
			assert.True(t, arg.ApprovedBy.Valid)
			assert.Equal(t, int64(1), arg.ApprovedBy.Int64)
			return db.AlphaWaitlistEntry{
				ID:         99,
				Email:      "new-user@example.com",
				LowerEmail: arg.LowerEmail,
				Status:     WaitlistStatusApproved,
				ApprovedBy: arg.ApprovedBy,
				ApprovedAt: pgtype.Timestamptz{Time: approvedAt, Valid: true},
			}, nil
		},
	})

	entry, err := svc.ApproveWaitlistEntry(context.Background(), &db.User{ID: 1}, "new-user@example.com")
	require.NoError(t, err)
	assert.Equal(t, WaitlistStatusApproved, entry.Status)
	require.NotNil(t, entry.ApprovedBy)
	assert.Equal(t, int64(1), *entry.ApprovedBy)
	require.NotNil(t, entry.ApprovedAt)
	assert.WithinDuration(t, approvedAt, *entry.ApprovedAt, time.Second)
}

func TestAlphaAccessService_ApproveWaitlistEntry_NotFound(t *testing.T) {
	t.Parallel()

	svc := NewAlphaAccessService(&mockAlphaAccessQuerier{
		getWaitlistEntryByLowerEmailFn: func(ctx context.Context, lowerEmail string) (db.AlphaWaitlistEntry, error) {
			return db.AlphaWaitlistEntry{}, pgx.ErrNoRows
		},
	})

	_, err := svc.ApproveWaitlistEntry(context.Background(), &db.User{ID: 2}, "missing@example.com")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestAlphaAccessService_ApproveWaitlistEntry_RollsBackWhitelistWhenApprovalFails(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()
	queries := db.New(pool)
	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("approval-rollback-%d@example.com", suffix)
	lowerEmail := strings.ToLower(email)

	var actorID int64
	err := pool.QueryRow(ctx, `
		INSERT INTO users (username, lower_username, email, lower_email, display_name)
		VALUES ($1, $1, $2, $2, $1)
		RETURNING id
	`, fmt.Sprintf("alpha-approver-%d", suffix), fmt.Sprintf("alpha-approver-%d@example.com", suffix)).Scan(&actorID)
	require.NoError(t, err)

	_, err = queries.UpsertWaitlistEntry(ctx, db.UpsertWaitlistEntryParams{
		Email:      email,
		LowerEmail: lowerEmail,
		Source:     "test",
	})
	require.NoError(t, err)

	fnName := fmt.Sprintf("fail_alpha_waitlist_update_%d", suffix)
	triggerName := fmt.Sprintf("trg_fail_alpha_waitlist_update_%d", suffix)
	_, err = pool.Exec(ctx, fmt.Sprintf(`
		CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.lower_email = %s THEN
				RAISE EXCEPTION 'forced waitlist approval failure';
			END IF;
			RETURN NEW;
		END;
		$$;
		CREATE TRIGGER %s
		BEFORE UPDATE ON alpha_waitlist_entries
		FOR EACH ROW EXECUTE FUNCTION %s();
	`, fnName, quoteSQLLiteral(lowerEmail), triggerName, fnName))
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), fmt.Sprintf("DROP TRIGGER IF EXISTS %s ON alpha_waitlist_entries", triggerName))
		_, _ = pool.Exec(context.Background(), fmt.Sprintf("DROP FUNCTION IF EXISTS %s()", fnName))
	})

	svc := NewAlphaAccessService(queries)
	_, err = svc.ApproveWaitlistEntry(ctx, &db.User{ID: actorID}, email)
	require.Error(t, err)

	allowed, err := queries.IsWhitelistedIdentity(ctx, db.IsWhitelistedIdentityParams{
		IdentityType:       WhitelistIdentityEmail,
		LowerIdentityValue: lowerEmail,
	})
	require.NoError(t, err)
	assert.False(t, allowed, "failed approval must not leave a committed whitelist entry")

	waitlist, err := queries.GetWaitlistEntryByLowerEmail(ctx, lowerEmail)
	require.NoError(t, err)
	assert.Equal(t, WaitlistStatusPending, waitlist.Status)
}

func quoteSQLLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}
