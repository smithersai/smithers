package flowhost

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/stretchr/testify/require"
)

type testCodec struct{}

func (testCodec) EncryptString(value string) (string, error) { return "encrypted:" + value, nil }
func (testCodec) DecryptString(value string) (string, error) {
	if !strings.HasPrefix(value, "encrypted:") {
		return "", errors.New("invalid ciphertext")
	}
	return strings.TrimPrefix(value, "encrypted:"), nil
}

type stopFunc func(context.Context, Binding) error

func (f stopFunc) StopFlowHost(ctx context.Context, b Binding) error { return f(ctx, b) }

func hostTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("SMITHERS_FLOWHOST_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("set SMITHERS_FLOWHOST_TEST_DATABASE_URL for real PostgreSQL acceptance")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	parsed, err := url.Parse(raw)
	require.NoError(t, err)
	parsed.Path = "/postgres"
	admin, err := pgx.Connect(ctx, parsed.String())
	require.NoError(t, err)
	name := "flowhost_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	require.NoError(t, err)
	parsed.Path = "/" + name
	pool, err := pgxpool.New(ctx, parsed.String())
	require.NoError(t, err)
	t.Cleanup(func() {
		pool.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
		if err != nil {
			t.Error(err)
		}
		_ = admin.Close(ctx)
	})
	require.NoError(t, product.Apply(ctx, pool))
	_, err = pool.Exec(ctx, SchemaSQL())
	require.NoError(t, err)
	return pool
}
func hostFixture(t *testing.T, pool *pgxpool.Pool) (Authority, Catalog) {
	t.Helper()
	ctx := context.Background()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	var user, repo int64
	err := pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`, "u"+suffix, suffix+"@example.invalid").Scan(&user)
	require.NoError(t, err)
	err = pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,$2,$2) RETURNING id`, user, "r"+suffix).Scan(&repo)
	require.NoError(t, err)
	workspace := uuid.NewString()
	_, err = pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id) VALUES($1,$2,$3)`, workspace, repo, user)
	require.NoError(t, err)
	return Authority{Target: flowruntime.Target{TenantID: "repo:" + suffix, PrincipalID: "user:" + suffix, BindingKind: "agent-session", BindingID: uuid.NewString()}, RepositoryID: repo, UserID: user, WorkspaceID: workspace, CatalogKey: CatalogCoding, SourceRevision: strings.Repeat("a", 40)}, Catalog{Key: CatalogCoding, Family: CatalogCoding, Executable: "/opt/smithers/coding", ArtifactDigest: strings.Repeat("b", 64), ServiceName: "coding"}
}

func TestPostgresHostBindingConcurrencyAuthorityAndRestart(t *testing.T) {
	pool := hostTestPool(t)
	ctx := context.Background()
	authority, catalog := hostFixture(t, pool)
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	first, err := store.Acquire(ctx, authority, catalog)
	require.NoError(t, err)
	require.NotEmpty(t, first.Credential())
	id, bearer := first.Binding().ID, first.Credential()
	// A second session must wait for the same host lease, not a different lock.
	another := authority
	another.Target.BindingID = uuid.NewString()
	blocked, cancel := context.WithTimeout(ctx, 70*time.Millisecond)
	_, err = store.Acquire(blocked, another, catalog)
	cancel()
	require.ErrorIs(t, err, context.DeadlineExceeded)
	_, err = first.PrepareStart(ctx, false)
	require.NoError(t, err)
	require.NoError(t, first.MarkRunning(ctx))
	require.NoError(t, first.Close())
	restarted, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	another.SourceRevision = "" // reconnect uses the pinned revision, not a new HEAD.
	var wg sync.WaitGroup
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			held, err := restarted.Acquire(ctx, another, catalog)
			if err != nil {
				failures <- err
				return
			}
			defer held.Close()
			if held.Binding().ID != id || held.Credential() != bearer || held.Binding().SourceRevision != authority.SourceRevision {
				failures <- errors.New("host identity changed across session/restart")
			}
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		require.NoError(t, err)
	}
	held, err := restarted.Acquire(ctx, another, catalog)
	require.NoError(t, err)
	replacement, err := held.PrepareStart(ctx, true)
	require.NoError(t, err)
	require.EqualValues(t, 2, replacement.OwnerGeneration)
	require.NoError(t, held.Close())
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM flow_runtime_host_bindings`).Scan(&count))
	require.Equal(t, 1, count)
	foreign := another
	foreign.Target.PrincipalID = "other-principal"
	_, err = store.Acquire(ctx, foreign, catalog)
	require.Error(t, err)
	foreign = another
	foreign.UserID++
	_, err = store.Acquire(ctx, foreign, catalog)
	require.Error(t, err)
	changed := another
	changed.SourceRevision = strings.Repeat("c", 40)
	_, err = store.Acquire(ctx, changed, catalog)
	require.Error(t, err)
}

