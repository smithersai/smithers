# Go backend extraction inventory

Source: `~/plue` working tree on 2026-09-21, parent `6d659ffe63424f0ca4ce870416a66a898b739bb0`; upstream `main` was `c623be5ebd2cff8dbbc3dee4acea526701a0a806`. The working tree included in-flight source changes.

The Smithers-owned copy is `packages/backend/internal` (Go services, routes, authorization, audit, repository host, generated sqlc, runtime dependencies), `packages/backend/db` (schema, SQL queries, migrations), and `packages/backend/internal/compose` (the original API assembly). `internal/pkg/{errors,crypto}` contains the original public utility packages. Plue's existing tree remains temporarily frozen until the cutover; it is not a second source of truth for new product changes. No package or table was retired in this extraction checkpoint.

## Package inventory

Every copied Go package is listed below. The admin route/service implementation is included under `routes` and `services`; alert registry and runbooks were copied with it.

- `packages/backend/internal/auth`
- `packages/backend/internal/blob`
- `packages/backend/internal/buildcache`
- `packages/backend/internal/cleanup`
- `packages/backend/internal/compose`
- `packages/backend/internal/config`
- `packages/backend/internal/configsync`
- `packages/backend/internal/credentialscan`
- `packages/backend/internal/database`
- `packages/backend/internal/db`
- `packages/backend/internal/diffview`
- `packages/backend/internal/email`
- `packages/backend/internal/infra`
- `packages/backend/internal/infra/alerts`
- `packages/backend/internal/ironproxy`
- `packages/backend/internal/lfsauth`
- `packages/backend/internal/microsandbox`
- `packages/backend/internal/microsandbox/control`
- `packages/backend/internal/microsandbox/worker`
- `packages/backend/internal/middleware`
- `packages/backend/internal/migrate`
- `packages/backend/internal/observability`
- `packages/backend/internal/ownership`
- `packages/backend/internal/pairauth`
- `packages/backend/internal/pkg/crypto`
- `packages/backend/internal/pkg/errors`
- `packages/backend/internal/previewgateway`
- `packages/backend/internal/repohost`
- `packages/backend/internal/repohostffi`
- `packages/backend/internal/repohostserver`
- `packages/backend/internal/revocation`
- `packages/backend/internal/routes`
- `packages/backend/internal/runbooks`
- `packages/backend/internal/runner`
- `packages/backend/internal/runner/client`
- `packages/backend/internal/runner/executor`
- `packages/backend/internal/sandbox`
- `packages/backend/internal/sandbox/guest`
- `packages/backend/internal/services`
- `packages/backend/internal/services/alertregistry`
- `packages/backend/internal/services/workspace_scripts`
- `packages/backend/internal/smitherscli`
- `packages/backend/internal/sse`
- `packages/backend/internal/sseauth`
- `packages/backend/internal/ssh`
- `packages/backend/internal/webhook`
- `packages/backend/internal/webhooks`
- `packages/backend/internal/wsrunner`

## SQL inventory

`db/ownership.csv` lists every table from the copied schema, its owner, and extraction status. All 46 infrastructure-seam tables are classified `private`: Plue owns their SQL and the public composition must reach them through deployment ports. The two Electric-era sync tables are `retired` for fresh installs; historical Plue data remains until a separate retention decision. Product tables include shared authorization, audit, admin, and optional billing state. The fresh-install product baseline is `db/product/migrations/0001_product_baseline.sql` and is applied by `db/product.Apply` without Atlas. It contains 168 product tables plus its migration ledger and excludes the 46 private and two retired tables. Generated cluster queries remain transitional public-module code pending L9's package move. Product sqlc reads only `db/product/migrations`.

Generated sqlc code stays private under `internal/db`. Routes and services currently expose several generated row/pgtype types; public DTO cleanup remains required.
