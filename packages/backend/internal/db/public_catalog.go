package db

import (
	"context"
	"time"
)

// PublicRepository is the small read model exposed by the anonymous catalog.
// It is intentionally derived from product repository ownership rows rather
// than carrying a second curated list.
type PublicRepository struct {
	Name      string
	Title     string
	URL       string
	Summary   string
	UpdatedAt time.Time
}

const listPublicRepositoryCatalog = `
SELECT ns.lower_slug || '/' || r.name,
       r.name,
       '/' || ns.lower_slug || '/' || r.name,
       r.description,
       r.updated_at
FROM repositories r
JOIN owner_namespaces ns ON (
  (ns.owner_type = 'user' AND ns.user_id = r.user_id) OR
  (ns.owner_type = 'org' AND ns.org_id = r.org_id)
)
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN organizations o ON o.id = r.org_id
WHERE r.is_public = TRUE
  AND r.is_archived = FALSE
  AND ((r.user_id IS NOT NULL AND u.deleted_at IS NULL AND u.is_active = TRUE)
       OR (r.org_id IS NOT NULL AND o.visibility = 'public'))
ORDER BY r.updated_at DESC, r.id DESC
LIMIT 100
`

func (q *Queries) ListPublicRepositoryCatalog(ctx context.Context) ([]PublicRepository, error) {
	rows, err := q.db.Query(ctx, listPublicRepositoryCatalog)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]PublicRepository, 0)
	for rows.Next() {
		var item PublicRepository
		if err := rows.Scan(&item.Name, &item.Title, &item.URL, &item.Summary, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
