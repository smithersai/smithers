// Electric owns a script independent of app and gateway deployments (decision 0118).
import type { RuntimeContext } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import { Config, Context, Effect, Option, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { ELECTRIC_POOL_SIZE } from "./Connections.ts"
import { directOr, forward, type Host, isLive, logged, makeAwake, makeInFlight, recordStart } from "./ElectricAwake.ts"
import { LONG_POLL_TIMEOUT_MS } from "./ElectricConfig.ts"

/** The Electric release the app is built against; docker-compose.yml runs the same one. */
const IMAGE = "electricsql/electric:1.8.1"

/** The port Electric serves its HTTP API on inside the image. */
const PORT = 3000

/** A container port's `fetch`, as the gateway's object calls it. */
interface Fetch {
  readonly fetch: (url: string, init: Request) => Promise<Response>
}

/** The one Durable Object, and so the one container, every shape request goes to. */
export const INSTANCE = "electric"

/**
 * The Worker binding that holds Postgres' direct URL, password included, as a secret: the gateway's object hands it to
 * Electric's container when it starts it, so the URL is never in the container's configuration, which the Cloudflare
 * API returns in plain text to anyone who can read the account's containers (2026-10-21).
 */
export const DATABASE_URL_BINDING = "ELECTRIC_DATABASE_URL"

/** Postgres' direct URL for the Electric runtime being declared. alchemy.run.ts provides it while it declares the gateway. */
export class DatabaseUrl extends Context.Service<
  DatabaseUrl,
  { readonly value: Output.Output<Redacted.Redacted<string>> }
>()("@smthrs/mvp/infra/ElectricRuntime/DatabaseUrl") {}

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
export class ElectricObject extends Cloudflare.DurableObject<ElectricObject, {}>()(
  "ElectricObject", { transferredFrom: "ElectricGateway" },
) {}

const ElectricObjectLive = ElectricObject.make(
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
        start: recordStart(electric.start({ enableInternet: true, env: { DATABASE_URL: Redacted.value(databaseUrl) } }), state.id.toString()),
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
)

/** This owner has no request cache, public route, app imports or shared app build plugins. */
export const props = {
  main: "infra/ElectricRuntime.ts",
  compatibility: { date: "2026-10-01", flags: ["nodejs_compat"] },
  workersDev: { enabled: false, previewsEnabled: false },
  observability: {
    enabled: true,
    logs: { enabled: true, invocationLogs: true, persist: true },
    traces: { enabled: true, persist: true },
  },
}

export class ElectricRuntime extends Cloudflare.Worker<ElectricRuntime, {}, ElectricObject>()("ElectricRuntime") {}

export default ElectricRuntime.pipe(Effect.provide(ElectricRuntime.make(
  props,
  Effect.gen(function* () {
    const databaseUrl = yield* Effect.serviceOption(DatabaseUrl)
    if (Option.isSome(databaseUrl)) yield* Output.named(databaseUrl.value.value, DATABASE_URL_BINDING)
    yield* ElectricObject.pipe(Effect.provide(ElectricObjectLive))
    return { fetch: Effect.succeed(HttpServerResponse.empty({ status: 404 })) }
  }),
)))
