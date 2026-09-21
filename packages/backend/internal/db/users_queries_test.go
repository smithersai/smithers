package db

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateUser(t *testing.T) {
	q, _ := newQueries(t)

	user, err := q.CreateUser(context.Background(), CreateUserParams{
		Username:      "query-user",
		LowerUsername: "query-user",
		Email:         pgtype.Text{String: "query-user@example.com", Valid: true},
		LowerEmail:    pgtype.Text{String: "query-user@example.com", Valid: true},
		DisplayName:   "Query User",
	})
	require.NoError(t, err)
	assert.Equal(t, "query-user", user.Username)
	assert.True(t, user.IsActive)
}

func TestGetAuthInfoByTokenHash_ReturnsUserAndTokenScopes(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "token-user")

	rawToken := "smithers_0123456789abcdef0123456789abcdef01234567"
	hash := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(hash[:])

	mustExec(
		t,
		pool,
		`INSERT INTO access_tokens (user_id, name, token_hash, token_last_eight, scopes)
		 VALUES ($1, 'token', $2, '01234567', 'read:repository')`,
		userID,
		tokenHash,
	)

	authInfo, err := q.GetAuthInfoByTokenHash(context.Background(), tokenHash)
	require.NoError(t, err)
	assert.Equal(t, userID, authInfo.ID)
	assert.Equal(t, "token-user", authInfo.Username)
	assert.NotZero(t, authInfo.TokenID)
	assert.Equal(t, "read:repository", authInfo.TokenScopes)
}

func TestGetAuthInfoByTokenHash_InactiveUserReturnsNoRows(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "inactive-token-user")

	mustExec(
		t,
		pool,
		`UPDATE users SET is_active = false WHERE id = $1`,
		userID,
	)

	rawToken := "smithers_89abcdef0123456789abcdef0123456789abcdef"
	hash := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(hash[:])

	mustExec(
		t,
		pool,
		`INSERT INTO access_tokens (user_id, name, token_hash, token_last_eight, scopes)
			 VALUES ($1, 'inactive-token', $2, '89abcdef', 'read:repository')`,
		userID,
		tokenHash,
	)

	_, err := q.GetAuthInfoByTokenHash(context.Background(), tokenHash)
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestGetAuthInfoByTokenHash_ProhibitedLoginUserReturnsNoRows(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "prohibit-login-token-user")

	mustExec(
		t,
		pool,
		`UPDATE users SET prohibit_login = true WHERE id = $1`,
		userID,
	)

	rawToken := "smithers_aabbccddeeff0011223344556677889900aabbcc"
	hash := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(hash[:])

	mustExec(
		t,
		pool,
		`INSERT INTO access_tokens (user_id, name, token_hash, token_last_eight, scopes)
			 VALUES ($1, 'prohibited-token', $2, '00aabbcc', 'read:repository')`,
		userID,
		tokenHash,
	)

	_, err := q.GetAuthInfoByTokenHash(context.Background(), tokenHash)
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows, "prohibited-login user should not be returned by token hash lookup")
}

func TestGetUserByIDAndLowerUsername(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "lookup-user")

	gotByID, err := q.GetUserByID(context.Background(), userID)
	require.NoError(t, err)
	assert.Equal(t, userID, gotByID.ID)

	gotByLowerName, err := q.GetUserByLowerUsername(context.Background(), "lookup-user")
	require.NoError(t, err)
	assert.Equal(t, userID, gotByLowerName.ID)
}

func TestGetUserByWalletAndLowerEmail(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "lookup-contact-user")
	mustExec(
		t,
		pool,
		`UPDATE users SET wallet_address = $1, email = $2, lower_email = $3 WHERE id = $4`,
		"0x1234567890123456789012345678901234567890",
		"Contact@Example.com",
		"contact@example.com",
		userID,
	)

	gotByWallet, err := q.GetUserByWalletAddress(context.Background(), pgtype.Text{String: "0x1234567890123456789012345678901234567890", Valid: true})
	require.NoError(t, err)
	assert.Equal(t, userID, gotByWallet.ID)

	gotByEmail, err := q.GetUserByLowerEmail(context.Background(), pgtype.Text{String: "contact@example.com", Valid: true})
	require.NoError(t, err)
	assert.Equal(t, userID, gotByEmail.ID)
}

