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

// DBStorageSetResolver implements StorageSetResolver by looking up the repository's storage set ID
// in the database, and mapping that ID to a backend URL.
type DBStorageSetResolver struct {
	queries StorageSetQuerier
	// In the future this could be a dynamic map from DB, but for now we map predefined
	// storage set IDs to URLs (or just construct the URL if the storage set ID is the hostname).
	// We'll use a simple URL template for now since we run them as k8s StatefulSet dns names.
	baseURLTemplate string
}

// NewDBStorageSetResolver creates a resolver that queries the DB for the repo's storage_set_id.
// It uses baseURLTemplate (e.g., "http://%s:8080") to format the final URL.
func NewDBStorageSetResolver(q StorageSetQuerier, baseURLTemplate string) *DBStorageSetResolver {
	return &DBStorageSetResolver{
		queries:         q,
		baseURLTemplate: baseURLTemplate,
	}
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

	if row.StorageSetID == "" {
		return "", fmt.Errorf("repository %s/%s has no assigned storage set", owner, repo)
	}

	return r.ResolveStorageSetURL(ctx, row.StorageSetID)
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
