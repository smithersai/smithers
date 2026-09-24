# Go backend package ownership

This inventory is generated from `go list ./packages/backend/...`. Regenerate it whenever a package is added, moved, or deleted.

## Public packages

Hosts (the Smithers app, the native app, and Plue) import these packages.

- `packages/backend/app`
- `packages/backend/cli`
- `packages/backend/cmd/failurecodes`
- `packages/backend/db/product`
- `packages/backend/flowdispatch`
- `packages/backend/flowhost`
- `packages/backend/flowmanifest`
- `packages/backend/flowruntime`
- `packages/backend/jobs`
- `packages/backend/localbootstrap`
- `packages/backend/modelhost`
- `packages/backend/native`
- `packages/backend/ports`
- `packages/backend/postgres`
- `packages/backend/process`
- `packages/backend/repository`
- `packages/backend/runtimebridge`
- `packages/backend/webapp`
- `packages/backend/workspace`
- `packages/backend/workspaceconformance`

## Internal product packages

Only the packages above import these. Routes and services still pass some generated sqlc row and `pgtype` types across package boundaries; tracked in smithersai/smithers#1655.

- `packages/backend/internal/auth`
- `packages/backend/internal/blob`
- `packages/backend/internal/chat`
- `packages/backend/internal/cleanup`
- `packages/backend/internal/compose`
- `packages/backend/internal/config`
- `packages/backend/internal/configsync`
- `packages/backend/internal/credentialscan`
- `packages/backend/internal/database`
- `packages/backend/internal/db`
- `packages/backend/internal/diffview`
- `packages/backend/internal/email`
- `packages/backend/internal/identity`
- `packages/backend/internal/middleware`
- `packages/backend/internal/observability`
- `packages/backend/internal/ownership`
- `packages/backend/internal/pairauth`
- `packages/backend/internal/pkg/crypto`
- `packages/backend/internal/pkg/errors`
- `packages/backend/internal/repohost`
- `packages/backend/internal/repohostffi`
- `packages/backend/internal/repohostserver`
- `packages/backend/internal/revocation`
- `packages/backend/internal/routes`
- `packages/backend/internal/runbooks`
- `packages/backend/internal/services`
- `packages/backend/internal/services/alertregistry`
- `packages/backend/internal/services/workspace_scripts`
- `packages/backend/internal/smitherscli`
- `packages/backend/internal/sse`
- `packages/backend/internal/sseauth`
- `packages/backend/internal/testutil/postgresfixture`
- `packages/backend/internal/webhook`
- `packages/backend/internal/webhooks`

## Plue-only packages

These serve only the hosted deployment. They move into Plue behind the public ports, tracked in smithersai/smithers#1655.

- `packages/backend/internal/buildcache`
- `packages/backend/internal/clusterdb`
- `packages/backend/internal/clusterservices`
- `packages/backend/internal/deploymentdb`
- `packages/backend/internal/ironproxy`
- `packages/backend/internal/lfsauth`
- `packages/backend/internal/migrate`
- `packages/backend/internal/microsandbox`
- `packages/backend/internal/microsandbox/control`
- `packages/backend/internal/microsandbox/worker`
- `packages/backend/internal/previewgateway`
- `packages/backend/internal/runner`
- `packages/backend/internal/runner/client`
- `packages/backend/internal/runner/executor`
- `packages/backend/internal/sandbox`
- `packages/backend/internal/sandbox/guest`

## SQL ownership

`db/ownership.csv` lists every table with its owner and status. `db/product.Apply` applies the fresh-install product schema from `db/product/migrations` without Atlas, and product sqlc reads only that directory. Plue-owned tables are reached only through deployment ports and move with the Plue-only packages. The two Electric-era sync tables are excluded from the product schema; Plue keeps their historical data.
