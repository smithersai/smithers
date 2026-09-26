package services

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The in-memory fake picks the first eligible account; it does not model
// rotation, limits or device sign-ins. The pool is exercised against
// PostgreSQL in db/product/provider_pool_integration_test.go.

func (f *fakeProviderConnectionQuerier) MarkProviderConnectionLimited(context.Context, db.MarkProviderConnectionLimitedParams) error {
	return nil
}
func (f *fakeProviderConnectionQuerier) MarkProviderConnectionRejected(context.Context, db.MarkProviderConnectionRejectedParams) (int64, error) {
	return 0, nil
}
func (f *fakeProviderConnectionQuerier) SetUserProviderConnectionSortOrder(context.Context, db.SetUserProviderConnectionSortOrderParams) (int64, error) {
	return 0, nil
}
func (f *fakeProviderConnectionQuerier) RevokeOtherUserProviderAccountConnections(context.Context, db.RevokeOtherUserProviderAccountConnectionsParams) (int64, error) {
	return 0, nil
}
func (f *fakeProviderConnectionQuerier) CreateProviderConnectionDeviceLogin(context.Context, db.CreateProviderConnectionDeviceLoginParams) (db.ProviderConnectionDeviceLogin, error) {
	return db.ProviderConnectionDeviceLogin{}, pgx.ErrNoRows
}
func (f *fakeProviderConnectionQuerier) GetProviderConnectionDeviceLogin(context.Context, db.GetProviderConnectionDeviceLoginParams) (db.ProviderConnectionDeviceLogin, error) {
	return db.ProviderConnectionDeviceLogin{}, pgx.ErrNoRows
}
func (f *fakeProviderConnectionQuerier) ClaimProviderConnectionDeviceLoginPoll(context.Context, db.ClaimProviderConnectionDeviceLoginPollParams) (db.ProviderConnectionDeviceLogin, error) {
	return db.ProviderConnectionDeviceLogin{}, pgx.ErrNoRows
}
func (f *fakeProviderConnectionQuerier) FinishProviderConnectionDeviceLoginPoll(context.Context, db.FinishProviderConnectionDeviceLoginPollParams) (int64, error) {
	return 0, nil
}
func (f *fakeProviderConnectionQuerier) ExpireProviderConnectionDeviceLogin(context.Context, db.ExpireProviderConnectionDeviceLoginParams) (int64, error) {
	return 0, nil
}
func (f *fakeProviderConnectionQuerier) PickProviderConnectionWaiting(context.Context, db.PickProviderConnectionWaitingParams) (db.ProviderConnection, error) {
	return db.ProviderConnection{}, pgx.ErrNoRows
}
