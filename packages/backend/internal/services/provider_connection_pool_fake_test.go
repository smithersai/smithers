package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The in-memory fake does not model pools or device sign-ins; the pool is
// exercised against PostgreSQL in provider_connection_pool_integration_test.go.

func (f *fakeProviderConnectionQuerier) ProviderConnectionPoolStatus(context.Context, db.ProviderConnectionPoolStatusParams) (db.ProviderConnectionPoolStatusRow, error) {
	return db.ProviderConnectionPoolStatusRow{}, nil
}
func (f *fakeProviderConnectionQuerier) PickProviderConnection(context.Context, db.PickProviderConnectionParams) (db.ProviderConnection, error) {
	return db.ProviderConnection{}, pgx.ErrNoRows
}
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

func TestClaudeConnectionProxySecretsBindAnAPIKeyAsTheAPIKeySeat(t *testing.T) {
	apiKey := ClaudeConnectionProxySecrets(&ResolvedProviderConnection{Kind: ProviderConnectionKindAPIKey, AccessToken: "sk-ant-api03-key"})
	if len(apiKey) != 1 || apiKey[0].Name != "ANTHROPIC_API_KEY" {
		t.Fatalf("api key binding = %+v", apiKey)
	}
	subscription := ClaudeConnectionProxySecrets(&ResolvedProviderConnection{Kind: ProviderConnectionKindSetupToken, AccessToken: "sk-ant-oat01-token"})
	if len(subscription) != 2 || subscription[0].Name != "ANTHROPIC_AUTH_TOKEN" {
		t.Fatalf("subscription binding = %+v", subscription)
	}
}
