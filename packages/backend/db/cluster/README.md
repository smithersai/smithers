`../product/sqlc.yaml` generates the canonical product queries and models in
`internal/db`. This directory contains only private cluster query blocks. Its
SQLC output is `internal/clusterdb`; shared table models alias `internal/db`
types so service interfaces do not acquire a second product DTO graph.

Run `python3 packages/backend/db/cluster/generate.py` after editing either
query set. The script removes stale generated query files, runs both SQLC
configs, and rewrites shared cluster models to aliases. It requires sqlc
v1.30.0 and goimports.

Private cluster migrations and placement data remain outside the product
baseline. In particular, `repositories` has no `storage_set_id`; private
placement is resolved by stable repository ID.
