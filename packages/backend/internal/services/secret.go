package services

import (
	"context"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

const (
	// maxSecretsPerRepo and maxSecretsPerOrg are best-effort read-then-write
	// caps enforced in the service layer. They are not transactional and can
	// slightly overshoot under concurrent writers (TOCTOU); hard enforcement
	// via a transactional COUNT query is tracked separately at the db-queries
	// layer.
	maxSecretsPerRepo   = 100
	maxSecretsPerOrg    = 100
	maxSecretValueBytes = 64 * 1024
)

type SecretQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
	GetOrgByLowerName(ctx context.Context, lowerName string) (db.Organization, error)
	GetOrgMember(ctx context.Context, arg db.GetOrgMemberParams) (db.OrgMember, error)
	IsOrgOwnerForRepoUser(ctx context.Context, arg db.IsOrgOwnerForRepoUserParams) (bool, error)
	GetHighestTeamPermissionForRepoUser(ctx context.Context, arg db.GetHighestTeamPermissionForRepoUserParams) (string, error)
	GetCollaboratorPermissionForRepoUser(ctx context.Context, arg db.GetCollaboratorPermissionForRepoUserParams) (string, error)

	CreateOrUpdateSecret(ctx context.Context, arg db.CreateOrUpdateSecretParams) (db.RepositorySecret, error)
	ListSecrets(ctx context.Context, repositoryID int64) ([]db.ListSecretsRow, error)
	ListSecretValuesForRepo(ctx context.Context, repositoryID int64) ([]db.ListSecretValuesForRepoRow, error)
	DeleteSecret(ctx context.Context, arg db.DeleteSecretParams) error
	CreateOrUpdateOrgSecret(ctx context.Context, arg db.CreateOrUpdateOrgSecretParams) (db.OrganizationSecret, error)
	ListOrgSecrets(ctx context.Context, organizationID int64) ([]db.ListOrgSecretsRow, error)
	ListOrgSecretValues(ctx context.Context, organizationID int64) ([]db.ListOrgSecretValuesRow, error)
	DeleteOrgSecret(ctx context.Context, arg db.DeleteOrgSecretParams) error
}

type SecretService struct {
	queries        SecretQuerier
	secretCodec    webhook.SecretCodec
	ownershipGuard RepoOwnershipGuard
}

type SecretServiceOption func(*SecretService)

// WithSecretOwnershipGuard fences repo-scoped secret writes against concurrent
// repository transfers, so a request authorized against the old owner cannot
// mutate the new owner's secrets.
func WithSecretOwnershipGuard(g RepoOwnershipGuard) SecretServiceOption {
	return func(s *SecretService) {
		s.ownershipGuard = g
	}
}

