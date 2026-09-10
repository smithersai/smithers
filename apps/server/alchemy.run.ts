/**
 * The Alchemy 2 stack for `smithers-mvp-web`. Importing it deploys nothing.
 *
 *   bun scripts/deploy.ts                 # site build + preflight + `alchemy deploy`
 *   bun scripts/deploy.ts --dry-run       # site build + `alchemy plan`
 *   bun node_modules/alchemy/bin/alchemy.ts plan --stage prod
 *
 * Always run the CLI under bun, on its own TypeScript entry.
 * `node_modules/.bin/alchemy` is a launcher (alchemy bin/cli.js:98-116) that
 * re-execs under bun only when `npm_execpath` contains "bun" or
 * `npm_config_user_agent` starts with "bun/", and under node otherwise; node
 * cannot resolve the extensionless imports this package uses, so it dies with
 * `Cannot find module .../src/Worker imported from alchemy.run.ts`. Neither
 * `bun scripts/deploy.ts` nor `pnpm run …` sets those variables.
 *
 * `alchemy plan` evaluates the stack and prints what it would reconcile; it
 * needs no Cloudflare credential and does not read the live script, so it
 * always plans a `create` from empty local state. The adoption verdict comes
 * from `bun scripts/adopt-durable-objects.ts`, never from the plan.
 *
 * The Worker (src/Worker.ts) is the one resource. Its physical name is pinned
 * by the `name` prop, so the stack name and the stage below only namespace
 * Alchemy's state and ownership tags; `--stage prod` is what scripts/deploy.ts
 * passes and what DEPLOY.md documents. A different stage would still deploy
 * to the same physical script, which is why the scripts never let it vary.
 *
 * State store: `Alchemy.localState()`, i.e. `.alchemy/state/` under this
 * directory (gitignored at the repo root). The alternative,
 * `Cloudflare.state()`, deploys and owns an extra `alchemy-state` Worker in
 * the account and writes a credentials file; this stack has one Worker and
 * one operator path, so the extra resource buys nothing yet. Local state is
 * safe to lose: a Worker carrying this stack's ownership tags reads back as
 * owned on an empty state (WorkerProvider.ts:5027-5035), and the domain and
 * the route are reconciled from live listings rather than from state
 * (WorkerProvider.ts:1393, :1929-1932). scripts/deploy.ts passes `--adopt`
 * for the same reason. Revisit `Cloudflare.state()` when more than one
 * machine deploys and shared locking matters.
 *
 * Credentials: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the
 * environment (or an `alchemy login` profile). Secrets: every name in
 * `WORKER_IDENTITY.secrets` (src/workerIdentity.ts) present in the deploying
 * shell; an absent one is not deployed. DEPLOY.md has the full procedure.
 */
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import worker from "./src/Worker"
import { WORKER_IDENTITY } from "./src/workerIdentity"

export default Alchemy.Stack(
  WORKER_IDENTITY.stack,
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  worker
)
