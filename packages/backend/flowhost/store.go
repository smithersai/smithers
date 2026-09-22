package flowhost

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaSQL string

// SchemaSQL is the exact additive schema handed to the ordered product
// migration owner. Store never self-migrates.
func SchemaSQL() string { return schemaSQL }

type Store struct {
	pool          *pgxpool.Pool
	codec         SecretCodec
	newCredential func() (string, error)
}

func NewStore(pool *pgxpool.Pool, codec SecretCodec) (*Store, error) {
	if pool == nil || codec == nil {
		return nil, errors.New("flow host store requires PostgreSQL and a secret codec")
	}
	return &Store{pool: pool, codec: codec, newCredential: generateCredential}, nil
}

func generateCredential() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate flow host credential: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

type lease struct {
	store      *Store
	connection *pgxpool.Conn
	lockKey    string
	binding    Binding
	credential string
	closed     bool
}

func bindingLockKey(authority Authority, catalog Catalog) string {
	return strings.Join([]string{"smithers:flow-host", authority.Target.TenantID, authority.Target.PrincipalID,
		authority.Target.BindingKind, authority.Target.BindingID, authority.WorkspaceID, catalog.Key}, "\x00")
}

func (store *Store) Acquire(ctx context.Context, authority Authority, catalog Catalog) (BindingLease, error) {
	if store == nil || store.pool == nil || store.codec == nil {
		return nil, errors.New("flow host store is unavailable")
	}
	if err := validateAuthority(authority.Target, authority); err != nil {
		return nil, err
	}
	validated, err := validateCatalog(catalog)
	if err != nil {
		return nil, err
	}
	if validated.Key != authority.CatalogKey {
		return nil, errors.New("flow host catalog does not match authority")
	}
	connection, err := store.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	lockKey := bindingLockKey(authority, validated)
	if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		connection.Release()
		return nil, err
	}
	result := &lease{store: store, connection: connection, lockKey: lockKey}
	if err := result.loadOrCreate(ctx, authority, validated); err != nil {
		_ = result.Close()
		return nil, err
	}
	return result, nil
}