func NewSecretService(q SecretQuerier, codec webhook.SecretCodec, opts ...SecretServiceOption) *SecretService {
	secretCodec := webhook.SecretCodec(webhook.NoopSecretCodec{})
	if codec != nil {
		secretCodec = codec
	}
	s := &SecretService{
		queries:     q,
		secretCodec: secretCodec,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// SecretResponse is the service-layer response for a secret.
// It never includes the value — only metadata.
type SecretResponse struct {
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

func (s *SecretService) SetSecret(ctx context.Context, actor *db.User, owner, repo, name, value string) (SecretResponse, error) {
	if actor == nil {
		return SecretResponse{}, pkgerrors.Unauthorized("authentication required")
	}

	trimmedName := strings.TrimSpace(name)
	if trimmedName == "" {
		return SecretResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Secret", Field: "name", Code: "missing_field"})
	}
	if len(trimmedName) > 255 {
		return SecretResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Secret", Field: "name", Code: "invalid"})
	}
	if isReservedInjectedEnvName(trimmedName) {
		return SecretResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Secret", Field: "name", Code: "invalid"})
	}
	if value == "" {
		return SecretResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Secret", Field: "value", Code: "missing_field"})
	}
	if len(value) > maxSecretValueBytes {
		return SecretResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Secret", Field: "value", Code: "too_long"})
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return SecretResponse{}, err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return SecretResponse{}, err
	}

	if err := s.enforceSecretQuota(ctx, repository.ID, trimmedName); err != nil {
		return SecretResponse{}, err
	}

	// Encrypt the secret value before storing.
	encrypted, err := s.secretCodec.EncryptString(value)
	if err != nil {
		return SecretResponse{}, pkgerrors.Internal("failed to encrypt secret")
	}

	var created db.RepositorySecret
	if err := guardedRepoWrite(ctx, s.ownershipGuard, repository, func() error {
		var werr error
		created, werr = s.queries.CreateOrUpdateSecret(ctx, db.CreateOrUpdateSecretParams{
			RepositoryID:   repository.ID,
			Name:           trimmedName,
			ValueEncrypted: []byte(encrypted),
		})
		if werr != nil {
			return pkgerrors.Internal("failed to set secret")
		}
		return nil
	}); err != nil {
		return SecretResponse{}, err
	}

	return SecretResponse{
		Name:      created.Name,
		CreatedAt: created.CreatedAt.Format("2006-01-02T15:04:05Z"),
		UpdatedAt: created.UpdatedAt.Format("2006-01-02T15:04:05Z"),
	}, nil
}

func (s *SecretService) ListSecrets(ctx context.Context, actor *db.User, owner, repo string) ([]SecretResponse, error) {
	if actor == nil {
		return nil, pkgerrors.Unauthorized("authentication required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return nil, err
	}
	if err := s.requireWriteAccess(ctx, repository, actor); err != nil {
		return nil, err
	}

	rows, err := s.queries.ListSecrets(ctx, repository.ID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list secrets")
	}

	result := make([]SecretResponse, len(rows))
	for i, row := range rows {
		result[i] = SecretResponse{
			Name:      row.Name,
			CreatedAt: row.CreatedAt.Format("2006-01-02T15:04:05Z"),
			UpdatedAt: row.UpdatedAt.Format("2006-01-02T15:04:05Z"),
		}
	}
	return result, nil
}

func (s *SecretService) ListDecryptedSecretsForRepo(ctx context.Context, repositoryID int64) (map[string]string, error) {
	if s == nil || s.queries == nil {
		return nil, pkgerrors.Internal("secret store unavailable")
	}

	rows, err := s.queries.ListSecretValuesForRepo(ctx, repositoryID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list secret values")
	}

	secrets := make(map[string]string, len(rows))
	for _, row := range rows {
		name := strings.TrimSpace(row.Name)
		if name == "" {
			continue
		}

		value, err := s.secretCodec.DecryptString(string(row.ValueEncrypted))
		if err != nil {
			return nil, pkgerrors.Internal("failed to decrypt secret")
		}
		secrets[name] = value
	}

	return secrets, nil
}

func (s *SecretService) DeleteSecret(ctx context.Context, actor *db.User, owner, repo, name string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}

	trimmedName := strings.TrimSpace(name)
	if trimmedName == "" {
		return pkgerrors.BadRequest("secret name is required")
	}

	repository, err := s.resolveRepoByOwnerAndName(ctx, owner, repo)
	if err != nil {
		return err
	}
	if err := s.requireAdminAccess(ctx, repository, actor); err != nil {
		return err
	}

	return guardedRepoWrite(ctx, s.ownershipGuard, repository, func() error {
		if err := s.queries.DeleteSecret(ctx, db.DeleteSecretParams{
			RepositoryID: repository.ID,
			Name:         trimmedName,
		}); err != nil {
			return pkgerrors.Internal("failed to delete secret")
		}
		return nil
	})
}

func (s *SecretService) SetOrgSecret(ctx context.Context, actor *db.User, orgName, name, value string) (SecretResponse, error) {
	if actor == nil {
		return SecretResponse{}, pkgerrors.Unauthorized("authentication required")
	}
	trimmedName := strings.TrimSpace(name)
	if trimmedName == "" {
		return SecretResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Secret", Field: "name", Code: "missing_field"})
	}
	if len(trimmedName) > 255 {
		return SecretResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Secret", Field: "name", Code: "invalid"})
	}
	if isReservedInjectedEnvName(trimmedName) {
		return SecretResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Secret", Field: "name", Code: "invalid"})
	}
	if value == "" {
		return SecretResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Secret", Field: "value", Code: "missing_field"})
	}
	if len(value) > maxSecretValueBytes {
		return SecretResponse{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Secret", Field: "value", Code: "too_long"})
	}

	org, err := s.resolveOrgByName(ctx, orgName)
	if err != nil {
		return SecretResponse{}, err
	}
	if err := s.requireOrgOwnerAccess(ctx, org, actor); err != nil {
		return SecretResponse{}, err
	}

	if err := s.enforceOrgSecretQuota(ctx, org.ID, trimmedName); err != nil {
		return SecretResponse{}, err
	}

	encrypted, err := s.secretCodec.EncryptString(value)
	if err != nil {
		return SecretResponse{}, pkgerrors.Internal("failed to encrypt secret")
	}
	created, err := s.queries.CreateOrUpdateOrgSecret(ctx, db.CreateOrUpdateOrgSecretParams{
		OrganizationID: org.ID,
		Name:           trimmedName,
		ValueEncrypted: []byte(encrypted),
	})
	if err != nil {
		return SecretResponse{}, pkgerrors.Internal("failed to set organization secret")
	}
	return SecretResponse{
		Name:      created.Name,
		CreatedAt: created.CreatedAt.Format("2006-01-02T15:04:05Z"),
		UpdatedAt: created.UpdatedAt.Format("2006-01-02T15:04:05Z"),
	}, nil
}

func (s *SecretService) ListOrgSecrets(ctx context.Context, actor *db.User, orgName string) ([]SecretResponse, error) {
	org, err := s.resolveOrgByName(ctx, orgName)
	if err != nil {
		return nil, err
	}
	if err := s.requireOrgOwnerAccess(ctx, org, actor); err != nil {
		return nil, err
	}
	rows, err := s.queries.ListOrgSecrets(ctx, org.ID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list organization secrets")
	}
	result := make([]SecretResponse, len(rows))
	for i, row := range rows {
		result[i] = SecretResponse{
			Name:      row.Name,
			CreatedAt: row.CreatedAt.Format("2006-01-02T15:04:05Z"),
			UpdatedAt: row.UpdatedAt.Format("2006-01-02T15:04:05Z"),
		}
	}
	return result, nil
}

func (s *SecretService) DeleteOrgSecret(ctx context.Context, actor *db.User, orgName, name string) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	trimmedName := strings.TrimSpace(name)
	if trimmedName == "" {
		return pkgerrors.BadRequest("secret name is required")
	}
	org, err := s.resolveOrgByName(ctx, orgName)
	if err != nil {
		return err
	}
	if err := s.requireOrgOwnerAccess(ctx, org, actor); err != nil {
		return err
	}
	if err := s.queries.DeleteOrgSecret(ctx, db.DeleteOrgSecretParams{
		OrganizationID: org.ID,
		Name:           trimmedName,
	}); err != nil {
		return pkgerrors.Internal("failed to delete organization secret")
	}
	return nil
}

// enforceSecretQuota rejects a write that would create a new secret beyond
// maxSecretsPerRepo. Updates to an already-existing name are always allowed.
// This is a best-effort read-then-write cap (TOCTOU races can slightly
// overshoot); hard transactional enforcement is deferred to a COUNT query.
func (s *SecretService) enforceSecretQuota(ctx context.Context, repositoryID int64, name string) error {
	rows, err := s.queries.ListSecrets(ctx, repositoryID)
	if err != nil {
		return pkgerrors.Internal("failed to set secret")
	}
	for _, row := range rows {
		if row.Name == name {
			return nil
		}
	}
	if len(rows) >= maxSecretsPerRepo {
		return pkgerrors.QuotaExceeded("repository secret limit reached (100)")
	}
	return nil
}

// enforceOrgSecretQuota is the organization-scoped counterpart of
// enforceSecretQuota.
func (s *SecretService) enforceOrgSecretQuota(ctx context.Context, organizationID int64, name string) error {
	rows, err := s.queries.ListOrgSecrets(ctx, organizationID)
	if err != nil {
		return pkgerrors.Internal("failed to set organization secret")
	}
	for _, row := range rows {
		if row.Name == name {
			return nil
		}
	}
	if len(rows) >= maxSecretsPerOrg {
		return pkgerrors.QuotaExceeded("organization secret limit reached (100)")
	}
	return nil
}

// --- permission helpers (same pattern as webhook service) ---

func (s *SecretService) resolveRepoByOwnerAndName(ctx context.Context, owner, repo string) (db.Repository, error) {
	lowerOwner := strings.ToLower(strings.TrimSpace(owner))
	lowerRepo := strings.ToLower(strings.TrimSpace(repo))
	if lowerOwner == "" {
		return db.Repository{}, pkgerrors.BadRequest("owner is required")
	}
	if lowerRepo == "" {
		return db.Repository{}, pkgerrors.BadRequest("repository name is required")
	}

	repository, err := s.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     lowerOwner,
		LowerName: lowerRepo,
	})
	if err != nil {
		return db.Repository{}, pkgerrors.NotFound("repository not found")
	}
	return repository, nil
}

func (s *SecretService) resolveOrgByName(ctx context.Context, orgName string) (db.Organization, error) {
	lowerOrg := strings.ToLower(strings.TrimSpace(orgName))
	if lowerOrg == "" {
		return db.Organization{}, pkgerrors.BadRequest("organization name is required")
	}
	org, err := s.queries.GetOrgByLowerName(ctx, lowerOrg)
	if err != nil {
		return db.Organization{}, pkgerrors.NotFound("organization not found")
	}
	return org, nil
}

func (s *SecretService) requireOrgOwnerAccess(ctx context.Context, org db.Organization, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	if actor.IsAdmin {
		return nil
	}
	member, err := s.queries.GetOrgMember(ctx, db.GetOrgMemberParams{
		OrganizationID: org.ID,
		UserID:         actor.ID,
	})
	if err != nil || strings.ToLower(strings.TrimSpace(member.Role)) != "owner" {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *SecretService) requireAdminAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	isAdmin, err := s.isRepoAdmin(ctx, repository, actor.ID)
	if err != nil {
		return err
	}
	if !isAdmin {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *SecretService) requireWriteAccess(ctx context.Context, repository db.Repository, actor *db.User) error {
	if actor == nil {
		return pkgerrors.Unauthorized("authentication required")
	}
	canWrite, err := s.canWriteRepo(ctx, repository, actor.ID)
	if err != nil {
		return err
	}
	if !canWrite {
		return pkgerrors.Forbidden("permission denied")
	}
	return nil
}

func (s *SecretService) isRepoAdmin(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return isRepoAdmin(ctx, s.queries, repository, userID)
}

func (s *SecretService) canWriteRepo(ctx context.Context, repository db.Repository, userID int64) (bool, error) {
	return canWriteRepo(ctx, s.queries, repository, userID)
}
