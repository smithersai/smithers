# Deploying `smithers-mvp-web`

The deployable is one Cloudflare Worker, `smithers-mvp-web`, serving the
smithers.sh Astro build (`apps/site`, which prerenders the product app at
`/<owner>/<name>` as a React island) as static assets and the `/api` seams. The
legacy raw gateway proxy is removed (see the 1.0 migration below). The canary
Worker uses `canary.smithers.sh`.

The Worker is deployed with Alchemy 2 (`alchemy@2.0.0-beta.76`, pinned in
`package.json`): `alchemy.run.ts` files the Effect-native Worker in
`src/Worker.ts` under a Stack, and `scripts/deploy.ts` runs it. `wrangler.jsonc`
stays checked in as the **adoption bridge**: it describes the Worker exactly as
Wrangler last deployed it, and `src/workerIdentity.test.ts` holds it to
`src/workerIdentity.ts`, the object `src/Worker.ts` deploys from. Nothing runs
Wrangler any more; the file is evidence, not configuration. `docs/EFFECT.md`
describes the Worker's composition.

## Run the Alchemy CLI under bun, always

```sh
cd apps/server
bun node_modules/alchemy/bin/alchemy.ts plan --stage prod     # right
./node_modules/.bin/alchemy plan --stage prod                 # wrong: runs under node
```

`node_modules/.bin/alchemy` is a launcher, not the CLI. It re-execs the CLI
under bun only when `npm_execpath` contains `bun` or `npm_config_user_agent`
starts with `bun/`, and under node otherwise (`alchemy bin/cli.js:98-116`).
This package's modules import each other without file extensions
(`./src/Worker`, `./index`) — a bundler convention node's ESM resolver does
not implement — so the node path dies before it reads a single resource:

```
ERROR (#1): Error: Cannot find module '/…/apps/server/src/Worker'
  imported from /…/apps/server/alchemy.run.ts
```

`bun scripts/deploy.ts` sets neither variable, and `pnpm run …` sets them to
pnpm, so `scripts/deploy.ts` and the `deploy:plan` package script spawn `bun`
on `node_modules/alchemy/bin/alchemy.ts` directly. Do the same by hand.

## Frozen identity — read this before touching `src/workerIdentity.ts`

The Worker's `name` (`smithers-mvp-web`), its custom domain
(`canary.smithers.sh`), its apex route, and its five Durable Objects are
deliberately frozen in `src/workerIdentity.ts` (`WORKER_IDENTITY`), and
`src/workerIdentity.test.ts` pins every field:

- Five Durable Objects (`TURN_CANCELS`, `GATEWAY_SESSIONS`, `TURN_LIMITS`,
  `CLIENT_ERRORS`, `RECOMMEND_LOG`; classes `TurnCancelRegistry`,
  `GatewaySessionRegistry`, `TurnRateLimiter`, `ClientErrorLog`,
  `RecommendLog`) hold state keyed to this Worker's identity. Renaming the
  Worker, or deploying under a different name, creates a **fresh** Worker
  with **fresh, empty** Durable Object storage: the existing state is
  orphaned, not migrated. Renaming a class or a binding is a migration; on
  the adopting deploy it is data loss (next section).
- The `canary.smithers.sh` custom domain and the `smithers.sh/*` zone route
  follow whichever Worker declares them. Changing or removing either detaches
  it from this Worker.

Never edit `WORKER_IDENTITY.name`, `domain`, `routes`, or `durableObjects` as
part of a routine deploy. If the identity or domain genuinely needs to change,
that is a separate, deliberate decision, recorded in the cutover log below and
in the test, never a side effect of a deploy.

One such deliberate change is on record. The product for a repository lives at
`https://smithers.sh/<owner>/<name>`, so `routes` also carries a zone route
beside the canary custom domain. It began as three narrow routes
(`smithers.sh/smithersai/*`, `smithers.sh/api/*`, `smithers.sh/assets/*`, zone
`8ebd98d2f0dc7d8db2e61f31ebc19c14`) while `smithers.sh` itself was a separate
assets-only Worker; since this Worker serves the whole site build, one route,
`smithers.sh/*`, claims every apex path (see the cutover log below).
`runWorkerFirst` lists `/smithersai/*` so the Worker, not the assets layer,
answers a repository path: a catalog repository serves the app document and
any other path under that owner redirects to `https://smithers.sh/`. It also
lists every coming-soon owner, in GitHub case and in lowercase, so a
coming-soon path in any repository case serves its prerendered page
(PUBLIC-REPOSITORIES.md, `COMING_SOON_WORKER_FIRST`). The
Worker name and the canary domain are unchanged, so Durable Object state is
unaffected. Rollback is to delete the zone route and deploy;
`canary.smithers.sh` keeps serving throughout.