func (value *lease) loadOrCreate(ctx context.Context, authority Authority, catalog Catalog) error {
	tx, err := value.connection.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck
	binding, encrypted, credentialHash, err := scanBinding(tx.QueryRow(ctx, bindingSelect+`
		WHERE tenant_id=$1 AND principal_id=$2 AND binding_kind=$3 AND binding_id=$4 AND catalog_key=$5
		FOR UPDATE`, authority.Target.TenantID, authority.Target.PrincipalID, authority.Target.BindingKind,
		authority.Target.BindingID, catalog.Key))
	if errors.Is(err, pgx.ErrNoRows) {
		credential, credentialErr := value.store.newCredential()
		if credentialErr != nil {
			return credentialErr
		}
		encrypted, credentialErr = value.store.codec.EncryptString(credential)
		if credentialErr != nil || strings.TrimSpace(encrypted) == "" {
			return errors.New("protect flow host credential")
		}
		digest := sha256.Sum256([]byte(credential))
		binding = Binding{
			ID: uuid.NewString(), TenantID: authority.Target.TenantID, PrincipalID: authority.Target.PrincipalID,
			BindingKind: authority.Target.BindingKind, BindingID: authority.Target.BindingID,
			RepositoryID: authority.RepositoryID, UserID: authority.UserID, WorkspaceID: authority.WorkspaceID,
			CatalogKey: catalog.Key, ServiceName: catalog.ServiceName,
			RuntimeArtifactDigest: catalog.ArtifactDigest, SourceRevision: catalog.SourceRevision,
			OwnerGeneration: 1, State: "pending",
		}
		_, err = tx.Exec(ctx, `INSERT INTO flow_runtime_host_bindings
			(id, tenant_id, principal_id, binding_kind, binding_id, repository_id, user_id, workspace_id,
			 catalog_key, service_name, runtime_artifact_digest, source_revision, owner_generation,
			 credential_ciphertext, credential_hash, state)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending')`,
			binding.ID, binding.TenantID, binding.PrincipalID, binding.BindingKind, binding.BindingID,
			binding.RepositoryID, binding.UserID, binding.WorkspaceID, binding.CatalogKey, binding.ServiceName,
			binding.RuntimeArtifactDigest, binding.SourceRevision, binding.OwnerGeneration, encrypted, digest[:])
		if err != nil {
			return err
		}
		credentialHash = digest[:]
		value.credential = credential
	} else if err != nil {
		return err
	}
	if err := bindingMatches(binding, authority, catalog); err != nil {
		return err
	}
	if value.credential == "" {
		credential, err := value.store.codec.DecryptString(encrypted)
		if err != nil || strings.TrimSpace(credential) == "" {
			return errors.New("open flow host credential")
		}
		digest := sha256.Sum256([]byte(credential))
		if len(credentialHash) != len(digest) || subtle.ConstantTimeCompare(credentialHash, digest[:]) != 1 {
			return errors.New("flow host credential integrity check failed")
		}
		value.credential = credential
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	value.binding = binding
	return nil
}

const bindingSelect = `SELECT id::text, tenant_id, principal_id, binding_kind, binding_id,
		repository_id, user_id, workspace_id, catalog_key, service_name,
		runtime_artifact_digest, source_revision, owner_generation, state,
		credential_ciphertext, credential_hash
	FROM flow_runtime_host_bindings`

func scanBinding(row pgx.Row) (Binding, string, []byte, error) {
	var binding Binding
	var encrypted string
	var credentialHash []byte
	err := row.Scan(&binding.ID, &binding.TenantID, &binding.PrincipalID, &binding.BindingKind, &binding.BindingID,
		&binding.RepositoryID, &binding.UserID, &binding.WorkspaceID, &binding.CatalogKey, &binding.ServiceName,
		&binding.RuntimeArtifactDigest, &binding.SourceRevision, &binding.OwnerGeneration, &binding.State,
		&encrypted, &credentialHash)
	return binding, encrypted, credentialHash, err
}

func bindingMatches(binding Binding, authority Authority, catalog Catalog) error {
	if binding.TenantID != authority.Target.TenantID || binding.PrincipalID != authority.Target.PrincipalID ||
		binding.BindingKind != authority.Target.BindingKind || binding.BindingID != authority.Target.BindingID ||
		binding.RepositoryID != authority.RepositoryID || binding.UserID != authority.UserID ||
		binding.WorkspaceID != authority.WorkspaceID || binding.CatalogKey != catalog.Key ||
		binding.ServiceName != catalog.ServiceName || binding.RuntimeArtifactDigest != catalog.ArtifactDigest ||
		binding.SourceRevision != catalog.SourceRevision || binding.OwnerGeneration <= 0 {
		return errors.New("flow host durable binding conflicts with resolved authority")
	}
	return nil
}

func (value *lease) Binding() Binding { return value.binding }

func (value *lease) Credential() string { return value.credential }

func (value *lease) PrepareStart(ctx context.Context, replaceOwner bool) (Binding, error) {
	if value == nil || value.closed || value.connection == nil {
		return Binding{}, errors.New("flow host binding lease is closed")
	}
	if replaceOwner {
		if value.binding.OwnerGeneration == int64(^uint64(0)>>1) {
			return Binding{}, errors.New("flow host owner generation exhausted")
		}
		value.binding.OwnerGeneration++
	}
	var generation int64
	err := value.connection.QueryRow(ctx, `UPDATE flow_runtime_host_bindings
		SET owner_generation=$2, state='starting', last_error_code='', updated_at=clock_timestamp()
		WHERE id=$1 AND owner_generation <= $2
		RETURNING owner_generation`, value.binding.ID, value.binding.OwnerGeneration).Scan(&generation)
	if err != nil {
		return Binding{}, err
	}
	if generation != value.binding.OwnerGeneration {
		return Binding{}, errors.New("flow host owner fence was not committed")
	}
	value.binding.State = "starting"
	return value.binding, nil
}

func (value *lease) MarkRunning(ctx context.Context) error {
	if value == nil || value.closed || value.connection == nil {
		return errors.New("flow host binding lease is closed")
	}
	tag, err := value.connection.Exec(ctx, `UPDATE flow_runtime_host_bindings
		SET state='running', last_error_code='', updated_at=clock_timestamp()
		WHERE id=$1 AND owner_generation=$2`, value.binding.ID, value.binding.OwnerGeneration)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("flow host running checkpoint lost its owner fence")
	}
	value.binding.State = "running"
	return nil
}

func (value *lease) Close() error {
	if value == nil || value.closed {
		return nil
	}
	value.closed = true
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := value.connection.Exec(ctx, `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, value.lockKey)
	value.connection.Release()
	value.connection = nil
	return err
}

var _ BindingStore = (*Store)(nil)
var _ BindingLease = (*lease)(nil)