func TestUpdateUserAndLastLogin(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "update-user")

	updated, err := q.UpdateUser(context.Background(), UpdateUserParams{
		UserID:      userID,
		DisplayName: "Updated Display",
		Bio:         "Updated bio",
		AvatarUrl:   "https://example.com/avatar.png",
		Email:       pgtype.Text{String: "updated@example.com", Valid: true},
		LowerEmail:  pgtype.Text{String: "updated@example.com", Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "Updated Display", updated.DisplayName)
	assert.Equal(t, "Updated bio", updated.Bio)
	assert.Equal(t, "https://example.com/avatar.png", updated.AvatarUrl)
	assert.Equal(t, "updated@example.com", updated.Email.String)
	assert.Equal(t, "updated@example.com", updated.LowerEmail.String)

	err = q.UpdateUserLastLogin(context.Background(), userID)
	require.NoError(t, err)

	refetched, err := q.GetUserByID(context.Background(), userID)
	require.NoError(t, err)
	assert.True(t, refetched.LastLoginAt.Valid)
}

func TestListSearchCountAndRoleQueries(t *testing.T) {
	q, pool := newQueries(t)
	usernames := []string{"alpha-user", "bravo-user", "charlie-user"}
	var userIDs []int64
	for _, username := range usernames {
		userIDs = append(userIDs, mustCreateUser(t, pool, username))
	}

	err := q.SetUserAdmin(context.Background(), SetUserAdminParams{
		UserID:  userIDs[0],
		IsAdmin: true,
	})
	require.NoError(t, err)

	err = q.DeactivateUser(context.Background(), userIDs[2])
	require.NoError(t, err)

	users, err := q.ListUsers(context.Background(), ListUsersParams{PageSize: 10, PageOffset: 0})
	require.NoError(t, err)
	require.NotEmpty(t, users)
	for _, user := range users {
		assert.True(t, user.IsActive)
	}

	count, err := q.CountUsers(context.Background())
	require.NoError(t, err)
	assert.GreaterOrEqual(t, count, int64(2))

	results, err := q.SearchUsers(context.Background(), SearchUsersParams{
		SearchQuery: "%bravo%",
		PageSize:    10,
		PageOffset:  0,
	})
	require.NoError(t, err)
	require.NotEmpty(t, results)
	assert.True(t, strings.Contains(results[0].LowerUsername, "bravo") || strings.Contains(strings.ToLower(results[0].DisplayName), "bravo"))

	admin, err := q.GetUserByID(context.Background(), userIDs[0])
	require.NoError(t, err)
	assert.True(t, admin.IsAdmin)
}

func TestSuspendUser(t *testing.T) {
	q, pool := newQueries(t)
	userID := mustCreateUser(t, pool, "suspend-user")

	// Suspend the user: sets prohibit_login=true and is_active=false.
	_, err := q.SetUserSuspended(context.Background(), SetUserSuspendedParams{
		Suspended: true,
		UserID:    userID,
	})
	require.NoError(t, err)

	user, err := q.GetUserByID(context.Background(), userID)
	require.NoError(t, err)
	assert.Equal(t, userID, user.ID)
	assert.False(t, user.IsActive)
	assert.True(t, user.ProhibitLogin)

	// GetUserByLowerUsername filters by is_active=true, so suspended user is not found.
	_, err = q.GetUserByLowerUsername(context.Background(), "suspend-user")
	require.Error(t, err)
	assert.ErrorIs(t, err, pgx.ErrNoRows)
}

func TestListUsersPaginationTableDriven(t *testing.T) {
	q, pool := newQueries(t)
	for i := 0; i < 5; i++ {
		mustCreateUser(t, pool, "page-user-"+time.Now().UTC().Add(time.Duration(i)*time.Millisecond).Format("150405.000"))
	}

	testCases := []struct {
		name   string
		limit  int32
		offset int32
	}{
		{name: "first page", limit: 2, offset: 0},
		{name: "second page", limit: 2, offset: 2},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			users, err := q.ListUsers(context.Background(), ListUsersParams{
				PageSize:   tc.limit,
				PageOffset: tc.offset,
			})
			require.NoError(t, err)
			assert.LessOrEqual(t, len(users), int(tc.limit))
		})
	}
}

