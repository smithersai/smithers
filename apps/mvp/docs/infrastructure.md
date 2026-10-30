# Infrastructure

The app has site and ChatApi Workers, a private shape gateway and a separate Electric runtime beside Postgres ([decision 0001](decisions/0001-electric-postgres-tanstack-db.md)). In production, `alchemy.run.ts` declares all of it: a Neon Postgres project, the migrations, Hyperdrive, Electric in a Cloudflare Container owned by its runtime Worker, and the site/API Workers (`infra/`). Locally, Postgres and Electric are Docker Compose services.

```
browser ── site Worker ── service binding ── ChatApi Worker ── Hyperdrive ──────────────────────────▶ Postgres
                                                 │                                          (logical replication)
                                                 └─ GET /api/shapes/messages ── Electric gateway ── ElectricRuntime object/container ─┘
```

| Piece | Local (`pnpm db:up`, `pnpm dev`) | Production (`pnpm run deploy`) |
|---|---|---|
| Postgres 14 or later, `wal_level=logical` | `postgres:17.11-alpine` at `localhost:54321` | the `ChatPostgres` Neon project: Postgres 17, logical replication on (`infra/Postgres.ts`) |
| Migrations | `pnpm db:migrate` | the `ChatMigrations` deploy step (`infra/ChatDatabase.ts`) |
| Electric | `electricsql/electric:1.8.1` at `localhost:30001`, no secret | `electricsql/electric:1.8.1` in a Cloudflare Container behind the private `ElectricGateway` service binding (`infra/ElectricGateway.ts`) |
| Hyperdrive | `alchemy dev` passes the binding straight through to `DATABASE_URL` | the `ChatDatabase` config in front of Neon's direct host, query cache off |
| Workers | local workerd at http://localhost:1337 (HTTP/1.1) and https://localhost:1443 (HTTP/2, [below](#https-and-http2)) | Cloudflare over HTTP/2 and HTTP/3, Workers Logs and Traces persisted |
| Remote flows | the `FlowExecution` Durable Object in local workerd, its engine in the schema `smithers_flows` of the compose Postgres | the `FlowExecution` Durable Object, hosted by ChatApi, its engine in the schema `smithers_flows` of the Neon project through `ChatDatabase` ([remote-flows.md](features/remote-flows.md)) |

## Local

The Vite plugin compiles browser `.vibe` imports. ChatApi's local Worker is bundled separately by Alchemy's sidecar: `infra/WorkerBuild.ts` carries a deferred plugin module reference across RPC. The pinned Alchemy patch rehydrates that reference and preserves `build` through local diff and reconcile. `infra/WorkerBundles.test.ts` checks the installed patch and compiles the developer Worker through the RPC codec and real bundle watcher. Keep the patch until upstream preserves these plugins in both local and deployed builds. The pinned VibeLang loader patch splits its source-map template directive so Playwright’s source-map reader does not mistake that template for the loader’s own inline map; the same suite checks real Playwright test discovery.

You need Docker with Compose v2, Node 26 (it runs the TypeScript scripts directly) and pnpm.

