package services

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

const DefaultStorageSetID = "s1"

// StorageSetQuerier defines the DB query surface required by DBStorageSetResolver.
type StorageSetQuerier interface {
	GetRepoByOwnerAndLowerName(ctx context.Context, arg db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error)
}

// RepoPlacementLookup resolves deployment-specific placement by stable repository ID.
// The product repository row deliberately carries no storage-set column.
type RepoPlacementLookup interface {
	StorageSetForRepository(ctx context.Context, repositoryID int64) (string, error)
}

// DBStorageSetResolver combines canonical repository identity with a private
// placement lookup and maps that placement to a backend URL.
type DBStorageSetResolver struct {
	queries   StorageSetQuerier
	placement RepoPlacementLookup
	// In the future this could be a dynamic map from DB, but for now we map predefined
	// storage set IDs to URLs (or just construct the URL if the storage set ID is the hostname).
	// We'll use a simple URL template for now since we run them as k8s StatefulSet dns names.
	baseURLTemplate string
}

// NewDBStorageSetResolver creates a resolver for a private placement adapter.
// The optional variadic parameter keeps composition callers source-compatible
// while they are converted; without it resolution fails closed.
func NewDBStorageSetResolver(q StorageSetQuerier, baseURLTemplate string, placement ...RepoPlacementLookup) *DBStorageSetResolver {
	r := &DBStorageSetResolver{queries: q, baseURLTemplate: baseURLTemplate}
	if len(placement) > 0 {
		r.placement = placement[0]
	}
	return r
}

// BuildStorageSetResolverTemplate derives a storage-set-aware URL template from the
// configured repo-host base URL and the active storage set. If the active storage
// set ID is not present in the configured hostname, the base URL is left as a
// static single-host target.
func BuildStorageSetResolverTemplate(baseURL, activeStorageSet string) string {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return ""
	}

	activeStorageSet = strings.TrimSpace(activeStorageSet)
	if activeStorageSet == "" {
		return baseURL
	}

	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" {
		return baseURL
	}

	hostname := parsed.Hostname()
	if hostname == "" {
		return baseURL
	}

	if !strings.Contains(hostname, activeStorageSet) {
		return baseURL
	}
	replacementHost := strings.Replace(hostname, activeStorageSet, "%s", 1)

	if port := parsed.Port(); port != "" {
		replacementHost += ":" + port
	}

	authority := parsed.Host
	if parsed.User != nil {
		authority = parsed.User.String() + "@" + authority
	}

	before, after, _ := strings.Cut(baseURL, authority)
	return before + replacementHost + after
}

// ResolveURL fetches the repository from the DB to find its assigned storage set ID,
// then constructs the backend repository host URL.
func (r *DBStorageSetResolver) ResolveURL(ctx context.Context, owner, repo string) (string, error) {
	row, err := r.queries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{
		Owner:     owner,
		LowerName: strings.ToLower(repo),
	})
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", fmt.Errorf("repository %s/%s not found: %w", owner, repo, err)
		}
		return "", fmt.Errorf("failed to lookup repository %s/%s storage set info: %w", owner, repo, err)
	}

	if r.placement == nil {
		return "", fmt.Errorf("repository placement lookup is not configured")
	}
	storageSetID, err := r.placement.StorageSetForRepository(ctx, row.ID)
	if err != nil {
		return "", fmt.Errorf("resolve repository %d placement: %w", row.ID, err)
	}
	return r.ResolveStorageSetURL(ctx, storageSetID)
}

// ResolveStorageSetURL maps a trusted storage-set identifier without looking
// up a repository row. This is required while a durable provisioning intent
// exists but the reserved repository row is intentionally not yet visible.
func (r *DBStorageSetResolver) ResolveStorageSetURL(_ context.Context, storageSetID string) (string, error) {
	storageSetID = strings.TrimSpace(storageSetID)
	if storageSetID == "" {
		return "", fmt.Errorf("storage set id is empty")
	}
	template := strings.TrimSpace(r.baseURLTemplate)
	if template == "" {
		return "", fmt.Errorf("repo-host storage set resolver template is empty")
	}
	if strings.Contains(template, "%s") {
		return fmt.Sprintf(template, storageSetID), nil
	}
	return template, nil
}