func TestPostgresHostRetirementSurvivesDeleteAndStopFailure(t *testing.T) {
	pool := hostTestPool(t)
	ctx := context.Background()
	store, err := NewStore(pool, testCodec{})
	require.NoError(t, err)
	for _, mode := range []string{"soft", "hard", "repository", "user"} {
		t.Run(mode, func(t *testing.T) {
			authority, catalog := hostFixture(t, pool)
			if mode == "user" {
				name := "member" + strings.ReplaceAll(uuid.NewString(), "-", "")
				require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email) VALUES($1,$1,$2,$2) RETURNING id`, name, name+"@example.invalid").Scan(&authority.UserID))
				_, err = pool.Exec(ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`, authority.WorkspaceID, authority.UserID)
				require.NoError(t, err)
			}
			held, err := store.Acquire(ctx, authority, catalog)
			require.NoError(t, err)
			defer held.Close()
			binding := held.Binding()
			_, err = held.PrepareStart(ctx, false)
			require.NoError(t, err)
			// Leave the launch lease active while deletion commits. No resurrection is allowed.
			switch mode {
			case "soft":
				_, err = pool.Exec(ctx, `UPDATE workspaces SET deleted_at=clock_timestamp() WHERE id=$1`, authority.WorkspaceID)
			case "hard":
				_, err = pool.Exec(ctx, `DELETE FROM workspaces WHERE id=$1`, authority.WorkspaceID)
			case "repository":
				err = deleteHostTestRepository(ctx, pool, authority.RepositoryID)
			case "user":
				_, err = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, authority.UserID)
			}
			require.NoError(t, err)
			require.Error(t, held.MarkRunning(ctx))
			require.NoError(t, held.Close())
			_, err = store.Acquire(ctx, authority, catalog)
			require.Error(t, err)
			var state string
			require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM flow_runtime_host_bindings WHERE id=$1`, binding.ID).Scan(&state))
			require.Equal(t, "retired", state)
			expected := errors.New("runtime unavailable")
			require.ErrorIs(t, store.ReconcileRetired(ctx, stopFunc(func(context.Context, Binding) error { return expected }), 10), expected)
			require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM flow_runtime_host_bindings WHERE id=$1`, binding.ID).Scan(&state))
			restarted, err := NewStore(pool, testCodec{})
			require.NoError(t, err)
			stopped := 0
			require.NoError(t, restarted.ReconcileRetired(ctx, stopFunc(func(_ context.Context, got Binding) error {
				require.Equal(t, binding.ID, got.ID)
				require.Equal(t, authority.WorkspaceID, got.WorkspaceID)
				require.Equal(t, authority.UserID, got.UserID)
				stopped++
				return nil
			}), 10))
			require.Equal(t, 1, stopped)
			require.ErrorIs(t, pool.QueryRow(ctx, `SELECT state FROM flow_runtime_host_bindings WHERE id=$1`, binding.ID).Scan(&state), pgx.ErrNoRows)
		})
	}
}

func deleteHostTestRepository(ctx context.Context, pool *pgxpool.Pool, repo int64) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	token := strings.ReplaceAll(uuid.NewString(), "-", "") + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = tx.Exec(ctx, `INSERT INTO repository_storage_operations(repository_id,operation_type,token,storage_route_key,source_owner,source_repo,source_user_id)
 SELECT r.id,'delete',$2,'static',u.username,r.name,r.user_id FROM repositories r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, repo, token)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('smithers.repository_storage_operation_token',$1,true)`, token); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM repositories WHERE id=$1`, repo); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