1. `pnpm install` in the repository root.
2. `pnpm db:up` starts Postgres and Electric from `docker-compose.yml` and waits until both are healthy.
3. `pnpm db:migrate` applies `db/migrations` to `DATABASE_URL`, the compose Postgres by default.
4. Give ChatApi a model key. The default model needs `CEREBRAS_API_KEY` in the environment; `CHAT_MODEL` selects another ([chat.md](features/chat.md#configuration)).
5. `pnpm dev` runs `alchemy dev`: the app and both Workers in local workerd, at https://localhost:1443/app over HTTP/2 and at http://localhost:1337/app over HTTP/1.1. Without the GitHub App's credentials, a local developer is signed in as an Admin, and can sign out and in again ([sign-in.md](features/sign-in.md#local-development)).
6. Open https://localhost:1443/app. Answers come from the browser's agent: it runs in the tab's engine worker and reaches the model through `POST /api/model/agent` ([agent.md](features/agent.md)).

| Task | Command |
|---|---|
| Tests (`worker/` and `db/` need Postgres and Electric up) | `pnpm test` |
| End to end (at https://localhost:1443 unless `BASE_URL` names another) | `pnpm e2e` |
| Stop Postgres and Electric, keeping the data | `pnpm db:down` |
| Delete the data too | `docker compose down -v` |
| Query the conversation | `docker compose exec postgres psql -U smithers -c 'select * from messages order by position'` |
| Is Electric up? | `curl localhost:30001/v1/health` |
| ChatApi's logs | `.alchemy/log/dev_<user>/ChatApi/` |

The development service worker precaches only `index.html`; modules enter its runtime cache on a controlled visit.
Generated files left in its temporary directory are never globbed into that precache. A stale `registerSW.js` is
not served by Vite and would fail installation. Device tests bound first activation to 90 seconds before reloading under
worker control. The offline write test then cuts a real CONNECT relay before releasing browser offline emulation:
WebKit's emulation blocks even a service-worker navigation response. The relay forwards opaque TLS bytes only and
remains disconnected through teardown; no queued write reaches the server.

### HTTPS and HTTP/2

Certificate programs run asynchronously so first startup leaves the event loop responsive. Closing the plugin waits
for pending startup and closes its listeners before returning. `certificate` and `makeCertificate` return promises.
Program runs emit the `dev.https.certificate.program` span with the program name, without arguments or output.
The existing Vite logger reports readiness, startup failure, and unanswered requests.

`alchemy dev` serves only plain HTTP/1.1, and a browser opens at most six HTTP/1.1 connections to one origin. Each Electric shape a tab follows holds one of them in a long poll for up to 20 seconds, and a tab follows 11 to 15 shapes on every page, so at http://localhost:1337 the rest wait in the browser's queue: a change took up to 40 seconds to reach another device. Cloudflare serves the deployed app over HTTP/2 and HTTP/3, which carry every request on one connection. Electric's guidance is the same: serve shapes over HTTP/2 ([Electric: slow shapes in local development](https://electric-sql.com/r/electric-http2)).

So `pnpm dev` also serves the app at **https://localhost:1443** over HTTP/2, as production does. The Vite plugin `dev/https.ts` starts it when Vite listens and stops it with Vite:

```
browser ══ HTTP/2, TLS ══ https://localhost:1443 (dev/https.ts) ── HTTP/1.1 per request ── Vite ── Workers in workerd
browser ── HTTP/1.1 ───── http://localhost:1337 (alchemy dev) ─────────────────────────── Vite ── Workers in workerd
```

- Each request goes on to Vite over a kept-alive HTTP/1.1 connection, at most 64 at once apart from Electric's long polls, which are never queued, with `x-forwarded-proto: https` and `x-forwarded-host`, so a Worker's `request.url` is the `https://localhost:1443` URL the browser asked for. A request Vite never answers is a `502` whose body names the error, and Vite's log says `HTTPS and HTTP/2: GET <path> got no answer from Vite: <code>`.
- A WebSocket (terminals, a branch's room, Vite's reload) comes over HTTP/1.1 on a connection of its own, as browsers do when the server offers no WebSockets over HTTP/2, and is piped through as bytes.
- The port is 1443 for the default `alchemy dev` (stage `dev_$USER`). A dev server on any other stage, such as a second one for live tests, sets `DEV_HTTPS_PORT` to a port of its own, and fails to start without it rather than take 1443 while the default one restarts. If the port is taken, Vite logs `HTTPS and HTTP/2 didn't start` and http://localhost:1337 still works.
- http://localhost:1337 stays, for `curl`, the benchmarks and anything else that isn't a browser.

**The certificate.** The plugin keeps it in `node_modules/.dev-https/` (`cert.pem`, `key.pem`) and makes it on first start, and again a day before it expires:

| On the machine | Certificate | Browsers |
|---|---|---|
| `mkcert` on `PATH` | mkcert's for `localhost`, `127.0.0.1` and `::1` | trust it once `mkcert -install` has added mkcert's CA to the system (it asks for your password once) |
| no `mkcert` | self-signed by `openssl` | warn; Playwright is told to accept it |
| `DEV_HTTPS_CERT` and `DEV_HTTPS_KEY` set | the files they name | whatever trusts it |

To trust the dev URL in your own browser, install mkcert (`brew install mkcert`), run `mkcert -install`, delete `node_modules/.dev-https` and restart `pnpm dev`.

**The dev Workers trust it too.** `pnpm dev` sets `NODE_EXTRA_CA_CERTS` to `node_modules/.dev-https/cert.pem` unless it is set already, and workerd adds that file to the certificates its outbound fetch trusts. So ChatApi's page check (`POST /api/web/preview`, [web pages](features/web-pages.md#before-a-page-is-framed)) reads a page served over the dev certificate, such as the end-to-end tests' pages on `https://127.0.0.1:<port>`. workerd reads the file each time it starts a Worker, so a certificate the first start makes is trusted from the next start. The file anchors a self-signed certificate (the `openssl` one); for mkcert's, set `NODE_EXTRA_CA_CERTS` to mkcert's CA, `"$(mkcert -CAROOT)/rootCA.pem"`, before `pnpm dev`.

**End-to-end tests** open https://localhost:1443 unless `BASE_URL` names another URL (`playwright.config.ts`). Against the dev URL, Playwright's Chromium accepts the dev certificate even when the machine doesn't trust it: `ignoreHTTPSErrors`, and `--ignore-certificate-errors`, without which Chromium refuses to register the app's service worker over an untrusted certificate ("An SSL certificate error occurred when fetching the script"). Against a deployment both are off. The Mac mini farm needs nothing more: its `pnpm dev` makes a self-signed certificate.

**Measured on 2026-10-20** on the Mac mini farm: one dev server, one tree, two Chromium contexts A and B on `/app`. A asks the scripted agent (`/app?agent=needs-you`, no model) six times, 2 to 10 seconds apart; each time is from ChatApi's `202` for A's question to B's page showing it.

| Six writes on A | HTTP/1.1, http://localhost:1337 | HTTP/2, https://localhost:1443 |
|---|---|---|
| A's question shows on B | median 19.6 s, worst 20.1 s | median 0.05 s, worst 0.10 s |
| The agent's question toasts on B (the feed's shape) | median 35.1 s, worst 39.6 s | median 1.5 s, worst 1.8 s |
| B answers; A's agent goes on; its answer shows on B | median 45.0 s, worst 60.1 s | median 2.6 s, worst 2.9 s |
| Shape requests' protocol (Resource Timing's `nextHopProtocol`) | `http/1.1` | `h2` |

Every page held 11 to 15 shapes, counted from the shape URLs each page requested. `e2e/sync.spec.ts` ("sync over HTTP/2") checks the protocol and holds another device to 10 seconds on every run.

### Tests

ChatApi's tests (`worker/`, `db/`) use the compose Postgres and Electric and nothing else (`db/TestDatabase.ts`):

- They refuse a `DATABASE_URL` that names another host or port, before connecting to it. Unset it to run them.
- For an isolated local stack, set `TEST_DATABASE_PORT` and `TEST_ELECTRIC_PORT` to its published ports and `DATABASE_URL` to its local database. The database guard accepts only `localhost`, `127.0.0.1` or `[::1]` at the selected test port, and rejects `host` or `port` query parameters because the PostgreSQL driver treats them as connection overrides. Numeric loopback avoids hostname resolution. Electric's test endpoint stays on localhost.
- Migration clients, the repository test handler and the GitHub test handler use those same guarded endpoints. A schema must be created, migrated, queried and replicated on the selected database; test helpers never fall back to another local database or Electric port.
- Each test file works in a schema of its own on the compose Postgres, which `db/migrations` builds and which is dropped after the file. A test migrates only schemas of its own: it never migrates the dev database, touches the dev conversation, or sees another file's rows.
- A run starts with a fresh Electric replication connection (`db/ElectricReplication.ts`, the suite's global setup), unless another run's tests are connected. Postgres decodes each catalog change (a schema made or dropped, a truncate, Electric's publication changes) more slowly the longer that connection has lived: after a day of suites it spent a whole core on them and Electric delivered rows seconds late ([app-flakes](work/app-flakes.md)).
- With Postgres or Electric down, a test file fails with `No Postgres answers at localhost:54321. Start it with pnpm db:up.` (or Electric at `localhost:30001`). Any other setup failure fails it as it is.

## Production

`alchemy.run.ts` declares every production dependency, in the stage `prod`. Under `alchemy dev` it declares none of them: the stack checks `ALCHEMY_DEV` and keeps the compose services.

### Postgres

- `ChatPostgres` (`infra/Postgres.ts`) is a Neon project on Postgres 17 in `aws-us-east-1`, with logical replication on, which sets `wal_level=logical`. Its region and version can't change after creation.
- It keeps six hours of restore history (`HISTORY_RETENTION_SECONDS`), the most Neon's Free plan allows. Alchemy's default, a day, fails the deploy on that plan.
- The project's owner role has the `REPLICATION` attribute Electric needs and owns `messages`.
- Electric works only on tables with `REPLICA IDENTITY FULL`: Electric 1.8 refuses any other ("Electric cannot function with replica identity mode set to something other than FULL"). The first migration sets it. The one table of the engine's schema a device follows, `smithers_flows.flows_run_changes` ([a run on Cloudflare](features/runs.md#a-run-on-cloudflare)), the engine makes on its first alarm, and Electric sets it there itself, since the role it connects as owns the engine's tables too.
- `pnpm destroy` keeps the project: its removal policy is `retain`. Delete it in Neon's console.
- Its read-write compute autoscales from 0.25 to 1 compute unit (`COMPUTE_MIN_CU`, `COMPUTE_MAX_CU` in `infra/Connections.ts`). `ChatCompute` (`infra/Postgres.ts`), an Alchemy action, sets the range through Neon's API with the deploy's `NEON_API_KEY` whenever it changes, before the migrations run: Alchemy's `Neon.Project` declares no compute size. Neon restarts the compute to apply a new range, which drops open connections for about a second. Neon's default, a fixed 0.25 units with 112 connections, stopped accepting logins under load on 2026-10-22 ([Connections](#connections)).

### Connections

Neon sizes `max_connections` by the compute's largest size, about 450 per compute unit: 450 for the range above, 112 for 0.25 units. Each client's cap is set in `CONNECTION_BUDGET` (`infra/Connections.ts`), and their sum stays under `ALERT_PERCENT`, 80%, of 112, so the budget holds at the range's bottom too. `infra/Connections.test.ts` fails when it doesn't. Once a window, `ops/DatabaseLoad` samples the connections in use, and when they reach 80% of the server's `max_connections`, it alerts the Admins by email and Telegram ([database alerts](features/database-alerts.md)).

| Client | Cap | Set by |
| --- | --- | --- |
| Hyperdrive's origin connections, shared by ChatApi's requests and every `FlowExecution` alarm | 50 | `originConnectionLimit` of `ChatDatabase` (`infra/ChatDatabase.ts`) |
| Electric: its query pool and its replication connection | 20 + 1 | `ELECTRIC_DB_POOL_SIZE` on its container (`infra/ElectricGateway.ts`) |
| The deploy's migrations and an operator's `psql` | 5 | one connection each (`Database.layer`) |
| Neon's own and superusers' | 13 | measured on 2026-10-22: 4 reserved for superusers, 4 of Neon's own sessions |

A Worker's pool doesn't count against the budget: Hyperdrive multiplexes every Worker's connections onto its origin connections, one per open transaction. The engine's writers wait for its schema's writer lock at most 2 seconds at a time before letting their origin connection go (`@smthrs/database`'s `writerLockTimeout`), so a queue of them can't hold every one; before that, 60 waiting writers held all of Hyperdrive's, and Hyperdrive closed every other client after 15 seconds with `PgConnection: Connection closed` (2026-10-22). Every statement and transaction waits for a pooled connection at most 30 seconds (`acquireTimeout`) and then fails, so an alarm backs off and retries instead of waiting without a deadline.

### Placement

Every engine statement is a round trip from an execution's Durable Object to Postgres, and the engine's writes hold its schema's one writer lock across theirs, so the round trip sets how many writes the deployment makes a second. Cloudflare creates an object near its first caller unless told otherwise. `FLOW_EXECUTION_LOCATION`, a Durable Object location hint, creates every new execution's object at it instead (`worker/Placement.ts`); ChatApi's starter and every object's router reach their objects through it, since a hint counts only when an object is created. A deployment sets it beside its database; the public stack leaves it unset. Measured on 2026-10-22 behind the production Hyperdrive config, with Postgres in Neon's us-east-1: from an object near San Jose a round trip took 80 ms and a 10-statement write 988 to 1,030 ms; from one hinted `enam`, 4 ms and 66 to 79 ms. An object keeps the location it was created at. In production, after the deploy of 11:10 UTC on 2026-10-22 set it to `enam`, the median time between a run's journal records, about one write each, fell from 1,552 to 160 ms for `github/Reconcile` (334 gaps in the three hours before, 14 after) and from 1,165 to 263 ms for `terminal/Open` (56 before, 28 after).

### Migrations

`ChatMigrations` is an Alchemy action that applies `db/migrations` with `Database.migrate`, the same migrations `pnpm db:migrate` applies locally. It runs from the deploying machine against the project's direct host during `pnpm run deploy`, whenever the database or the list of migration files changed. The Hyperdrive config waits for it, so ChatApi never deploys against an unmigrated database. `pnpm plan` lists it as `run` when it will run.

### Electric

- `ElectricGateway` (`infra/ElectricGateway.ts`) is a Worker with no public URL: `workersDev` and its previews are off, and it has no domain or route. ChatApi reaches it only through its service binding `ELECTRIC_GATEWAY`. It answers only `GET /v1/shape` (`infra/ElectricAccess.ts`), by forwarding the request to one Durable Object, which starts the `Electric` container and forwards it to Electric's port; any other path is 404, before the container starts. ChatApi has authorized the person and fixed the shape before it calls, so no secret is needed on the hop: until 2026-10-26 the gateway sat at its `workers.dev` URL and checked a generated `ElectricSecret` sent as a bearer token.
- The container runs `electricsql/electric:1.8.1` on the `basic` instance type (1/4 vCPU, 1 GiB of memory, 4 GB of disk), at most one instance, with `ELECTRIC_INSECURE` set. Its `DATABASE_URL`, the project's direct host with its password, is the gateway Worker's secret binding `ELECTRIC_DATABASE_URL`, which the gateway's Durable Object passes to the container each time it starts it: the container's configuration, which the Cloudflare API returns in plain text to anyone who can read the account's containers, never holds it. Electric takes its own secret only as a URL parameter, so it runs without one: the container has no way in but its Durable Object, which only the gateway reaches.
- Electric keeps running between visits. A Durable Object's container stops shortly after the object goes idle unless the object sets an inactivity timeout ([Cloudflare: Durable Object Container API](https://developers.cloudflare.com/durable-objects/api/container/)), and a stopped Electric starts again with an empty disk. Before 2026-10-22 the gateway's object set none: every first load after 11 or more idle minutes (12 of 12 that day) got `503`s from Electric while it started and rebuilt its shapes, 53 on one load, and a device that didn't yet hold the branch's rows showed its conversation 25 to 30 seconds late. A device that holds them shows it from its own copy, Electric up or not: 0.5 s after the chrome with every shape request refused `503` or stalled (mini, 2026-10-22). The `503`s were the gateway's own hop into the container (`workersSubrequestsAdaptiveGroups` by `httpResponseStatus`: 53 from the object, the same 53 at ChatApi and the site), not ChatApi or Hyperdrive. Now the object holds the container for 6 hours after its last request, Cloudflare's maximum (`infra/ElectricAwake.ts`), so Electric stops only after 6 quiet hours, and the first visit after those still waits for it. Following Cloudflare's pattern, the object sets that timeout after each start and on each object instance's first request (a restarted object starts without one), never on every request.
- Every shape request of every device goes through that one object. On 2026-10-25, while it still set the timeout on each request, production served about 2 shape requests a second at most: 20 sent at once, even malformed ones Electric refuses at once, took up to 8 s with the deployment quiet and up to 26 s during an e2e run; the object's invocations took as long as the gateway's (`$workers.wallTimeMs`, Workers Observability), and Electric's container peaked at a fifth of its CPU (`containersMetricsAdaptiveGroups`). A page follows about 20 shapes, and a list shows its rows only once its shape is up to date, so the Conversations list and a repository's Runs missed their 30 s e2e waits. Once it set the timeout only after a start and on an instance's first request (deployed 2026-10-25 16:54 PDT), 20 requests at once finished within 0.4 to 1.6 s during an e2e run: a hold took 365 to 663 ms, which every request had paid inside the one object. Each request the object forwards logs `electric.object.request` as one JSON line (Workers Logs stores each line of Effect's default console logger as an event of its own): whether it is live, `awakeMs` (starting and holding Electric), `headersMs` (Electric's answer), the status, and whether it started or held the container, with no URL, parameter or body. After the fix, non-live requests spent 0 ms waking (p99) and 5 ms waiting for Electric's headers (p50; p99 27 ms); live ones wait out Electric's 20 s long poll. The gateway's and the object's invocation logs hold each one's total, so the difference between them is time the request waited before the object's code ran. Running all month, the `basic` instance costs about $7 at [Cloudflare's rates](https://developers.cloudflare.com/containers/pricing/): its 1 GiB of memory and 4 GB of disk are billed while it runs, its CPU only when it works.
- The one object runs one request at a time on its thread, and Cloudflare refuses a call into it ("Durable Object is overloaded. Requests queued for too long.") when requests arrive faster than it gets through them. Until 2026-10-26 it re-streamed every response body through Effect (`HttpServerResponse.fromWeb`, then `toWeb`), which cost it 10 to 15 ms of CPU per request (`durableObjectsPeriodicGroups`), so it served at most about 30 shape requests a second and overloaded from 3 first-time visitors at once ([Limits](#limits)). It now fetches Electric's port directly and returns the container's own response, its body untouched (`directOr` in `infra/ElectricAwake.ts`); only a request that reaches a container still starting goes the way that waits for the port, logged as `electric.object.port`. In a local workerd prototype with 300 KB bodies, that cut the object's CPU per request from about 2.2 ms to under 0.1 ms and raised its throughput from 312 to 876 requests a second, the client then being the limit.
- The gateway answers an overloaded object `503` with `retry-after: 5` and `cache-control: no-store`, so a device keeps its rows and tries again, as for any shape Electric can't answer yet (`infra/ElectricRelay.ts`); before, it was a 500. Each request the gateway relays logs `electric.gateway.request` as one JSON line: whether it is live, the status it answered, `outcome` (`answered`, `overloaded` or `failed`), `durationMs`, and for a refusal or failure the error's tag. Count overloads with `outcome = "overloaded"` in Workers Logs. The object's `electric.object.request` also records `inFlight`: how many requests the object was forwarding when this one arrived, itself included, from arrival to Electric's headers.
- Workers Cache is enabled on ElectricGateway's private entrypoint, scoped to each Worker version. Its key is ShapeProxy's canonical upstream URL, including the full authorized definition and every Electric protocol discriminator. HTTP 200 finite snapshots and live long polls keep Electric's public TTL; all other statuses, SSE and nonpublic responses are no-store. Electric's live hold is ten seconds (`ELECTRIC_LONG_POLL_TIMEOUT=10000`), while live cache TTL remains Electric's five seconds. ChatApi still returns `private, no-store` to browsers and strips legacy credentials before the binding. See [decision 0115](decisions/0115-electric-workers-cache.md) and [cache observability](observability.md#electric-gateway-cache).
- ChatApi gets the service binding `ELECTRIC_GATEWAY` and `ELECTRIC_URL=http://electric-gateway` from `bind` in `infra/Electric.ts`, which its init calls. A service binding ignores the host, so the URL names no address. Each request, `infra/ElectricUpstream.ts` provides `ShapeProxy.Upstream`, the `fetch` client over the binding's `fetch`, so every shape route calls Electric through the binding and every other request keeps the global fetch. Under `alchemy dev` there is no binding, and the routes call the compose Electric at `ELECTRIC_URL`. Browsers reach Electric only through ChatApi's shape routes, which fix the table ([chat.md](features/chat.md#get-apishapesmessages)).
- `ShapeProxy` sends Electric one canonical URL per request: its parameters sorted by name, each encoded once. The same shape at the same `handle`, `offset` and `cursor` is the same URL from every device, which a cache in front of the gateway can key on.
- Workers Cache (a cache Cloudflare checks before it runs a Worker, which collapses identical concurrent requests into one invocation; [Cloudflare: Workers Cache](https://developers.cloudflare.com/workers/cache/)) is not on the gateway yet. Alchemy 2.0.0-beta.83 supports it (`cache: { enabled, crossVersionCache }` on a Worker's props, per-entrypoint `entrypoints.<name>.cache`, or `yield* Cloudflare.cache()` in an Effect Worker's init). Cloudflare's docs give no plan restriction, consult the callee's cache on a service-binding `fetch`, and bypass it for any request with an `Authorization` header, which is why the bearer secret had to go first. On 2026-10-26 the account's script settings API showed no cache field on the gateway, which has never had it set; only a deploy that sets it shows whether the account takes it.

### Hyperdrive and the Workers

`pnpm run deploy` creates or updates:
- the `ChatDatabase` Hyperdrive config, whose origin is the project's direct host, with its query cache off so an answer's history sees the latest writes;
- ChatApi, bound to Hyperdrive, with Workers Logs and Traces persisted. It has no Cron Trigger: nothing answers on the server;
- the `FlowExecution` Durable Object class, hosted by ChatApi with SQLite storage, one object per remote flow execution. Its engine keeps its runs in the schema `smithers_flows` of the same Postgres, through the same `ChatDatabase` Hyperdrive config, and migrates that schema on its first alarm ([remote-flows.md](features/remote-flows.md));
- the site Worker with the app's assets, bound to ChatApi, with Workers Logs and Traces persisted, at the custom domain `APP_DOMAIN` ([Domain](#domain));
- with a custom domain, the docs site (`infra/DocsSite.ts`): `apps/site`'s Astro build as static assets, with no Worker code.

### Domain

`APP_DOMAIN` names the hostname the app serves at, such as `example.com`. A production deploy refuses to run without it (`infra/Domain.ts`), so a deployer who leaves it out can't detach the domain or drop the docs site by accident. `APP_DOMAIN=workers.dev` deploys with no custom domain and no docs site: the app answers only at the site Worker's `workers.dev` URL. Under `alchemy dev` it is ignored.

A repository's own domains, such as vibelang.sh, are Cloudflare for SaaS custom hostnames on `APP_DOMAIN`'s zone, added by its Maintainers in Settings ([domains.md](features/domains.md), decision 0039).

With a domain, one hostname serves two sites:

```
https://<APP_DOMAIN>/<path>
  ├─ a docs path (/docs, /docs/*, /changelogs/*, /llms.txt …) ─▶ zone route ─▶ docs site (apps/site)
  └─ every other path (/, /app, /<owner>/<repo>, /api/*)      ─▶ custom domain ─▶ site Worker ─▶ ChatApi
```

- The site Worker takes `APP_DOMAIN` as its custom domain. Cloudflare creates the DNS record and certificate. The zone must be in the deploying account. `APP_DOMAIN=workers.dev` detaches any custom domain the site Worker has. The `workers.dev` URL keeps answering, so a GitHub webhook pointed there keeps working.
- The docs site claims each of its paths with a zone route. Cloudflare runs routes before a custom domain, so those paths are the docs site's and every other path stays the app's. `DOCS_SITE_PATHS` in `src/pwa.ts` lists them: each docs folder bare and with `/*` (never a prefix such as `/docs*`, which would also take `/docsify/docsify` from the app's repositories), plus the site's asset folders and files, each with a trailing `*`. A route path without a trailing `*` never matches a URL with a query, and a route path can't hold one, so `/docs?ref=x` reaches the site Worker, which redirects it to `/docs/?ref=x` (`worker/index.ts`). A GitHub owner named after a docs folder (`docs`, `changelogs`, `migration`, `privacy`, `terms`, `refunds`, `demo`, `bug`) isn't reachable at `/<owner>/<repo>`.
- The app's service worker controls every page on the origin after one visit. It leaves the same paths to the network: its navigation fallback and its shell cache skip them (`src/pwa.ts` `DOCS_SITE`, `e2e/docs-site.spec.ts`).
- Open tabs check for a release when the document becomes visible, the window gains focus, or TanStack Router resolves an in-app navigation. The host injects these signals into `watchUpdates` (`src/pwa.ts`); overlapping checks are deduplicated. `pwa.update.check` records only the trigger and outcome (`checked`, `failed`, `busy`, `hidden`). A failure waits for the next signal; there is no periodic timer or retry loop. The existing activation gate waits for saved input before reloading. `e2e/pwa-update.spec.ts` builds and serves two production versions with service workers enabled and verifies navigation upgrades an already-open tab.
- `pnpm run deploy` builds the docs site with `pnpm build` in `apps/site`, and builds it again only when that folder's files change. The deploying checkout needs `apps/site`'s dependencies installed.
- The docs site's `_redirects` and `_headers` apply to the paths it serves, and its 404 page answers a missing docs page. Its Mintlify-era rules for other paths (`/components/*`, `/rpc/*`, `/quickstart` …, each to `/docs/installation/`) no longer reach it: those paths are the app's.
- `APP_DOMAIN_REDIRECTS` lists hostnames, comma-separated, that answer with a 301 to `APP_DOMAIN`, path and query kept, such as `www.example.com`. Alchemy attaches each as a custom domain and writes a redirect rule in the zone's `http_request_dynamic_redirect` phase, so the deploy token needs Zone → Single Redirect: Edit. A hostname with a DNS record of its own, or that another Worker serves by a route, must be freed first, as below.
- `APP_ALIASES` lists other hostnames that serve the app, comma-separated `host=/path` entries, such as `factory.example.com=/acme/widgets/-/factory`. Alchemy attaches each as another custom domain of the site Worker, and the site Worker redirects `/` there (302, query kept) to the entry's page; every other path is the app, `/api/*` included (`worker/aliases.ts`). The docs site's routes stay on `APP_DOMAIN`. An alias is a separate origin: sign-in there needs `https://<alias>/api/auth/callback` among the GitHub App's callback URLs, and its sessions and device data are its own. The deployment's own repository pages use it, such as a repository's factory ([decision 0126](decisions/0126-repository-feeds.md)); a repository's Maintainers add their own domains in Settings instead.
- Sign-in sends GitHub `https://<APP_DOMAIN>/api/auth/callback` from a request there. Add that URL to the GitHub App's callback URLs. Session cookies are host-only (`__Host-`), so a session at the `workers.dev` URL doesn't carry over, and neither does a device's local data, which belongs to its origin.

**Moving a hostname that other Workers serve.** Alchemy refuses a hostname that another Worker holds as a custom domain. Before the first deploy with a domain, detach the hostname from that Worker (`DELETE /accounts/<account>/workers/domains/<id>`) and delete zone routes that send the whole hostname elsewhere (`DELETE /zones/<zone>/workers/routes/<id>` for a `<host>/*` route), because a route outranks the new custom domain. Deploy right after: the hostname has no DNS record from the detach until the deploy attaches it.

### Credentials

Set these in the environment of `pnpm plan`, `pnpm run deploy` and `pnpm destroy`. Alchemy also loads `apps/mvp/.env`, which git ignores: keep identifiers such as `CLOUDFLARE_ACCOUNT_ID` and `NEON_ORG_ID` there, and secrets in your shell or a secret manager, never in a file in the repository. ChatApi reads its settings with Effect `Config` while Alchemy plans it, and Alchemy binds each one that is set to the Worker as a secret.

A local `.env` that raises a limit for development, such as `MODEL_DAILY_TOKEN_BUDGET`, raises it in production too when you deploy from that checkout. Deploy from a clean `jj workspace` of the pushed revision, which has no `.env`, and pass the two identifiers and `APP_DOMAIN` in the environment.

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `APP_DOMAIN` | yes, for a production deploy | Alchemy | the hostname the app serves at, or `workers.dev` for none ([Domain](#domain)) |
| `APP_DOMAIN_REDIRECTS` | no | Alchemy | hostnames, comma-separated, that redirect to `APP_DOMAIN` ([Domain](#domain)) |
| `APP_ALIASES` | no | Alchemy, the site Worker | `host=/path` entries, comma-separated: hostnames that serve the app and open one page at `/` ([Domain](#domain)) |
| `CLOUDFLARE_API_TOKEN` | yes | Alchemy | at least Workers Scripts, Containers and Hyperdrive edit, and Secrets Store edit for Alchemy's state store. `pnpm exec alchemy profile edit` instead sets up a profile through OAuth, in an interactive terminal. |
| `CLOUDFLARE_ACCOUNT_ID` | yes, with the token | Alchemy | |
| `ALCHEMY_PASSWORD` | yes | Alchemy | encrypts the database URL and Electric's secret in the stack's state |
| `NEON_API_KEY` | yes | Alchemy | creates the Neon project |
| `NEON_ORG_ID` | with a personal API key | Alchemy | the Neon organization that owns the project; an organization API key implies it. It can't change after creation. |
| `CEREBRAS_API_KEY` | yes | ChatApi | or the credential `CHAT_MODEL` names |
| `CHAT_MODEL` | no | ChatApi | the model endpoint's default model ([model-endpoint.md](features/model-endpoint.md#configuration)) |
| `SUMMARY_MODEL` | no | ChatApi | the timeline summaries' model when no admin set one ([model-endpoint.md](features/model-endpoint.md#configuration)) |
| `MODEL_DAILY_TOKEN_BUDGET`, `MODEL_MAX_OUTPUT_TOKENS`, `MODEL_MAX_MESSAGES`, `MODEL_MAX_REQUEST_BYTES`, `MODEL_RESERVATION_EXPIRY` | no | ChatApi | [model-endpoint.md](features/model-endpoint.md#configuration) |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | for sign-in | ChatApi | the Smithers GitHub App's client; without them nobody can sign in, so nobody can ask ([sign-in.md](features/sign-in.md#configuration)) |
| `GITHUB_REPOSITORY`, `SESSION_MAX_AGE_DAYS`, `ROLE_RECHECK_MINUTES` | no | ChatApi | [sign-in.md](features/sign-in.md#configuration) |
| `GITHUB_ALLOWED_REPOSITORIES` | no | ChatApi | [issues.md](features/issues.md#configuration) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | for issues | ChatApi, FlowExecution | the Smithers GitHub App's ID and private key; without them nothing syncs or writes to GitHub ([issues.md](features/issues.md#configuration)) |
| `FLOW_EXECUTION_LOCATION` | no | ChatApi, FlowExecution | the Durable Object location hint new remote flow executions are created at, such as `enam` beside a database in us-east-1; unset, near their first caller ([Placement](#placement)) |
| `REPO_FLOWS` | no | ChatApi | `true` lets GitHub's pushes and pull requests start repositories' own flows, each job on its own machine ([ci.md](features/ci.md#triggers)); off unless set |
| `TODO_RUNS` | no | ChatApi | `false` switches the coding factory's `todo` run off, so every TODO stays Queued; on otherwise, with the GitHub App ([todos.md](features/todos.md#the-run)) |
| `SANDBOX_COMMAND_MAX_SECONDS` | no | ChatApi, FlowExecution, the site's build | whole seconds from 60 to 3600, default `3600`: the longest command a person or an agent runs on a branch's machine; a longer one is refused, and the browser's run tool states it. Any other value fails the build ([sandbox-tools.md](features/sandbox-tools.md#configuration)) |
| `SANDBOX_SESSION_TIMEOUT_SECONDS` | no | SandboxObject | positive integer, default `60`; deadline for the whole terminal session start, including container start, provisioning and tmux; expiry answers unavailable so `terminal/Open` retries then records failure ([sandbox-tools.md](features/sandbox-tools.md#the-machine)) |
| `GITHUB_WEBHOOK_SECRET`, `GITHUB_API_URL` | no | ChatApi, FlowExecution | the webhook's secret (without it Reconcile alone keeps issues fresh) and GitHub's API ([issues.md](features/issues.md#configuration)) |
| `CODE_STORAGE_ORG`, `CODE_STORAGE_KEY` | for cloning | ChatApi, FlowExecution | the Code Storage organization (`smithers`) and its ES256 key; without them the deployment clones nothing and browses only what was cloned ([repo.md](features/repo.md#configuration)) |
| `ALERT_EMAIL_API_KEY` | for email alerts | FlowExecution | a Resend API key; without it spend alerts send no email, and an Admin's email setting records `unconfigured` ([spend-alerts.md](features/spend-alerts.md#channels)) |
| `ALERT_TELEGRAM_BOT_TOKEN` | for Telegram alerts | FlowExecution | a bot's token from @BotFather; without it spend alerts send no Telegram message ([spend-alerts.md](features/spend-alerts.md#channels)) |
| `BUG_REPORTS_READ_TOKEN` | no | ChatApi | a bearer that lists bug reports at `GET /api/bugs` and nothing else, for an agent outside the app; unset or blank turns that door off ([bugs.md](features/bugs.md#the-routes)) |
| `SMITHERS_BUILD` | no | the build | the build's name in the bundle and `/version.json`; unset, the checkout's jj revision, else `dev` ([bugs.md](features/bugs.md#the-build)) |
| `ALERT_EMAIL_FROM`, `ALERT_EMAIL_API_URL`, `ALERT_TELEGRAM_API_URL` | no | FlowExecution | the sender (default `Smithers <onboarding@resend.dev>`) and the providers' origins ([spend-alerts.md](features/spend-alerts.md#channels)) |
| `GITHUB_TOKEN`, `CODE_STORAGE_API_URL`, `REPO_MAX_REPOSITORIES`, `REPO_MAX_STORED_GB`, `REPO_MAX_READ_GB_PER_MONTH`, `REPO_MAX_SIZE_MB`, `REPO_BUDGET_USD`, `REPO_TREE_MAX_PATHS`, `REPO_CLONE_DEADLINE` | no | ChatApi, FlowExecution | [repo.md](features/repo.md#configuration) |

Leave `SESSION_SECRET` unset: Alchemy generates it once (`infra/SignIn.ts`) and binds it to ChatApi. Leave `DATABASE_URL`, `ELECTRIC_URL`, `ELECTRIC_SECRET`, `ELECTRIC_SECRET_AS` and `ELECTRIC_SOURCE_ID` unset for a deploy: the stack provides the database and Electric, and a set `ELECTRIC_URL` replaces the one ChatApi gets from the stack. They are for local runs.

### Deploy

1. Set the credentials above.
2. `pnpm plan` shows what `pnpm run deploy` would create, update or run, and changes nothing.
3. `pnpm run deploy` (`pnpm deploy` is pnpm's own command, not this script) asks before it changes anything; `pnpm run deploy --yes` doesn't, and a terminal that can't prompt needs it. It creates the Neon project, runs the migrations, then creates Hyperdrive, Electric's container and gateway, ChatApi and the site. It prints the site's URL.
4. Check it. First the health spec, which cold-loads the landing page and both repositories, signed out and signed in, in eight browsers at once, and fails on any server error, failed request, console error or page error ([Server and console errors](#server-and-console-errors)):

   ```sh
   E2E_PROD_URL=https://<site> pnpm e2e:prod health.spec.ts
   ```

   Then by hand:

   ```sh
   curl -i https://<site>/api/auth/session                                       # 200 {"signedIn":false,"available":true}
   curl -i -X POST https://<site>/api/questions -H 'content-type: application/json' \
     -d "{\"id\":\"$(uuidgen)\",\"answerId\":\"$(uuidgen)\",\"text\":\"Say hi.\"}"     # 401: asking needs a Member
   curl -i 'https://<site>/api/shapes/messages?offset=-1'                         # 200 with electric-handle
   curl -sI https://<site>/docs/ | head -1                                         # 200: the docs site, with a domain
   curl -s https://<site>/llms.txt | head -1                                       # "# Smithers"
   ```

   Then sign in at `<site>/app` as a Member of `GITHUB_REPOSITORY` and ask: the browser's agent answers.

5. Watch ChatApi in the Cloudflare dashboard: Workers Logs (`message = chat.answer.write` for answers the browsers' agents settle, `model.proxy.serve` for their model calls) and Traces. [observability.md](observability.md) lists every record, and says how to also [send them to your own collector](observability.md#sending-to-your-own-collector).
6. A live tail (`POST /accounts/<account>/workers/scripts/<script>/tails`, protocol `trace-v1`) goes silent at the next deploy without closing: start a new tail after every deploy, and for a long watch replace it every few minutes. A branch's machine logs `sandbox.wake` with the step that failed, `sandbox.checkout` with its `failure` (`forge`, `branch` or `clone`) and `sandbox.forge` for each request its box sent the forge.

`pnpm destroy` removes the Workers, the container, Hyperdrive and Electric's secret, and keeps the Neon project.

### Device data across a deploy

Once the device's owner is checked, the new build brings the device's OPFS store, IndexedDB outbox and engine journal forward before any tab reads them ([decision 0021](decisions/0021-local-first-migrations.md)). An earlier build's device belongs to the person its confirmed session names, by stable id or, for builds that kept only a login, by login; data whose owner isn't the person signed in stays sealed and whole, never deleted ([decision 0023](decisions/0023-device-ownership-and-queued-authority.md)). Before a deploy:

1. `pnpm test` passes `src/device/schemas.test.ts`: every persisted collection and outbox payload is declared in `src/device/registry.ts` at the version its schema has. A schema that changed needs a new version (a synced store bumps `version`, and its rows sync again; a local store or payload appends its new schema and a migration), then `UPDATE_DEVICE_SCHEMAS=1 pnpm vitest run src/device/schemas.test.ts` records it in `schemas.lock.json`. Old shapes live in `src/device/history.ts`.
2. `src/device/migrations.test.ts` and `src/device/upgrade.test.ts` pass against the fixture of the build production runs now (`src/device/fixtures/<build>.json`). A deploy that changes a store adds its build's fixture, written in that build's shapes. These prove schema migration under authorized ownership; the real browser test also exercises the activation policy. Retain earlier fixtures when adding the currently deployed build's fixture.
3. `e2e/device-upgrade.spec.ts` passes against the deployed build's files: its synced message, queued question and draft are its owner's in the new build (the question sent once, the draft kept), and the owner's new draft and queued question survive reopening, each question sent once. To supply the old build, mirror its files from the site before the deploy replaces them (every path in its `sw.js` precache list, plus `sw.js`, its `workbox-*.js` and `assets/wa-sqlite-*.wasm`) into `~/Desktop/smithers-mvp/builds/<build>`, and run the spec with `OLD_BUILD_DIR` pointing there. The site answers `/index.html` with a redirect, so take `index.html` from `/app`, and check that its MD5 is the revision `sw.js` precaches for it.

After the deploy, each device's engine leader runs `device/prepare` once: Workers Logs from the browser show `device.migrate` per collection and `browser.runtime.prepare`, and `device_migrations` and `device_rows_kept` count them. A row that couldn't be brought forward stays in the device's `device_kept` table; a queued write that couldn't is parked and shows Not sent.

### Deployed

The production app is https://smithers.sh. Our hosted deployment's settings and deploy log are private: they belong in a private `smithers-infra` repository (Will, 2026-10-20 18:08: "we should have the deployment info private in smithers-infra repo"; [rulings §18](rulings.md#18-open-questions-no-ruling-yet)), and this repository keeps only the generic stack.

### Against a deployment

`pnpm e2e:prod` runs the e2e suite against production. Each test passes, fails or skips with a declared reason, and each recorded test gets a GIF (rulings TEST-1, TEST-3, TEST-4):

```sh
E2E_PROD_URL=<the production URL> pnpm e2e:prod [spec…] [playwright options…]
```

**Sign-in.**
- The setup project (`e2e/deployment/sign-in.setup.ts`) signs the test account `codeplanesmithers` in the way a person does: through GitHub, from the account's own browser profile (`~/.multi-e2e-profile`, or `E2E_GITHUB_PROFILE`).
- It keeps the app's session cookie and nothing else, in `~/.smithers-e2e/<host>/session.json` (mode 0600; `E2E_SESSION_DIR` moves it). The account's login, person id and role go in `identity.json` beside it.
- Every test in the `deployment` project starts from that session, including contexts a test opens itself. `signedOut` from `e2e/target.ts` opens one without it.
- No test context holds a GitHub cookie, and the setup records no video or trace.
- Later runs reuse the session until 3 days before it expires.
- When GitHub asks for a password or a device code, the setup fails and says so. Open the profile once in a visible browser and sign in.
- A role is read at sign-in. While the account is below Member, the setup signs in again at most every 6 hours; `E2E_FRESH_SIGN_IN=1` forces a new sign-in.
- There is no test-only sign-in route (the decision record "How e2e tests sign in to a deployment").

**Needs.**
- A test declares what it needs from its target with `requires(...)` from `e2e/target.ts`. Where the run doesn't meet a need, the test skips with that need's reason.
- Dev builds only: the faulty services (`faults`), the scripted model (`scriptedAgent`), local development's second and third people (`devPeople`) and its sign-out (`devSignIn`).
- This machine only: local Worker logs (`localLogs`), local fixtures (`localServer`) and dev-server settings (`devConfig`).
- A deployment only: GitHub sign-in (`githubSignIn`), and GitHub writes to a scratch repository (`githubScratch`, with `E2E_ISSUES_REPOSITORY`).
- Code Storage (`codeStorage`), which locally needs its organization and key. Mobile file journeys launch the real clone and wait for its refs and ready repositories-shape row before opening either identity’s page.
- Mobile TODO writes (`writableStack`): locally Spoon-Knife; in a deployment, `E2E_STACK_REPOSITORY` must name a writable scratch stack with repository membership and shapes, never a `smithersai` repository.
- Mobile issue/pull details require `syncedRepository`: explicitly set `E2E_SYNCED_REPOSITORY` to the deployment's synced public repository. Missing configuration blocks the run. A complete server snapshot must contain a real item of the requested kind before navigation; empty projections still fail, and detail/layout assertions remain required.
- Mobile conversations require the run's own conversation and confirm its server shape before checking the populated list. Drafts require Member and confirm the ready draft's server shape before checking Save. Non-live browser shape responses attach status, row counts and completion to `shape-reads.json`, without row contents, parameters or credentials.
- Mobile docs journeys read the live VibeLang docs source. A refused read remains a failure, with its HTTP status and refusal reason attached as `docs-reads`; a service failure is not a layout pass.
- The real model (`liveModel`), which locally needs `CEREBRAS_API_KEY` in the environment or `apps/mvp/.env` (checked for presence only). The Mac mini's dev server has no model, so a spec that waits for real answers skips there.
- The account's role (`member`, `maintainer`). A role need is **blocked** rather than skipped: the run lacks a prerequisite, and the run fails until it has it.
- The run's own conversation (`ownConversation`, also blocked), for every test that asks:
  - A deployment run never asks in the team's home conversation, which every Member reads.
  - The setup tracks the test account's own branch, `roninjin10/smithers-github-tests` `smithers-e2e`, and a test that asks opens it (`home()` in `e2e/target.ts`). `Tab.send` declares the need too.
  - Tracking reads the branch from the deployment's Code Storage mirror, so it waits until the deployment can clone that repository.
- A test that checks logs only where it can uses `partly("localLogs")`, and the summary lists it.
- A deployment test never signs out: that would end the run's shared session.

**Broken.** A test known to fail on a target is marked `broken(name)` (TEST-5), naming its entry in `KNOWN_BROKEN` (`e2e/target.ts`). It is expected to fail there. If it passes, the run fails until the mark is removed. No entry is known today: `remoteFlows` was removed once production's remote flows ran (2026-10-21).

**Summary.** The run ends with a table: each spec's passed, failed, broken, skipped and blocked counts, then each skip reason with its count. It writes `test-results-deployment/summary.json`. The command exits 1 on any of these:
- a failure;
- a skip that names no need;
- a blocked need;
- a broken test that passes.

**Spend.** Before each test that can ask, a guard adds up the tokens the run's answers used (`e2e/spend.ts`). From `E2E_TOKEN_BUDGET` (600,000 by default) on, later tests fail with `SpendBudgetSpent`. Every run alerts the Admins on spend (AUTH-4).

**Fixtures.** For a Member or above, the setup requests clones of `octocat/Spoon-Knife` and of the own branch's repository (`POST /api/repos`, idempotent), then tracks the own branch (`POST /api/branches`). It records the branch only when the branch is the account's own and unshared.

**One run at a time.**
- `pnpm e2e:prod` holds a lock directory for the whole run: `E2E_PROD_LOCK`, or `run.lock` beside the stored session.
- Its `owner` file names the run's pid and checkout. Another run waits for it.
- A lock whose owner process has ended is reported and left in place for a person to remove.

**Results.**
- Playwright's results go to `test-results-deployment/`, apart from a local run's.
- Videos and GIFs go to `~/Desktop/smithers-mvp/prod/`.
- Two workers, no retries and no traces: a trace holds the session cookie.

**Rehearsal.** A local stack that signs in through GitHub runs as a deployment: `E2E_TARGET=deployment BASE_URL=http://localhost:1338 pnpm exec playwright test`.

### Server and console errors

Every e2e test, locally and against a deployment, fails on each of these that its browsers report and it didn't declare (`e2e/watch.ts`, `e2e/problems.ts`):

- a response of 500 or above from the app's origin, to any request;
- a failed `/api/` request, such as a reset connection, an empty response or an HTTP/2 error. A request the page cancelled itself (`net::ERR_ABORTED`: a navigation, a closed page, an interrupted fetch, the telemetry exporter giving up after 10 s) doesn't count, and neither does one an offline device couldn't send;
- a console error, including Chrome's line about a refused response, such as a 401. Electric's 409 on a shape, which tells its client to start the shape again, doesn't count, and neither does a failed load from a server on this machine that isn't the app: a test fixture an earlier test stopped;
- an uncaught page error.

The check watches every browser context a test opens: the default page's, each device's (`e2e/devices.ts`) and any the test opens itself. A failing test's `browser.log` ends with the list. Each problem shows its status, method and path, with the query's parameter names but no values, then its count, marked `declared` or `UNDECLARED`.

WebKit also emits a native `Fetch API cannot load … due to access control checks` diagnostic when navigation
discards a document before its fetch reaches the network. Playwright delivers it as `pageerror` or a console error despite no window
error or unhandled rejection. The watcher records it as a navigation cancellation only for a same-origin API URL,
after an actual old-document request cancellation, while the main-frame navigation is uncommitted, for at most two
seconds. WebKit can report that cancellation up to 100 ms before its navigation request event. The watcher observes
a stable token in the real window because `framenavigated` also fires for `pushState`, and binds navigation failures
to their request and redirect chain. Unknown identity establishes no exemption. Classification waits until teardown
and checks every matching read; a pending read, HTTP refusal, read completed during departure or transport error remains a failure.
A successful request completed before departure is a previous exchange, not the later pre-dispatch fetch: repeated
telemetry exports share a URL. Its completion time distinguishes those exchanges without recording payloads.
A diagnostic on a committed or active page gets no exemption. `request-cancellation.spec.ts` requires the native
receipt against a compiled deployment; development also exercises cancellation, which Vite may handle quietly.

On macOS, WebKit’s embedder isolates cookies and IndexedDB by `userDataDir` but shares OPFS through Foundation’s
home directory. `e2e/persistent.ts` gives each browser process a separate `CFFIXED_USER_HOME`; closing it removes
only that device’s directory. The native `browser-isolation.spec.ts` opens no app JavaScript and verifies that a
second device cannot read the first device’s OPFS marker. No stored owner or authorization check is bypassed.

A test that causes one on purpose declares it, in its body or in a file or describe block:

```ts
import { expectConsoleError, expectServerError } from "./watch"

expectServerError(503, "/api/auth/session") // a 503 response on that path; * stands for any characters
expectServerError("failed", "/api/runs/*/credential") // a request that got no response
expectServerError(401, "/api/shapes/pulls") // Chrome's console error about a refused response
expectConsoleError("Sync failed") // a console or page error containing the text
```

Two declarations come from outside the test body:

- **The environment.** A local dev server without Code Storage answers its clones and repository reads `503 not_configured`. Without a model key, its model endpoint answers `502`. Without the GitHub App, GitHub's anonymous allowance runs out during a suite and About reads answer `503 rate_limited`. Every test on such a server has those declared (`environmentAnnotations`, `e2e/problems.ts`), and its `browser.log` says so. A deployment has all three services, so nothing is declared there.
- **Going offline.** `Device.offline()` declares each WebSocket that can't connect. On a dev build it also declares what the dev server's service worker never cached: Vite's client, and modules, workers and fonts no page fetched while online (`expectOfflineErrors`).

Nothing else may declare one, and `e2e/health.spec.ts` declares none. A spec builds on `test` from `e2e/fixtures.ts` or `e2e/devices.ts`, or on `strictTest` from `e2e/watch.ts`, never on Playwright's own; `e2e/target.test.ts` checks. The reason: from 2026-10-24 smithers.sh answered its shapes `500` 60 to 600 times an hour and no spec failed, because the browser retries a failed shape and the specs checked only what rendered in the end.

**Health.** `e2e/health.spec.ts` cold-loads `/`, `/smithersai/smithers` and `/smithersai/vibelang`, signed out and signed in, in eight fresh browsers at once per case. It waits until every shape each page asked for is up to date, which is when a response to it carries Electric's `electric-up-to-date` header (`e2e/sync.ts`). Locally, the repository pages need Code Storage (`codeStorage`), since their refs come from it. Run it first after every deploy ([Deploy](#deploy), step 4).

### Limits

### W10 Electric release measurement (2026-10-26)

The pushed W10 build `5527d82bfd9c` uses the private Workers Cache, a ten-second live hold and summary-only list shapes. `bench/electric-load`'s S5b marker-aware runner followed routes observed from the deployed pages: 50 signed-out clients across three networks and 20 signed-in clients of one person, each for 120 seconds. The signed-in home route set additionally follows `github-sync` to observe the same uniquely marked write as the signed-out pulls page. Write latency starts at the scheduled SQL write time and includes SQL latency; it is not a two-person isolation or restart proof.

| Clients | Aggregate window s | Requests | 5xx | 503 | 429 | Unanswered | Up-to-date p99 ms | Never up to date | Write-to-all p99 ms | Missed write | Release thresholds |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 50 signed out + 20 signed in | 121 | 8180 | 0 | 0 | 0 | 0 | 4386 | 0 | 417 | 0 | PASS |

The release thresholds are zero 5xx/503/429, up-to-date p99 at most 10,000 ms and write-to-all p99 at most 25,000 ms, with every observed route and write reaching its client. This is one observed run, not a capacity guarantee. Content-free evidence: [W10 release record](../bench/electric-load/evidence/w10-release-2026-10-26.json).


- **Answers run in browsers.** ChatApi answers nothing itself: each answer is a run on the asking browser's engine ([agent.md](features/agent.md)), so an answer pauses while that browser has no tab of the app open and resumes when one opens. An answer whose browser never comes back stops holding up later answers once it has gone `ANSWER_TURN_LIVE_SECONDS` without a write, and the remote flow `chat/Expire`, which ChatApi starts for every question it takes, settles it `failed` (`abandoned`) once its queue (it, and the earlier answers in its conversation) has been still for `ANSWER_EXPIRY` (25 minutes) ([agent.md](features/agent.md#settling)).
- **Budgets.** The model endpoint refuses calls once the deployment's tokens for the UTC day reach `MODEL_DAILY_TOKEN_BUDGET`, and bounds each call's output tokens and messages; a call whose spend is unknown (cancelled, failed, or never reported) counts at its worst case ([model-endpoint.md](features/model-endpoint.md#budget)). There is no budget per person yet.
- **Connections.** ChatApi opens one Postgres connection per request, within Workers' limit of six open connections per invocation. The database's connections are budgeted per client ([Connections](#connections)).
- **Startup.** Cloudflare refuses a deploy whose Worker takes longer than its startup limit to evaluate its modules. ChatApi's top level holds only its settings: its program (`worker/ChatApiProgram.ts`) is imported when the Worker first builds it, so its modules count against the first request instead. Measured on 2026-10-21 as a scratch Worker's `startup_time_ms`: 416 to 735 ms with the whole program at the top level, one deploy refused at random; 86 to 137 ms after. `worker/ChatApi.startup.test.ts` bundles ChatApi as Alchemy does and checks that the program stays behind a dynamic import, outside the startup static dependency graph. The standalone [startup benchmark](benchmarks.md#chatapi-startup) retains the 200 ms median budget; host contention cannot fail the parallel unit gate.
- **CPU and wall time.** ChatApi and the `FlowExecution` objects it hosts get five minutes of CPU per request or alarm (`limits.cpuMs` in `worker/ChatApi.ts`), Cloudflare's most; waiting on Postgres, a model or a machine costs none. An alarm has 15 minutes of wall time. A remote flow's step that runs longer, such as `todo/Implement` (up to 40 minutes), is cut there and the next alarm resumes it: its model calls replay from their sealed steps and its tool calls run once per call id, so nothing is paid or run twice ([remote-flows.md](features/remote-flows.md)).
- **Shape log.** Electric logs each update of a row with the new value of every column it changed, and appending to an answer changes its `text`, so every write of a streaming answer logs the whole answer so far. An answer of `L` characters written in `n` appends adds about `L × n / 2` characters to the shape log: measured on the compose Electric, 20 appends of 40 characters logged 15 KB for an 800-character answer. The browser's agent writes an answer's text at most once a second while it streams (`partsEvery`), so an answer that streams for 40 seconds is written about 40 times and logs about 20 times its length (`L × n / 2`); a fast model's answer logs a few times its length ([agent.md](features/agent.md#streaming)). `REPLICA IDENTITY FULL` adds nothing to the shape log, since Electric logs only changed columns; it adds each row's old values to Postgres' WAL.
- **Electric's container.** One instance serves all shape definitions. It starts on the first request, which waits until Electric listens, and then keeps running ([Electric](#electric)). Its disk doesn't survive a stop, such as a deploy of the gateway or a crash: Electric then rebuilds its shapes from Postgres and clients refetch them, and until it is ready it answers shape requests `503`. While Electric is stopped, Postgres keeps the WAL its replication slot hasn't read.
- **Electric's object.** Every gateway cache miss goes through one Durable Object ([Electric](#electric)). Measured on smithers.sh on 2026-10-26 (main 329127d4, before the object returned Electric's responses untouched) with `bench/electric-load` ([benchmarks.md](benchmarks.md#electric-load)): first-time signed-out visitors of `/smithersai/smithers`, each following its 18 shape routes, spread over three /24 networks, 60 s per row. The rows marked † followed the shapes with Electric's own client instead of the harness's protocol follower.

  | Visitors at once | Requests | req/s | 5xx | Routes not up to date in 10 s | Object requests | Object CPU per request |
  |---|---|---|---|---|---|---|
  | 2 | 146 | 2 | 0 | 0 of 36 | 212 | 62.6 ms |
  | 8 | 755 | 13 | 172 (23%) | 38 of 144 | 727 | 14.8 ms |
  | 16 † | 2,233 | 37 | 1,366 (61%) | 225 of 288 | 1,173 | 15.4 ms |
  | 32 | 4,791 | 80 | 3,802 (79%) | 529 of 576 | 1,304 | 16.7 ms |
  | 50 † | 8,303 | 138 | 7,054 (85%) | 790 of 900 | 2,105 | 13.6 ms |

  The object overloaded from 3 visitors at once (a 20 s run: 114 of 225 responses 500) and never served more than about 35 requests a second (2,105 a minute at 50 visitors): it was CPU-bound at 10 to 17 ms per request. ChatApi recorded its 500s as Electric's (`upstream: "electric"`), and a live tail of the gateway showed "Durable Object is overloaded" for them; the † runs also got 54 and 360 503s. These are the numbers before the fix.

  After it (main 39ccbd83, 2026-10-26 11:17 to 11:30 PDT: the object returns Electric's responses untouched, the gateway answers an overloaded object `503`, ChatApi reaches the gateway by service binding, and a signed-out tab opens only the shapes its page reads), the same harness, networks and 60 s rows. "18 routes" repeats the rows above; "8 routes" follows what a signed-out tab on `/smithersai/smithers/pulls` opens now (the repository's home opens 4, its issues 7).

  | Visitors at once | Routes | Requests | req/s | 5xx (of them 503) | Routes not up to date in 10 s | Object requests | Object CPU per request |
  |---|---|---|---|---|---|---|---|
  | 8 | 18 | 592 | 10 | 0 | 8 of 144 | 736 | 6.6 ms |
  | 16 | 18 | 1,152 | 19 | 0 | 68 of 288 | 1,440 | 2.9 ms |
  | 32 | 18 | 2,218 | 37 | 1,225 (261) | 424 of 576 | 2,678 | 2.3 ms |
  | 50 | 18 | 3,604 | 60 | 2,449 (1,422) | 704 of 900 | 4,263 | 0.2 ms |
  | 8 | 8 | 241 | 4 | 0 | 64 of 64 | 305 | 3.0 ms |
  | 16 | 8 | 528 | 9 | 0 | 19 of 128 | 656 | 2.8 ms |
  | 32 | 8 | 1,007 | 17 | 0 | 88 of 256 | 1,263 | 1.2 ms |
  | 50 | 8 | 2,139 | 36 | 1,089 (896) | 247 of 400 | 1,618 | 0.2 ms |

  The first 5xx moved from 3 visitors to between 16 and 32 with 18 routes, and to between 32 and 50 with a signed-out tab's 8. At 32 and 50 visitors the 500s are not the object's: Cloudflare counted every object and gateway invocation in those windows a success, so the 500s came from Electric's container or ChatApi; the 503s are the gateway's answer to an overloaded object. No row meets the launch bar (zero 5xx, every route up to date within 10 s), these are the pre-cache measurements.
- **Electric with Workers Cache.** S5b's experimental revision `77972d9a1e5d` (base `cc6dee07`), measured live 2026-10-26, basic container, ten-second hold. Fifty signed-out clients on three networks and twenty signed-in tabs of one person ran for 120 seconds each, 123 seconds aggregate. These are trial measurements, not a new deployment receipt.

  | Responses | 5xx / 503 / 429 / unanswered | Up-to-date p50 / p99 / max | Write-to-all p99 | Delivered |
  |---:|---|---|---:|---|
  | 8,417 | 0 / 0 / 0 / 0 | 2,881 / 15,299 / 15,483 ms | 544 ms | 70/70 |

  Thirty-seven signed-out comments/items pairs exceeded ten seconds, so the freshness bar still failed. Sampled Electric CPU utilization peaked at 27.1%; Neon connections peaked at 81/450 with zero lock waiters. Instantaneous Neon CPU was unavailable. In five separate 100-caller rounds, every canonical key produced one gateway-to-object call: two empty rounds advanced, a write reached 100/100, initiating-caller abort left 99/99, and 30% abort left 70/70; all 469 responses were 200 and browser private/no-store. Direct object arrival records were absent from that capture. Clock bounds were within about 0.32 seconds; write timing includes SQL latency. These trials do not prove distinct-person capacity, existing-client restart recovery, or that a larger container is required. [Decision 0115](decisions/0115-electric-workers-cache.md) records the method and limits.
- **HTTP/1.1 at http://localhost:1337.** A browser opens at most six connections to it, fewer than a tab's shapes, so a change can take up to 40 seconds to reach another device there, and Electric's client warns about plain `http://`. Use https://localhost:1443, which speaks HTTP/2 as Cloudflare does ([HTTPS and HTTP/2](#https-and-http2)).


### Electric S5 cache trials (2026-10-26)

**S5 is not ready to land.** Workers Cache was accepted by the account through Alchemy beta.83. A non-live `items`-only trial returned 40/40 HTTP 200 responses (eight concurrent), all browser `private, no-store`. A sampled ChatApi tail recorded cache hits. This verifies availability and finite cache hits, not live collapsing or isolation.

The earlier 32-device, 18-route reproducer returned 2,160 responses in 60 seconds: 846 HTTP 500, 230 HTTP 503, no 429. The gateway tail itself contained HTTP 500 responses, and captured Electric error bodies included an internal-server error and a replication-client readiness timeout. These errors originate below ChatApi; successful Worker invocation outcomes do not imply successful HTTP responses. Container CPU utilization peaked at a raw `cpuUtilization` value of 1.544 in the surrounding load windows. CPU pressure is a hypothesis supported by these observations and the sizing trial, not proof of every failure's cause.

The private-hop trace also exposed a retained legacy Electric secret parameter. Removing a declared resource had not guaranteed a credential-free request. `infra/ElectricUpstream.ts` now removes `secret`, Authorization and Cookie before invoking the private binding; ordinary upstream connections keep their configured credentials. Its regression fails without that transformation. No secret value is recorded here.

Trials used 50 signed-out devices on the eight-route pulls page and 20 signed-in tabs of the test person, for 120 seconds, across three networks. Every 5xx and 429 is counted, including responses the clients subsequently retry. All trials used the same Workers Cache policy: cache only public HTTP 200 responses, never errors or 409s, retain Electric's lifetimes, bypass SSE and isolate cache generations by Worker version. Browser responses remained private and uncached.

| Trial | Responses | 5xx (of them 503) | 429 | Up-to-date p99 | Device/route pairs over 10 s |
|---|---:|---:|---:|---:|---:|
| `basic` with cache | 3,413 | 685 (140) | 0 | 42,668 ms | 313 |
| `standard-1`, size rollout overlapping load | 5,589 | 1,775 (1,739) | 0 | 26,932 ms | 115 |
| `standard-1`, after rollout delay and 40 successful initial reads | 2,789 | 25 (0) | 0 | 19,267 ms | 44 |

The size rollout caused many handle resets, so its first row is not steady-state capacity evidence. The settled trial improves headroom but still fails the launch bar. In the `basic` cache window, Cloudflare analytics counted 3,198 object requests and 4,214 ChatApi invocations (including non-shape requests and disconnections); this does not establish the required signed-out collapse ratio of at most 0.1. Gateway observations on the larger instance confirmed public five-second live policies, so the live miss rate is not explained by a missing cache header. No write-to-all-devices latency was measured.

At [Cloudflare's published rates](https://developers.cloudflare.com/containers/platform/pricing/), `standard-1` supplies half a vCPU, 4 GiB RAM and 8 GB disk. Thirty days continuously provisioned cost about $27.37 for RAM and disk versus $7.21 for `basic` (roughly $20 more), before allowances. CPU costs $0.000020 per active vCPU-second; continuous full allocation would add $25.92 versus $12.96 per month. These are estimates excluding Workers, Durable Objects and egress. No sizing change is retained.

Each trial restored the then-current main revision through Alchemy under the production lock. The final restoration used `cc6dee07`; afterward, initial reads of `items`, `pulls`, `github-sync` and `comments` each returned HTTP 200. Cache activation and the larger instance remain experimental. Abort and deliberate mid-load restart runs were not executed after the failed load gates. The two-person, twenty-tabs-each isolation run additionally needs a second real production test account: the saved production sessions identify the same person. No isolation, restart, abort or launch-capacity pass is claimed. Decision [0114](decisions/0114-electric-cache-trial.md) records the boundary and the remaining gates.

## Electric deployment isolation

[Decision 0118](decisions/0118-electric-runtime-worker.md): `ElectricRuntime` owns `ElectricObject` and its container;
`ElectricGateway` binds that namespace across scripts. ChatApi, frontend and gateway cache edits must not update the
runtime script or its container resource. `ElectricConfig.ts` carries the container's long-poll setting, independent
of gateway policy. Only the runtime receives `ELECTRIC_DATABASE_URL`. Both Workers have no public URL.

`electric.container.start` records `startedAt` (milliseconds when a successful start returns) and `instanceId` (the
Durable Object identity that owns the container). A failed start records no success. This record is not the provider's
placement timestamp; use the provider's placement/start receipt for deployment verification. No URL, environment,
shape parameter or credential is logged. Existing `electric.object.request` records retain wake timings and status.

### Lander procedure

Run under the existing deployment lock and private hosted Layer. No builder deployment or production load test is
part of this change. Keep raw plan/state/API outputs private; publish only hashes, counts and safe lifecycle fields.

1. Rebase onto pushed main. Run `pnpm plan` from `apps/mvp`. Inspect the initial plan: new `ElectricRuntime`, same
   `ElectricObject` class and `electric` instance name, same Electric image/env/instance type. The destination declares
   `transferredFrom: "ElectricGateway"`; gateway's namespace binding has the destination's script name. Stop if the
   existing namespace is scheduled for deletion or a second fresh namespace is created instead of transferred.
2. Run `pnpm run deploy --yes`. Alchemy's `.from(runtime.workerName)` dependency orders the runtime before the
   gateway. The destination prepares the expecting-transfer export and the source relinquishes it with a transferred
   export; Alchemy performs this handshake. Do not create the destination class first, delete the old namespace, or
   remove `transferredFrom`. The class transfer may cause this **one** cold start. Verify the original namespace ID
   now belongs to the runtime, the container application points at it, and the gateway references that same ID.
   Deploy again if Alchemy's interrupted transfer needs convergence; never manually recreate either resource.
3. Warm shapes with the private `prod-health/check.py --minutes 15 --rounds 1 --devices 1`; let migration recovery
   finish. Save a safe provider container snapshot as `electric-before.json` containing exactly `instanceId` and
   `startedAt`. Use the private infrastructure tooling's container placement/instance query; these are provider
   values, not Worker deployment time or the time of the snapshot. Configure a local executable `$ELECTRIC_SNAPSHOT`
   to print exactly those two fields for the same Electric container. Verify it emits no URLs or secrets.
4. Make a ChatApi-only observable edit: change `worker/ChatApi.ts` props' `observability.logs.invocationLogs` from
   `true` to `false`. Run `pnpm plan`: **ElectricRuntime and Electric container must be noop**. Save the private plan
   and runtime bundle/metadata hashes. Run `pnpm run deploy --yes`. Start the gate immediately:

   ```sh
   python3 scripts/check-electric-deploy.py --baseline electric-before.json \
     --health-check "$PROD_HEALTH_CHECK" -- "$ELECTRIC_SNAPSHOT"
   ```

   `$PROD_HEALTH_CHECK` is the lander's existing private `prod-health/check.py`. Add the new runtime script to that
   private probe's analytics script selection. The gate probes one device, stops on the first failed probe, and
   compares provider start/instance before, during and after 15 minutes. Save its exit code and counts; require zero
   503s and zero other 5xx, signed in and signed out. This is a health check, never a load run against smithers.sh.
5. Restore `invocationLogs: true`, plan and deploy; again require runtime/container noop and unchanged provider
   lifecycle receipt. Run the existing gateway/sync/recovery deployment specs. Keep the proof receipts with the
   deployment record. No live restart-survival or zero-503 claim is made until this lander gate passes.

Migration state check: Electric uses Alchemy's existing default/fleet container, not
`schedulingPolicy: "durable_object"`. Keep the root `Electric` resource and the transferred namespace ID unchanged.
No host-keyed `ElectricObject-Containers` resource or state alias is needed. The initial plan must not delete or
replace the existing Electric application. `electric_container_starts` counts successful starts; instance identity
stays in logs, not metric labels.

The snapshot adapter uses the provider's
[`GET /accounts/{account_id}/containers/applications/{application_id}/instances/{instance_id}`](https://developers.cloudflare.com/api/resources/containers/subresources/applications/subresources/instances/methods/get/):
require `status.state == "running"`, select only `id` as `instanceId` and `started_at` as `startedAt`, and fail if either
is missing. The instance id is the 64-character Durable Object actor id (`electric.container.start`'s identity).
Keep account/application selection and credential injection in the private hosted Layer. The gate rejects extra
snapshot fields so accidentally passing the full provider response cannot leak it into proof output.
# Missing documents

The site Worker matches the shared TanStack route declarations before returning the app shell. Unsupported document paths return 404 with the same recovery UI and `X-Robots-Tag: noindex`. Supported deep links keep 200; their resource reads decide access and existence. Plugin paths come from their public manifests.


The documentation build omits the legacy `/bug/` noindex redirect from generated sitemap chunks; the app form remains its destination.


### Correlating a truncated shape response

Every shape response carries `x-request-id`, matching the proxy's `correlationId`.
Its completion record includes the route, first/catch-up/live phase, status,
bytes, duration and complete/aborted/failed outcome, without protocol values or
row content. A probe must preserve that ID and the UTC start and failure times
even if reading the body fails. Compare the failed read with its proxy record
and the serving Workers' invocation outcomes and wall/CPU durations. Aggregate
success counts alone cannot establish that a particular body reached a client;
a later successful probe does not resolve an earlier truncation.