The second deliberate change is the assets directory. `assets.directory` is
`../site/dist`, the smithers.sh Astro build, instead of `../ui/dist`, the
app's own Vite build, and `notFoundHandling` is `404-page` instead of
`single-page-application`: the app is a prerendered page of that build at
`/<owner>/<name>/index.html`, so one build is deployed instead of two. The
Worker fetches that page from the assets layer for a catalog repository path
and for a frame path (`/w/<workspace>/b/<branch>/f/<frame>`, listed in
`runWorkerFirst` as `/w/*`) and adds the isolation headers; every other path
passes through as the site serves it, and the canary hostname marks HTML
`noindex`. The `/_astro/*` chunks carry `Cross-Origin-Embedder-Policy:
require-corp` and `Cross-Origin-Resource-Policy: same-origin` from the build's
own `apps/site/public/_headers`, because the app's OPFS SQLite module worker is
one of those chunks and a browser refuses a worker script whose embedder policy
is weaker than its owner document's (`net::ERR_BLOCKED_BY_RESPONSE`, then a
silent fall back to localStorage). `scripts/canary/site-probe.ts` grades one
such chunk on every deploy. The name, routes, Durable Objects and migrations are
untouched (`src/workerIdentity.test.ts` pins them), so state is unaffected.
Rollback: restore `directory: "../ui/dist"` and `notFoundHandling:
"single-page-application"`, build `apps/app` (`bun run build:web`) and deploy,
or roll the Worker back to the prior version id from the last receipt (see
"Rollback" below); the assets travel with the version, so the rollback
restores the previous build without a rebuild.

### Cutover log

Every deliberate change to the frozen identity, newest last, with its
rollback. `src/workerIdentity.test.ts` and `src/index.test.ts` pin the current
state, so a new entry here lands in the same commit as the test change.

- Three apex zone routes (`smithers.sh/smithersai/*`, `/api/*`, `/assets/*`)
  added beside the canary custom domain so the product lives at
  `smithers.sh/<owner>/<name>`; rollback = delete the routes and deploy.
- Assets directory moved from `../ui/dist` (SPA) to `../site/dist` (the
  smithers.sh Astro build, `404-page`); rollback = restore both fields, build
  `apps/app`, deploy, or roll back to the prior version id.
- Apex route `smithers.sh/*` added on 2026-09-07 so one Worker serves every
  apex path. The three narrow routes left every other apex path, `/_astro/*`
  included, to the old assets-only Worker `smithers-site-v1` through its
  custom domain, so the app page HTML came from the new build and its
  `/_astro` chunks from the old one (404). A zone route takes precedence over
  a custom domain on the same hostname (the live `/api/*` route proved it).
  Rollback = restore the three narrow routes and deploy (seconds).
  `smithers-site-v1` still holds the apex custom domain as the fallback until
  it is retired.
- Deploy tool moved from Wrangler to Alchemy 2 (2026-09-09). The identity is
  byte for byte the same; what changes on the account is the script's tags
  (Alchemy ownership + `alchemy:dos:` binding map), its migration tag (`v4` →
  `alchemy:v5`, no class changes), its binding set (rebuilt from
  `src/Worker.ts`, see "Secrets"), and observability (Alchemy enables Workers
  Logs unless told otherwise). Rollback = `wrangler rollback <prior version
  id>` (the versions Alchemy uploads are ordinary Worker versions), or a
  Wrangler deploy from `wrangler.jsonc`, which then needs its own `--adopt`
  the next time Alchemy deploys.

## The adopting deploy (first `alchemy deploy`; read before running it)

The live script was deployed by Wrangler and carries no Alchemy ownership
tags, so Alchemy's `read` reports it `Unowned` and the deploy needs `--adopt`
(alchemy `WorkerProvider.ts:5027-5035`). On that deploy Alchemy has no
`alchemy:dos:` tag mapping bindings to classes, so it matches each Durable
Object binding it declares to the live one **by binding name** and reuses the
live class (`WorkerProvider.ts:3445-3474`). The consequences, each of which is
Durable Object data loss:

| Declared vs live | What Alchemy uploads | Effect |
| --- | --- | --- |
| binding name absent live | `new_sqlite_classes: [class]` (`:3514`) | a fresh, empty namespace |
| live binding absent from the declaration | `deleted_classes: [class]` (`:3310-3331`, applied at `:3377-3392`) | the namespace and its storage are deleted |
| same binding, different class name | `renamed_classes` (`:3515-3519`) | a class rename, unwanted |

`src/Worker.ts` keeps BOTH names as they are. The class-form
`Cloudflare.DurableObject<Self>()("Name")` would have forced binding name ==
class name (`DurableObject.ts:1148-1153`, `:1251`), so the Worker instead
declares each binding with the props form
`Cloudflare.DurableObject("TURN_CANCELS", { className: "TurnCancelRegistry" })`
and registers each class body with `worker.export("TurnCancelRegistry", …)`;
the bundle's generated entry exports one class per export key
(`Sources/Rolldown.ts:211-262`; the emitted line is
`export class <key> extends DurableObjectBridge("<key>") {}` at `:251`, and
the key is what `worker.export(name, …)` stored at
`WorkerRuntimeContext.ts:78-81`). `docs/EFFECT.md` has the details.

