package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type authCovOAuthQuerier struct {
	token   db.Oauth2AccessToken
	user    db.User
	userErr error
}

func (q *authCovOAuthQuerier) GetOAuth2AccessTokenByHash(context.Context, string) (db.Oauth2AccessToken, error) {
	return q.token, nil
}

func (q *authCovOAuthQuerier) GetUserByID(context.Context, int64) (db.User, error) {
	return q.user, q.userErr
}

func TestAuth_Cov_TokenAuthOAuthLookupFailureReturnsInternal(t *testing.T) {
	t.Parallel()

	q := &mockUserQuerier{
		getAuthInfoByTokenHashFn: func(context.Context, string) (db.GetAuthInfoByTokenHashRow, error) {
			return db.GetAuthInfoByTokenHashRow{}, pgx.ErrNoRows
		},
		getOAuth2AccessTokenByHashFn: func(context.Context, string) (db.Oauth2AccessToken, error) {
			return db.Oauth2AccessToken{}, assert.AnError
		},
	}

	nextCalled := false
	handler := TokenAuth(q)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer smithers_oat_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.False(t, nextCalled)
	assert.Equal(t, "internal server error", apiErrorMessage(t, rec))
}

func TestAuth_Cov_LoadOAuth2AccessTokenUserFailures(t *testing.T) {
	t.Parallel()

	t.Run("user lookup error is returned", func(t *testing.T) {
		t.Parallel()

		q := &authCovOAuthQuerier{
			token:   db.Oauth2AccessToken{ID: 12, UserID: 44},
			userErr: assert.AnError,
		}

		info, err := loadOAuth2AccessToken(context.Background(), q, "hash")

		require.Nil(t, info)
		assert.ErrorIs(t, err, assert.AnError)
	})

	t.Run("inactive user is treated as missing token", func(t *testing.T) {
		t.Parallel()

		q := &authCovOAuthQuerier{
			token: db.Oauth2AccessToken{ID: 13, UserID: 45},
			user:  db.User{ID: 45, IsActive: false},
		}

		info, err := loadOAuth2AccessToken(context.Background(), q, "hash")

		require.Nil(t, info)
		assert.ErrorIs(t, err, pgx.ErrNoRows)
	})
}
