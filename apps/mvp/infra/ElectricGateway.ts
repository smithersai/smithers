// The Electric gateway Worker: answers `GET /v1/shape` by forwarding it to the one Durable Object that runs Electric's
// container, and refuses everything else before the container starts (infra/ElectricAccess.ts). An overloaded object is
// answered 503 (infra/ElectricRelay.ts). alchemy.run.ts declares it in production only. It has no public URL: ChatApi
// reaches it through a service binding (infra/Electric.ts).
import type { RuntimeContext } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import { Config, Context, Effect, Option, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { ELECTRIC_POOL_SIZE } from "./Connections.ts"
import { directOr, forward, type Host, isLive, logged, makeAwake, makeInFlight } from "./ElectricAwake.ts"
import { LONG_POLL_TIMEOUT_MS, serve } from "./ElectricCache.ts"
import { workerBuild } from "./WorkerBuild.ts"

/** The Electric release the app is built against; docker-compose.yml runs the same one. */
const IMAGE = "electricsql/electric:1.8.1"

/** The port Electric serves its HTTP API on inside the image. */
const PORT = 3000

/** A container port's `fetch`, as the gateway's object calls it. */
interface Fetch {
  readonly fetch: (url: string, init: Request) => Promise<Response>
}

/** The one Durable Object, and so the one container, every shape request goes to. */
const INSTANCE = "electric"

/**
 * The Worker binding that holds Postgres' direct URL, password included, as a secret: the gateway's object hands it to
 * Electric's container when it starts it, so the URL is never in the container's configuration, which the Cloudflare
 * API returns in plain text to anyone who can read the account's containers (2026-10-21).
 */
export const DATABASE_URL_BINDING = "ELECTRIC_DATABASE_URL"

/** Postgres' direct URL for the gateway being declared. alchemy.run.ts provides it while it declares the gateway. */
export class DatabaseUrl extends Context.Service<
  DatabaseUrl,
  { readonly value: Output.Output<Redacted.Redacted<string>> }
>()("@smthrs/mvp/infra/ElectricGateway/DatabaseUrl") {}

/**
 * Electric itself, on Postgres' direct host. Its storage directory is the container's disk, which a restart empties:
 * Electric then rebuilds its shapes and clients refetch (docs/infrastructure.md#limits).
 *
 * It runs without a secret of its own (`ELECTRIC_INSECURE`): a container has no way in but its Durable Object, and the
 * object none but the gateway, which only ChatApi's service binding reaches. Electric takes its secret only as a URL
 * parameter, and Workers Traces records a subrequest's URL, so a secret on the hop to the container would land in the
 * traces.
 * `DATABASE_URL` isn't here: the object passes it when it starts the container (`DATABASE_URL_BINDING`).
 */
export const containerProps = {
  image: IMAGE,
  // 1/4 vCPU, 1 GiB of memory and 4 GB of disk; the default `lite` (256 MiB) is too small for Electric.
  instanceType: "basic",
  maxInstances: 1,
  // Its query pool is its share of the compute's connections (infra/Connections.ts `CONNECTION_BUDGET`).
  env: { ELECTRIC_INSECURE: "true", ELECTRIC_DB_POOL_SIZE: String(ELECTRIC_POOL_SIZE), ELECTRIC_LONG_POLL_TIMEOUT: String(LONG_POLL_TIMEOUT_MS) },
} as const

class Electric extends Cloudflare.Container<Electric>()("Electric", containerProps) {}

/**
 * Starts Electric's container when a request needs it, with Postgres' direct URL from the Worker's secret binding as
 * its `DATABASE_URL`, holds it running for 6 hours after its last request (infra/ElectricAwake.ts), and forwards each
 * request to its port, recording how long waking and Electric's headers took. Electric's response goes back as the
 * container sent it (`directOr`), its body never re-streamed through the object.
 */
class ElectricObject extends Cloudflare.DurableObject<ElectricObject>()(
  "ElectricObject",
  Effect.gen(function* () {
    const electric = yield* Electric
    // Once per object instance: its waker remembers whether this instance has held the container.
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState
      const port = yield* electric.getTcpPort(PORT)
      const inFlight = makeInFlight()
      const databaseUrl = yield* Config.Redacted(DATABASE_URL_BINDING).pipe(Effect.orDie)
      const wake = makeAwake({
        running: electric.running,
        // Electric reaches Postgres over the internet.
        start: electric.start({ enableInternet: true, env: { DATABASE_URL: Redacted.value(databaseUrl) } }),
        setInactivityTimeout: (ms) => electric.setInactivityTimeout(ms),
      } satisfies Host<unknown, RuntimeContext>)
      return {
        fetch: logged(Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const direct = Effect.gen(function* () {
            const web = yield* HttpServerRequest.toWeb(request)
            const url = new URL(web.url)
            url.protocol = "http:"
            // workers-types' Fetcher takes and returns the runtime's own Request and Response, which the DOM types name.
            const electricPort = state.container!.getTcpPort(PORT) as unknown as Fetch
            const response = yield* Effect.tryPromise(() => electricPort.fetch(url.href, web))
            // A raw `Response` body is handed back untouched (`HttpServerResponse.toWeb`).
            return HttpServerResponse.raw(response, { status: response.status })
          })
          return yield* forward(wake, directOr(direct, port.fetch(request)), isLive(request.url), inFlight)
        })),
      }
    })
  }),
) {}

/** ElectricGateway's Worker settings; infra/WorkerBundles.test.ts bundles the Worker from them. */
export const props = {
  main: "infra/ElectricGateway.ts",
  // Alchemy's Neon module, which the container's declaration names, imports node:crypto.
  compatibility: { date: "2026-10-01", flags: ["nodejs_compat"] },
  // No public URL at all, neither workers.dev nor per-version previews: ChatApi's service binding is the only way in.
  workersDev: { enabled: false, previewsEnabled: false },
  cache: { enabled: true, crossVersionCache: false },
  build: workerBuild,
  observability: {
    enabled: true,
    logs: { enabled: true, invocationLogs: true, persist: true },
    traces: { enabled: true, persist: true },
  },
}

export default class ElectricGateway extends Cloudflare.Worker<ElectricGateway>()(
  "ElectricGateway",
  props,
  Effect.gen(function* () {
    // Binds Postgres' direct URL as a secret while Alchemy plans the gateway; at runtime the binding is there.
    const databaseUrl = yield* Effect.serviceOption(DatabaseUrl)
    if (Option.isSome(databaseUrl)) yield* Output.named(databaseUrl.value.value, DATABASE_URL_BINDING)
    const objects = yield* ElectricObject
    return {
      fetch: logged(serve((request) => objects.getByName(INSTANCE).fetch(request))),
    }
  }),
) {}