The migration tag: Cloudflare rejects an upload whose `old_tag` is not the
script's current tag (`v4`). Alchemy reads the expected tag out of that error
and re-uploads with `old_tag: "v4"` and `new_tag: "alchemy:v5"`
(`WorkerProvider.ts:3707-3747`, `bumpMigrationTagVersion` at `:5404-5410`).
The retry carries the SAME class lists as the first attempt — the recovery
only fixes the tag — so this is safe exactly when the reconciliation above
found nothing to create, rename or delete. That is what the preflight proves.

The retry is also what makes the preflight non-optional: a wrong binding name
does not fail the upload, it succeeds with a `new_sqlite_classes` or
`deleted_classes` migration attached.

### Procedure

1. Export the credentials and every secret (next section). Nothing here
   prints a value.
2. Preflight, read-only:
   ```sh
   cd apps/server
   CLOUDFLARE_API_TOKEN=<token> bun scripts/adopt-durable-objects.ts
   ```
   It reads the live script settings, domains, routes, and subdomain state and
   compares them with `src/workerIdentity.ts` and `wrangler.jsonc`. Every
   `FAIL` is a Durable Object mismatch, a frozen var drift, a compatibility
   drift, or a route held by another Worker; it exits 1 and the deploy script
   refuses to continue. Every `WARN` names something the deploy will change
   (a secret, knob or var it will drop, a route it will remove, a workers.dev
   toggle). Read them all. Verified read-only on 2026-09-10 against the live
   script: `GREEN: 0 fail, 11 warn` — all five bindings match live by name and
   class, the five frozen vars match, `canary.smithers.sh` and `smithers.sh/*`
   are attached to this script, `workers.dev` is off, compatibility is
   `2026-08-01 [nodejs_compat]`, and the script carries no `alchemy:*` tag, so
   this is still the adopting deploy. The eleven warnings are the eleven live
   secrets not exported in that shell (ten declared, plus the undeclared
   legacy `RECO_ADMIN_TOKEN`), each of which the deploy would drop.
3. Plan, read-only:
   ```sh
   pnpm run deploy:dry     # site build + `alchemy plan --stage prod`
   ```
   The plan **evaluates the program, not the account**: it loads
   `src/Worker.ts`, runs the init closure (registering the five Durable Object
   exports and reading every `Config` this shell exports) and prints the
   resources and bindings it would reconcile. It needs no Cloudflare
   credential and it does not read the live script — the live read, and with
   it the adoption, happens during apply. From an empty local state it
   therefore always prints `Plan: 1 to create`, with the ten bindings named:

   ```
   Plan: 1 to create
   [smithers-mvp-web] create
   [smithers-mvp-web/CLIENT_ERRORS] create
   [smithers-mvp-web/GATEWAY_SESSIONS] create
   [smithers-mvp-web/RECOMMEND_LOG] create
   [smithers-mvp-web/TURN_CANCELS] create
   [smithers-mvp-web/TURN_LIMITS] create
   …the five plain vars…
   ```

   Read it for the binding NAMES (the five Durable Objects under
   `TURN_CANCELS`, `GATEWAY_SESSIONS`, `TURN_LIMITS`, `CLIENT_ERRORS`,
   `RECOMMEND_LOG`, never under their class names) and for the absence of a
   binding you did not declare. `create` here is not a claim about the live
   script and never a verdict on the adoption; step 2 is the verdict.
4. Deploy:
   ```sh
   CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=dd3525a4132493566aeb38de533c8827 pnpm --filter smithers-server run deploy
   ```
   `scripts/deploy.ts` runs the preflight again, then `alchemy deploy --stage
   prod --adopt --yes`, then reads the live version id back and writes the
   receipt.
5. Verify: `bun scripts/canary/build-probe.ts https://canary.smithers.sh --sha
   <gitSha from the receipt>`, then a signed-in turn (the
   `TURN_CANCELS`/`TURN_LIMITS` path), `GET /api/admin/errors` and
   `GET /api/admin/recommend/log` as an admin (the `CLIENT_ERRORS` and
   `RECOMMEND_LOG` namespaces still answer with their history), and a
   workflow provision (`GATEWAY_SESSIONS`). Empty logs that were not empty
   before the deploy mean a namespace was recreated: roll back at once
   (below) and read the preflight output again.

The stage is always `prod`. The physical name comes from the `name` prop, so
another stage would deploy to the same script under a different set of
ownership tags; the scripts never let it vary.

## Secrets: every one is declared in `src/Worker.ts` and supplied at deploy time

An Alchemy upload replaces the script's bindings wholesale
(`metadata.keepBindings: undefined`, `WorkerProvider.ts:3584`). A secret that
was set with `wrangler secret put` and is not present in the deploying shell is
**dropped by the deploy**, and its route answers its honest 501/503 until the
next deploy supplies it. `wrangler secret put` is no longer a way to set one.

