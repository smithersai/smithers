package services

import (
	"context"
	"testing"
)

// Advisory-lock statements build their key by concatenating an id into a string.
// Written as "$1::text", the cast makes Postgres infer a *text* parameter, and
// pgx cannot encode an int64 into text ("cannot find encode plan") — so every
// caller fails at runtime while unit tests that stub the transaction still pass.
// That shipped once (repository deletes 500'd in production); execute each
// statement against a real Postgres with the exact argument types the production
// call sites bind, so a reintroduced cast fails here instead.
func TestAdvisoryLockStatementsEncodeProductionArgTypes(t *testing.T) {
	pool := getAgentTestPool(t)
	ctx := context.Background()

	cases := []struct {
		name string
		sql  string
		args []any
	}{
		// internal/services/repo.go: BeginOwnershipTx(repositoryID int64)
		{"repo ownership exclusive", repoOwnershipLockSQL, []any{int64(4211)}},
		// internal/services/repo_permissions.go: guard binds snapshot.ID
		{"repo ownership shared", repoOwnershipSharedLockSQL, []any{int64(4211)}},
		// internal/services/release_assets.go: binds release.ID
		// internal/services/billing.go: binds owner.OwnerType, owner.OwnerID
		{"storage authorization", storageAuthorizationLockSQL, []any{"user", int64(9)}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatalf("begin transaction: %v", err)
			}
			defer func() { _ = tx.Rollback(ctx) }()

			if _, err := tx.Exec(ctx, tc.sql, tc.args...); err != nil {
				t.Fatalf("advisory lock statement rejected its production arguments: %v", err)
			}
		})
	}
}
