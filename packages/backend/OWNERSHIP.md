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

`db/ownership.csv` lists every table from the copied schema, its intended owner, and extraction status. `infrastructure-seam` means the table is still present to preserve existing behavior but must move out of the product lineage before self-host release. `retire-candidate` marks Electric-era sync tables awaiting verification and removal. Product tables include the shared authorization, audit, admin, and optional billing state. Product/infra separation and a new baseline migration remain required; this checkpoint only moves ownership of the existing lineage.

Generated sqlc code stays private under `internal/db`. Routes and services currently expose several generated row/pgtype types; public DTO cleanup remains required.