`src/Worker.ts` yields each name below as `Config.option(Config.redacted(name))`
in its init phase. At plan time Alchemy records the value as a `secret_text`
binding under the same name; at runtime the same yield reads it back. Export
them all in the deploying shell (CI: repository secrets), with the same values
the live script holds:

| Name | Spent by |
| --- | --- |
| `SMITHERS_CHAT_AUTH_TOKEN` | the chat forward (`POST /api/agent/turn`) |
| `CHAT_PRODUCT_SERVICE_TOKEN` | vouching the validated login to chat |
| `IDENTITY_SERVICE_TOKEN` | `/api/identity/validate` |
| `IDENTITY_ADMIN_TOKEN` | `POST /api/admin/allowlist`, `GET /api/admin/requests` |
| `BILLING_AUTH_TOKEN` | the signed-out billing fallback |
| `BILLING_PRODUCT_SERVICE_TOKEN` | billing reads as the user |
| `BILLING_ADMIN_TOKEN` | `POST /api/admin/grant` |
| `ANONYMOUS_TURN_SALT` | the anonymous turn buckets |
| `CEREBRAS_API_KEY` | `POST /api/recommend` |
| `SMITHERS_GITHUB_APP_ID` | the GitHub App JWT (`src/githubApp.ts`) |
| `SMITHERS_GITHUB_APP_PRIVATE_KEY` | the GitHub App JWT (PEM, PKCS#1 or PKCS#8) |
| `GITHUB_TOKEN` | optional override of the App for catalog stats |

Optional knobs, read the same way when set: `SMITHERS_BUILD_SHA` (set by
`scripts/deploy.ts` to the sha it stamped the site with), `UPSTREAM_TIMEOUT_MS`,
`BILLING_CHECKOUT_ENABLED`, `CEREBRAS_MODEL`, `CEREBRAS_MODEL_LIBRARIAN`,
`CEREBRAS_MODEL_FLOWS`. Each is dropped by a deploy that does not export it,
exactly like a secret. The frozen vars (`IDENTITY_UPSTREAM_URL`,
`BILLING_UPSTREAM_URL`, `SMITHERS_CLOUD_API_BASE_URL`, `SMITHERS_CHAT_URL`,
`SMITHERS_CHAT_ORIGIN`) live in `WORKER_IDENTITY.vars` as literal strings in
the Worker's `env` props and deploy as `plain_text`.

**A knob deploys as a secret, not as a var.** Alchemy's ConfigProvider
interceptor records EVERY `Config` a Worker's init phase reads as
`Output.literal(Redacted.make(value))` (`Platform.ts:572-577`), the runtime
context keeps the `Redacted` wrapper on the outside
(`WorkerRuntimeContext.ts:48-57`), and a `Redacted` binding lowers to
`secret_text` (`WorkerAsyncBindings.ts:366-373`). `Config.string` gets the same
treatment as `Config.redacted`, so after the first Alchemy deploy
`SMITHERS_BUILD_SHA` and the four model knobs appear on the live script as
secrets. Nothing about the Worker changes — the same `Config` reads them back
— but the dashboard shows them as encrypted, and the preflight reports them
under `knob <NAME>` rather than `var <NAME>`.

Because a Config-bound value reaches the isolate packed as
`{"_tag":"Redacted","value":…}` (`RuntimeContext.ts:100-114`), `src/Worker.ts`
never reads a secret out of the raw `env` bag: it overlays the values it
resolved through `Config` onto `Cloudflare.WorkerEnvironment` before handing
the bag to `layersFromEnv`.

The preflight lists every live secret and knob by name with `present in this
shell` or `DROPS`, and never a value. **A declared secret or knob that is live
but missing from the deploying shell is a `FAIL`**, so `scripts/deploy.ts`
refuses to continue: dropping one is an outage of the route it feeds, not a
note. Retiring one on purpose is
`bun scripts/adopt-durable-objects.ts --allow-secret-drop`, which downgrades it
to a warning and says so in the output. An UNDECLARED live secret stays a
warning: a name outside `src/workerIdentity.ts` feeds nothing the Worker reads,
so it cannot be exported into a declared slot and is meant to go (the legacy
`GATEWAY_*` names and `RECO_ADMIN_TOKEN`; see "1.0 gateway migration").

### CI carries the same list

`.github/workflows/apps-deploy.yml`'s "Deploy (real)" step must export every
name above as `${{ secrets.NAME }}`; the step is hand-maintained (only
actionlint runs over it) and `scripts/deploy-docs.test.ts` fails if it drifts
from `src/workerIdentity.ts`. Two deliberate exceptions:

- `SMITHERS_BUILD_SHA` is not exported. `scripts/deploy.ts` computes it from
  the commit it stamped the site with and passes it to Alchemy itself.
- `GITHUB_TOKEN` is bound to the repository secret
  `SMITHERS_CATALOG_GITHUB_TOKEN`, never to `${{ secrets.GITHUB_TOKEN }}`.
  That one is the job's own ephemeral Actions token: deploying it would put a
  credential that expires within the hour into the Worker, where it overrides
  the working GitHub App for the public catalog.

### The state store holds these in cleartext

`Alchemy.localState()` writes the deployed resource graph — including every
secret the deploy read through `Config` — to `apps/server/.alchemy/state/`
unencrypted (alchemy `StateEncoding.ts:71-91`). After a real deploy that
directory is a credential file: `apps/server/.gitignore` excludes `.alchemy/`,
and a shared or backed-up machine should treat it the way it treats
`~/.cloudflare` or a `.env`. Deleting it is safe — the next deploy re-adopts
from the live script's ownership tags — and is the cheapest way to stop
holding the secrets locally.

**Four of these reach a Durable Object, not just the router.** The gateway
registry mints the Cloud token and provisions the workspace inside the object
(`POST /resolve`, `src/gateway.ts`), so `IDENTITY_UPSTREAM_URL`,
`IDENTITY_SERVICE_TOKEN`, `SMITHERS_CLOUD_API_BASE_URL` and
`UPSTREAM_TIMEOUT_MS` are read by `GatewaySessionRegistry`'s own
`ServerConfig`. `src/Worker.ts` therefore builds the deployment bag first and
registers the Durable Object exports from it
(`durableObjectClasses(deployment)`); a registry built over an empty bag
answers every resolution `unavailable: IDENTITY_UPSTREAM_URL is unset on this
deployment.` and takes `/api/workflow/*` down without failing a router test.
`src/Worker.test.ts` pins the wiring.

## Scripted deploy (this repo's one repeatable path)

The app's loading shell says that the session is starting until identity has
actually answered. The browser startup watchdog allows 60 seconds for cold
bundles, saved state and identity; its recovery panel leaves React's mount
point intact so a late successful boot can dismiss the panel and continue.
`apps/app/e2e/playwright/startup.spec.ts` holds the boot bundle past that
deadline and checks recovery without resetting saved data.

`scripts/deploy.ts` prepares the Electrobun devkit projection the island's
sources are typed against (`node scripts/ensure-devkit.mjs` in `apps/app`),
builds the site (`pnpm run build` in `apps/site`, stamped with the sha it
records), runs the adoption preflight, then `alchemy deploy --stage prod
--adopt --yes`, reads the live version id back, and writes a receipt (git sha
+ UTC timestamp + Cloudflare version id) to `deploy-receipts/`.

```sh
# Dry run: real site build, then `alchemy plan --stage prod`. The plan
# evaluates the stack (Worker module + init closure + declared bindings) and
# needs no Cloudflare credential; it does not read the live script, so it is
# not the adoption verdict. Nothing published. Receipt lands in
# deploy-receipts/dry-run/.
pnpm run deploy:dry            # from the repo root
# or, equivalently:
pnpm --filter smithers-server run deploy:dry

# Real deploy — requires a Cloudflare credential (see below). Receipt lands
# in deploy-receipts/.
pnpm --filter smithers-server run deploy
```

`--adopt` is passed on every real deploy: the state store is local
(`.alchemy/state/`, gitignored), so a fresh checkout has none, and a Worker
carrying this stack's ownership tags reads back as owned regardless
(`WorkerProvider.ts:5027-5035`). `alchemy.run.ts` explains the state-store
choice.

## Credentialed human run

1. **Secret required:** `CLOUDFLARE_API_TOKEN` (a Cloudflare API token scoped
   to the `dd3525a4132493566aeb38de533c8827` account, Workers Scripts + Workers
   Routes + Zone DNS edit permissions; Alchemy also accepts an `alchemy login`
   profile). Export it in the shell running the deploy.
2. **Account id required:** `CLOUDFLARE_ACCOUNT_ID=dd3525a4132493566aeb38de533c8827`.
   Alchemy reads it from the environment; `scripts/deploy.ts` defaults it to
   `WORKER_IDENTITY.accountId` when unset.
3. **Every secret above** exported in the same shell.
4. **Build + deploy:**
   ```sh
   CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=dd3525a4132493566aeb38de533c8827 pnpm --filter smithers-server run deploy
   ```
5. **Verify:** the receipt file's path is printed
   (`apps/server/deploy-receipts/latest.json`). Confirm
   `https://canary.smithers.sh` serves the new build (check a UI string you
   just changed, or the receipt's version id against
   `bun scripts/canary/rollback-probe.ts`).

### CI (tag-triggered)

`.github/workflows/apps-deploy.yml` runs the same script on push of a tag
matching `apps-v*` (e.g. `apps-v0.1.0`). It only attempts a real deploy when
the `CLOUDFLARE_API_TOKEN` repository secret is configured; otherwise (and
always for a manual `workflow_dispatch` run) it runs the dry-run path, which
plans without a credential. Set the secret, the account id, and every
Worker secret above in the repo's Settings → Secrets and variables → Actions
before cutting a tag that should actually publish; a missing Worker secret is
dropped from the deployment, not skipped.

## The seams this Worker proxies

### 1.0 gateway migration

The deployment-identity gateway proxy has been removed. `/rpc`, `/projections`,
`/sync`, `/health` and their subpaths return HTTP 410 with
`code: "gateway_proxy_removed"`, including WebSocket upgrade requests. They
never forward under a deployment bearer or a placeholder user. Cross-origin
requests may be refused earlier by the existing same-origin guard.

`GATEWAY_UPSTREAM_URL`, `GATEWAY_AUTH_TOKEN` and
`GATEWAY_SESSION_USER_ID` / `_ROLE` / `_SCOPES` no longer configure this Worker.
Remove leftover legacy secrets when deploying the new version; they are ignored
and cannot reactivate the proxy (the Alchemy deploy drops any secret it does
not declare, so they go on the adopting deploy). This is a breaking removal,
not an optional hardening flag. A deployment identity is not evidence of an
incoming user's authority to use a workspace.

Product clients use `/api/workflow/provision` and `/api/workflow/rpc`. These
require a validated, allowlisted session, obtain the user's Cloud identity,
resolve gateway records by that login and repository, and apply the relay's
procedure/path allowlist. Gateway tokens remain server-side in
`GATEWAY_SESSIONS`; client-supplied identity headers cannot select another user.
Keep the identity and per-user Cloud gateway configuration described in
`src/workerIdentity.ts`. Clients needing the gateway's native RPC/WebSocket
protocols must connect to a separately authenticated gateway, not to these
retired mounts.

The local launch/canary scripts now assert the explicit retirement response.
Their expectations should ship with this Worker version; they are not evidence
that any existing deployment has already been updated.

### Other upstream services

Sign-in, balance, chat turns, and recommendations resolve in sibling
Workers that live in a different repository (`smithersai/ui`, under
`workers/`).
Deploying this Worker does not deploy them, and a broken sign-in is more
often theirs than ours. `apps/UPSTREAMS.md` names each one, its source, its
hostname, and how to deploy it with a receipt.

### Command suggestions need a Cerebras key

`POST /api/recommend` asks Cerebras (`gpt-oss-120b`, 6 s deadline) which of
the user's commands to suggest next, and `POST /api/recommend/outcome` records
what the user ran. Both are open to signed-out visitors under their own daily
ceilings (300 per address or login, 5000 deployment-wide). The route needs:

- `CEREBRAS_API_KEY` (secret, exported in the deploying shell). Unset, the
  route answers `503` and the app keeps its rule-based pills; nothing is
  invented.
- `RECOMMEND_LOG` (Durable Object binding, `WORKER_IDENTITY.durableObjects`,
  Wrangler migration `v4`). One row per recommendation, a ring of the newest
  5000, holding a SHA-256 of the chat tail and never the text. Admins read it
  at `GET /api/admin/recommend/log?limit=N`, newest first, to score hit rate
  and top-1 rate.

`CEREBRAS_MODEL` (knob, optional) overrides the model id.

### The public catalog's GitHub stats authenticate as a GitHub App

`GET /api/public/repos` reads each catalog repository's stars, forks, and open
issue count from `api.github.com`, one request per repository per cache
refresh, and caches the catalog for five minutes. GitHub allows an
unauthenticated address 60 requests an hour, so a busy hour or a shared egress
address can trip the limit and every landing-page card then shows "Stats
unavailable" until the limit resets.

Those reads authenticate as the GitHub App **`smitherspreviewrelease`** (app id
`4163546`, owned by the `smithersai` organization, installed on that org with
every repository selected), not as anyone's personal access token. The App
credential belongs to the organization, its installation token expires in an
hour, and it can be rotated without touching a person's account. `src/githubApp.ts`
signs a 9-minute RS256 JWT with WebCrypto, calls `GET /app/installations` to
find the `smithersai` installation, exchanges the JWT for an installation
token at `POST /app/installations/{id}/access_tokens`, and holds that token for
55 minutes in the isolate and in the Cache API under a private URL, so a cold
isolate does not exchange again. One `401` on a stats read buys exactly one new
token.

- `SMITHERS_GITHUB_APP_ID` (secret, **set on the live script** as of
  2026-09-08, so it must be exported for the adopting deploy): the numeric
  app id.
- `SMITHERS_GITHUB_APP_PRIVATE_KEY` (secret, **set on the live script** as of
  2026-09-08, same rule): the App's PEM private key, stored exactly as GitHub
  issues it — PKCS#1, `-----BEGIN RSA PRIVATE KEY-----`. The Worker wraps
  that DER in a PKCS#8 `PrivateKeyInfo` before `crypto.subtle.importKey`, so
  no `openssl` conversion is needed; a PKCS#8 key (`-----BEGIN PRIVATE
  KEY-----`) is imported directly.
- `GITHUB_TOKEN` (secret, optional): an **override**. Set, it is sent as the
  bearer and no App exchange happens at all — a fine-grained or classic token
  with no scopes, since every catalog repository is public. Unset, the App
  credential is used. With neither, the reads go unauthenticated.

Every App failure is honest and lands on the anonymous read the catalog has
always had, never a thrown stats route. One warning line names the cause, and
the failure is remembered for five minutes so a broken secret cannot turn every
refresh into two more GitHub calls:

| What went wrong | The line in the Worker's logs |
| --- | --- |
| The App is installed on no organization | `the GitHub App is not installed on any organization` |
| The private key does not import | `the GitHub App private key could not be imported` |
| GitHub refused the lookup or the exchange | `the GitHub App installation lookup answered <status>` / `... token exchange answered <status>` |

The private key, the JWT, and the installation token never enter a log line, a
response body, or a cache key; they leave the Worker only inside the GitHub
request's authorization header.

A 403 or 429 from GitHub nulls that repository's stats and keeps the normal
five-minute cache, so the Worker never retries into a tripped limit. Only a
network error or a 5xx shortens the cache to 30 s.

### The canary and e2e suites sign in as a scoped-down user

The probes that authenticate must hold a plain visitor's session, not an
operator's. Will's ruling (Factory spec 2026-09-08, `review/RULINGS.md` 35):
open sign-in is on and the permission tiers behind it stay deliberately narrow,
so the canary and e2e suites run as a scoped-down signed-in user and prove the
product works under the permissions a real visitor has. A probe holding an
admin's cookie is green while the deployment refuses everyone else, which is
the permission bug the probe exists to surface.

**The account.** `codeplanesmithers` is the shared test account, and it is a
scoped-down one: a plain GitHub login that must NOT appear in the identity
Worker's `ADMIN_LOGINS`, must NOT hold a maintainer claim on any repository,
and must NOT appear on the hand-seeded closed-alpha roster
`CANARY_ALLOWLIST_LOGINS`. It signs the browser sign-in probe in
(`apps/app/e2e/probes/signin-roundtrip.mjs`, `$SMITHERS_E2E_USER`), it is the
login the T1 Playwright doubles answer with
(`apps/app/e2e/playwright/identity.ts`), and its session is what
`$CANARY_SESSION_COOKIE` carries.

| Variable | Kind | What it names |
| --- | --- | --- |
| `SMITHERS_E2E_USER` | repository variable, and an env var for the browser probe | the scoped-down account's GitHub login; default `codeplanesmithers` |
| `CANARY_SESSION_COOKIE` | secret, `Canary` workflow | that account's signed-in cookie header, sent on the hourly tick only |
| `CANARY_SESSION_LOGIN` | repository variable, optional | the login `$CANARY_SESSION_COOKIE` must belong to; falls back to `SMITHERS_E2E_USER` |
| `CANARY_ALLOWLIST_LOGINS` | repository variable | the hand-seeded closed-alpha roster; `invite-probe.ts` reads it back, and `uptime-probe.ts` refuses a cookie belonging to one of those logins |

**The assertion.** `uptime-probe.ts` reads its own session back through
`GET /api/auth/session` before it spends anything. It fails the run, taking no
metered turn at all, when the session carries the `admin` claim, belongs to a
login on `CANARY_ALLOWLIST_LOGINS`, is not the declared account, or
authenticated nobody. When the deployment states no `admin` field and no login
is declared, the check fails rather than guess, and says to set
`CANARY_SESSION_LOGIN`. Rotating the cookie into an operator's account
therefore reddens the canary instead of quietly passing on privileges no
visitor has.

**The one probe that needs admin.** `scripts/canary/invite-probe.ts` reads and
writes the allowlist, so it needs the identity Worker's admin credential. It
declares that credential by its own name, `IDENTITY_ADMIN_TOKEN`, and prints a
`skip:` line naming the missing variable rather than running under some other
identity. Any future probe of an admin surface follows that shape: a separate,
named credential and an honest skip, never a shared privileged session.

## Rollback

Cloudflare Workers keep prior versions, and the versions Alchemy uploads are
ordinary Worker versions, so Wrangler's rollback still applies. To roll back
to the version recorded in an older receipt:

```sh
bun x wrangler@4.124.0 rollback --message "rollback to <git sha from receipt>"
```

run from `apps/server`, with the same `CLOUDFLARE_API_TOKEN` set. This
targets the immediately-prior version; for a specific historical version, use
`bun x wrangler@4.124.0 deployments list` to find its Version ID and
`bun x wrangler@4.124.0 rollback <version-id>`. Rollback does not touch Durable
Object state: storage for all five bindings listed above is unaffected,
since it is keyed to the unchanged Worker identity, not to a version. A
rollback also restores that version's bindings, so a secret the Alchemy
deploy dropped comes back with it; the next Alchemy deploy drops it again
unless the shell supplies it.

Rolling back across the adopting deploy restores the pre-Alchemy version but
leaves Alchemy's script tags and `alchemy:v5` migration tag in place; the next
`alchemy deploy --adopt` reconciles from there.

### Receipt version IDs and recovery

Alchemy prints no version id for a full-cutover deploy, so `scripts/deploy.ts`
reads it back from `GET /accounts/<account>/workers/scripts/smithers-mvp-web/deployments`
(the newest deployment's majority version) and writes it as
`wranglerVersionId`, the key `scripts/canary/rollback-verdict.ts` reads; the
receipt's `deployTool: "alchemy"` says which tool produced it. A successful
real deploy writes that ID to a timestamped receipt and
`deploy-receipts/latest.json`. A `--dry-run` publishes nothing and reads no
version ID, so its receipts in `deploy-receipts/dry-run/` legitimately carry
`"wranglerVersionId": null` and `"dryRunMode": "plan"`.

If Alchemy succeeds but the deployments list names no version, the script
exits with status 1 after publishing. It writes no fresh receipt;
`deploy-receipts/latest.json` still describes the previous deployment if it
exists. The nonzero exit does not undo the publish. A changed API shape or a
token without the deployments read permission can trigger this guard.

1. Preserve the command output and the build's recorded git SHA and dirty
   flag. Confirm the active version with
   `bun x wrangler@4.124.0 deployments list` from `apps/server`, using the same
   Cloudflare account and credentials. Do not use an older receipt as evidence
   of what just published.
2. Check the API response and repair the reader if its shape has changed, then
   re-run the scripted deploy to obtain a fresh receipt. If redeploying is
   unsuitable, record the verified version ID by hand in a separate receipt
   with `worker`, `dryRun: false`, `gitSha`, `gitDirty`, `timestamp`, and
   `wranglerVersionId` from this publish; do not relabel an older receipt or
   guess an ID.
3. Run `bun scripts/canary/rollback-probe.ts` against the fresh receipt (use
   `--receipt <path>` for a manual receipt), then verify the deployed build with
   `bun scripts/canary/build-probe.ts https://canary.smithers.sh --sha <gitSha>`.

### Probe it: `scripts/canary/rollback-probe.ts`

```sh
CLOUDFLARE_API_TOKEN=<token> bun scripts/canary/rollback-probe.ts
```

It asserts three things about `smithers-mvp-web`:

1. the newest receipt (`deploy-receipts/latest.json`, or `--receipt <path>`)
   names a version id,
2. that version is the one Cloudflare is actually serving
   (`GET /accounts/<account>/workers/scripts/smithers-mvp-web/deployments`),
3. a prior version is still in Cloudflare's version list
   (`GET .../versions`), so `wrangler rollback <id>` has a target. The probe
   prints the exact rollback command for that version.

Both response shapes were read back from the live account on 2026-08-18:
`/versions` answers `{ success, result: { items: [{ id, number, metadata: {
created_on }, annotations }] } }` newest first, and `/deployments` answers
`{ success, result: { deployments: [{ versions: [{ version_id, percentage }] }] } }`
newest first. Cloudflare lists 10 versions for `smithers-mvp-web`, and the
version serving 100% of traffic is `dffd4070-e5c6-4fd0-86b6-73ebedff5600`
(created 2026-08-13T06:21:59Z) — so a rollback target exists today even though
no receipt on disk names the deployed version.

**"Reachable" means rollback-eligible, not fetchable.** A prior Worker version
has no public URL; nothing can HTTP it. The probe never claims otherwise.

It skips (exit 0, `skip:` lines) when `CLOUDFLARE_API_TOKEN` is unset or no
receipt is on disk, and reports `INCONCLUSIVE` rather than `PASS` when it
verified nothing. It fails when a receipt exists but cannot support a
rollback. Receipts are gitignored and exist only on the machine that deployed,
so this belongs in the deploy workflow after a real deploy, not in a scheduled
canary that has no receipt to read.

### The drill — do this once, by hand, and keep the receipt

A rollback plan nobody has ever exercised is not a rollback plan. Rolling back
and forward swaps the live deployment, so it is a human drill and is
deliberately not automated.

1. Deploy for real, so a receipt names a version:
   `CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=dd3525a4132493566aeb38de533c8827 pnpm --filter smithers-server run deploy`.
   Record `deploy-receipts/latest.json` — call this version **N**.
2. Run `bun scripts/canary/rollback-probe.ts`. It must pass and must name the
   prior version, **N-1**.
3. `bun x wrangler@4.124.0 rollback <N-1 id> --message "CN-24 drill"` from
   `apps/server`.
4. Confirm `https://canary.smithers.sh` serves the older build, and that
   `bun x wrangler@4.124.0 deployments list` shows N-1 at 100%.
5. Roll forward: `bun x wrangler@4.124.0 rollback <N id> --message "CN-24 drill, forward"`.
6. Confirm the canary serves N again and re-run the probe.
7. Write the drill up in an `apps/WAVE*-RECEIPT.md` note with both version ids
   and the timestamps, so the next person can see it was really done.
