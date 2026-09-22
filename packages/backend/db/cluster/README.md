`../product/sqlc.yaml` generates the canonical product queries and models in
`internal/db`. This directory contains only private cluster query blocks. Its
SQLC output is `internal/clusterdb`; shared table models alias `internal/db`
types so service interfaces do not acquire a second product DTO graph.

Product DDL is authored in `../product/migrations`, in version order. The
transitional private baseline is in `private_baseline.sql`. The placement
migrations here are snapshots of Plue's authored
`internal/clusterstorage/migrations`; `plue_sources.json` pins their exact
SHA-256 hashes. Edit the Plue sources, then sync with
`python3 packages/backend/db/generate_schema.py --plue-root /path/to/plue --sync-plue`.
The combined `../schema.sql` is generated, not authored. Run
`python3 packages/backend/db/generate_schema.py --check` in Smithers CI and
add `--plue-root /path/to/plue` in Plue CI to detect drift against the private
authority.

Run `python3 packages/backend/db/cluster/generate.py` after editing schema or
queries. It rebuilds the combined schema, removes stale generated query files,
runs both SQLC configs, and rewrites shared cluster models to aliases. It
requires sqlc v1.30.0 and goimports.

The `plue_storage` placement migrations are the hosted schema source for
routing; `repositories` has no `storage_set_id`. The older `public.repo_storage_*`
tables in `private_baseline.sql` are a transitional snapshot until the Plue
hosted cutover removes them.