func TestCreateUserWithWallet(t *testing.T) {
	q, _ := newQueries(t)

	user, err := q.CreateUserWithWallet(context.Background(), CreateUserWithWalletParams{
		Username:      "wallet-create-user",
		LowerUsername: "wallet-create-user",
		DisplayName:   "Wallet Create User",
		WalletAddress: pgtype.Text{String: "0x1111111111111111111111111111111111111111", Valid: true},
	})
	require.NoError(t, err)
	assert.Equal(t, "wallet-create-user", user.Username)
	assert.Equal(t, "wallet-create-user", user.LowerUsername)
	assert.True(t, user.WalletAddress.Valid)
	assert.Equal(t, "0x1111111111111111111111111111111111111111", user.WalletAddress.String)
}

func TestDuplicateWalletAddressRejected(t *testing.T) {
	q, _ := newQueries(t)

	_, err := q.CreateUserWithWallet(context.Background(), CreateUserWithWalletParams{
		Username:      "dup-wallet-a",
		LowerUsername: "dup-wallet-a",
		DisplayName:   "Dup Wallet A",
		WalletAddress: pgtype.Text{String: "0x2222222222222222222222222222222222222222", Valid: true},
	})
	require.NoError(t, err)

	_, err = q.CreateUserWithWallet(context.Background(), CreateUserWithWalletParams{
		Username:      "dup-wallet-b",
		LowerUsername: "dup-wallet-b",
		DisplayName:   "Dup Wallet B",
		WalletAddress: pgtype.Text{String: "0x2222222222222222222222222222222222222222", Valid: true},
	})
	require.Error(t, err, "expected unique violation for duplicate wallet_address")
}

func TestDuplicateLowerEmailRejected(t *testing.T) {
	q, _ := newQueries(t)

	_, err := q.CreateUser(context.Background(), CreateUserParams{
		Username:      "dup-email-a",
		LowerUsername: "dup-email-a",
		Email:         pgtype.Text{String: "dup@example.com", Valid: true},
		LowerEmail:    pgtype.Text{String: "dup@example.com", Valid: true},
		DisplayName:   "Dup Email A",
	})
	require.NoError(t, err)

	_, err = q.CreateUser(context.Background(), CreateUserParams{
		Username:      "dup-email-b",
		LowerUsername: "dup-email-b",
		Email:         pgtype.Text{String: "dup@example.com", Valid: true},
		LowerEmail:    pgtype.Text{String: "dup@example.com", Valid: true},
		DisplayName:   "Dup Email B",
	})
	require.Error(t, err, "expected unique violation for duplicate lower_email")
}

func TestGetUserByWalletAddress_NoDuplicateAmbiguity(t *testing.T) {
	q, _ := newQueries(t)

	wallet := pgtype.Text{String: "0x3333333333333333333333333333333333333333", Valid: true}
	user, err := q.CreateUserWithWallet(context.Background(), CreateUserWithWalletParams{
		Username:      "wallet-deterministic",
		LowerUsername: "wallet-deterministic",
		DisplayName:   "Wallet Deterministic",
		WalletAddress: wallet,
	})
	require.NoError(t, err)

	got, err := q.GetUserByWalletAddress(context.Background(), wallet)
	require.NoError(t, err)
	assert.Equal(t, user.ID, got.ID)
}

func TestGetUserByLowerEmail_NoDuplicateAmbiguity(t *testing.T) {
	q, pool := newQueries(t)

	userID := mustCreateUser(t, pool, "email-deterministic")
	email := pgtype.Text{String: "deterministic@example.com", Valid: true}
	mustExec(t, pool, `UPDATE users SET email = $1, lower_email = $2 WHERE id = $3`,
		"deterministic@example.com", "deterministic@example.com", userID)

	got, err := q.GetUserByLowerEmail(context.Background(), email)
	require.NoError(t, err)
	assert.Equal(t, userID, got.ID)
}
