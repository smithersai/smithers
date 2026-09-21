package services

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestAdminUser_Z_SetUserAdminAndCreateTokenLookupErrors(t *testing.T) {
	t.Parallel()

	ctx := context.Background()

	svc := NewAdminUserService(&mockAdminUserQuerier{
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return db.User{}, pgx.ErrNoRows
		},
	})
	_, err := svc.SetUserAdmin(ctx, "missing", true)
	assert.Equal(t, http.StatusNotFound, apiStatus(t, err))

	svc = NewAdminUserService(&mockAdminUserQuerier{
		getUserByLowerUsernameFn: func(context.Context, string) (db.User, error) {
			return db.User{}, errors.New("lookup failed")
		},
	}, WithTokenCreator(stubTokenCreator{}))
	_, err = svc.CreateTokenForUser(ctx, "alice", CreateTokenRequest{Name: "ci"})
	assert.Equal(t, http.StatusInternalServerError, apiStatus(t, err))
}

type stubTokenCreator struct{}

func (stubTokenCreator) CreateToken(context.Context, int64, CreateTokenRequest) (CreateTokenResult, error) {
	return CreateTokenResult{}, nil
}
