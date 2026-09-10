/**
 * The deployed Worker: Alchemy's Effect-native Cloudflare Worker for
 * `smithers-mvp-web`. Importing this module deploys nothing; alchemy.run.ts
 * files it under a Stack and `alchemy deploy` (scripts/deploy.ts) reconciles.
 *
 * Two phases (alchemy `Cloudflare.Worker` docs, Worker.ts:2121-2131):
 *
 * - init: runs at plan time (bun, on the deploying machine) and once per
 *   isolate at cold start. It declares the bindings (vars, secrets through
 *   `Config`, the five Durable Object namespaces, the site assets), registers
 *   the five Durable Object classes under their frozen names, and builds this
 *   Worker's service Layers once per isolate.
 * - runtime: `fetch` runs per request. It takes the web `Request` Alchemy
 *   provides, runs the router `handleRequest` from src/index.ts over the
 *   isolate's services, and hands the web `Response` back as an
 *   `HttpServerResponse`.
 *
 * Identity. Every deploy-time fact (name, domain, route, assets, Durable
 * Object binding AND class names, compatibility) comes from
 * src/workerIdentity.ts, which src/workerIdentity.test.ts pins.
 *
 * Durable Objects keep both names. Alchemy's class-form
 * `Cloudflare.DurableObject<Self>()("Name")` hard-codes binding name ==
 * class name (DurableObject.ts:1148-1153 binds `{ name: namespace,
 * className: namespace }` and :1251 exports the class under `namespace`),
 * and the bundle's virtual entry exports one class per key of the Worker's
 * export map (Sources/Rolldown.ts:211-262, emitting `export class <key>
 * extends DurableObjectBridge("<key>") {}` at :251). So this module bypasses
 * the class form: the binding is the props-form descriptor
 * `Cloudflare.DurableObject("TURN_CANCELS", { className: "TurnCancelRegistry" })`
 * declared in `env` — a plain `{ kind, name, className }` value
 * (DurableObject.ts:1260-1268) lowered to `{ type:
 * "durable_object_namespace", name: "TURN_CANCELS", className:
 * "TurnCancelRegistry" }` by WorkerAsyncBindings.ts:464-471, logical id = the
 * env key — and the class is registered with
 * `worker.export("TurnCancelRegistry", …)`, the same call the class form
 * makes (DurableObject.ts:1251), which stores it under that key
 * (WorkerRuntimeContext.ts:78-81). The adopting deploy then matches each
 * binding to the live one by binding name and reuses the live class
 * (WorkerProvider.ts:3445-3474): no migration, no data movement.
 *
 * Secrets. Each is `yield*`ed as a `Config` in init. At plan time Alchemy's
 * ConfigProvider interceptor (Platform.ts:554-593) records the value as
 * `Output.literal(Redacted.make(value))`, which the runtime context keeps
 * Redacted-outermost (WorkerRuntimeContext.ts:48-57) and the lowering turns
 * into a `secret_text` binding of the same name (WorkerAsyncBindings.ts:
 * 366-373) — `Config.string` included, so the optional knobs deploy as
 * secrets too. At runtime the same `yield*` reads the binding back. Values
 * are unwrapped here, once, into the plain env bag `layersFromEnv` turns into
 * `ServerConfig` (which re-wraps them in `Redacted`). Nothing else in the
 * Worker sees a raw secret — and nothing may read one out of the raw `env`
 * bag, where a Config-bound value is the packed string
 * `{"_tag":"Redacted","value":…}` (RuntimeContext.ts:100-114).
 *
 * Boundaries. Alchemy runs Effects itself, so this module has no
 * `runPromise`. The promise-shaped seams are the Durable Object storage
 * adapters (wrapped by src/DurableStorage.ts and src/recommend.ts) and the
 * platform `waitUntil`, handed to the router as a plain function.
 *
 * Running it. The CLI must run under bun: `node_modules/.bin/alchemy` is a
 * launcher that re-execs under node unless the environment names bun (alchemy
 * bin/cli.js:98-116), and node cannot resolve this package's extensionless
 * imports. See DEPLOY.md, "Run the Alchemy CLI under bun, always".
 */
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { clientDisconnectedResponse, responseFromExit } from "./Boundary"
import { clientErrorLogRequest, clientErrorThrottleLayer, makeClientErrorThrottle } from "./clientErrorLog"
import { storageLayer } from "./DurableStorage"
import type { NativeStorage } from "./DurableStorage"
import type { ServerEnvVars } from "./Config"
import { ExecutionContext, executionContextFrom, layersFromEnv } from "./Environment"
import type { WorkerEnv } from "./Environment"
import { gatewayRegistryLayers, gatewaySessionRequest } from "./gateway"
import { handleRequest } from "./index"
import { recommendLogRequest, recommendStorageLayer } from "./recommend"
import type { NativeRecommendStorage } from "./recommend"
import { turnCancelRequest } from "./turns"
import { turnRateLimiterRequest } from "./turnLimit"
import { WORKER_IDENTITY } from "./workerIdentity"

/**
 * One Durable Object class: the module's request Effect and the Layers its
 * services come from. `layers` is called ONCE per in-memory object, in the
 * outer (per-object) Effect below, so a service that holds the object's
 * in-memory state — the client-error throttle window — is made there and
 * lives as long as the object does. A Layer built per request would hand
 * every request a fresh window, which is no throttle at all. docs/EFFECT.md,
 * "Durable Objects", states the rule.
 *
 * The platform storage object carries `get`/`put`/`delete`/`list` as
 * promises; the module's own adapter (`storageLayer`, `recommendStorageLayer`)
 * is the one boundary that wraps them.
 */
interface DurableObjectClass<Storage, R> {
  readonly handle: (request: Request) => Effect.Effect<Response, never, R>
  readonly layers: (native: Storage) => Layer.Layer<R>
}

const durableObjectClass = <Storage, R>(
  handle: (request: Request) => Effect.Effect<Response, never, R>,
  layers: (native: Storage) => Layer.Layer<R>
): DurableObjectClass<Storage, R> => ({ handle, layers })

/**
 * Class name → its Effect body, for one deployment. The keys are the class
 * names WORKER_IDENTITY declares.
 *
 * `env` is the deployment's resolved bag — the platform bindings with the
 * `Config`-read vars and secrets overlaid, the same bag `layersFromEnv` gets.
 * Only `GatewaySessionRegistry` reads it today, and it must: since upstream
 * e089305e5d the registry mints the Cloud token and provisions the workspace
 * INSIDE the object (`POST /resolve`), so without `IDENTITY_UPSTREAM_URL`,
 * `IDENTITY_SERVICE_TOKEN`, `SMITHERS_CLOUD_API_BASE_URL` and
 * `UPSTREAM_TIMEOUT_MS` every resolution answers
 * `unavailable: IDENTITY_UPSTREAM_URL is unset on this deployment.` — a total
 * outage of `/api/workflow/*` that nothing else would catch. The native class
 * takes the same bag as workerd's second constructor argument
 * (`new GatewaySessionRegistry(ctx, env)`, gateway.ts:284).
 *
 * Exported so src/Worker.test.ts can pin that wiring without a deployment.
 */
export const durableObjectClasses = (env: ServerEnvVars): Readonly<Record<string, DurableObjectClass<any, any>>> => ({
  TurnCancelRegistry: durableObjectClass(turnCancelRequest, storageLayer),
  // `gatewayRegistryLayers` also makes the object's join map
  // (`makeGatewayResolutions()`) here, once per object: same rule as the
  // throttle Ref below.
  GatewaySessionRegistry: durableObjectClass(gatewaySessionRequest, (native: NativeStorage) => gatewayRegistryLayers(native, env)),
  TurnRateLimiter: durableObjectClass(turnRateLimiterRequest, storageLayer),
  // The throttle Ref is created here, inside the per-object factory, exactly
  // as the native class does with a field initialiser (clientErrorLog.ts:306).
  ClientErrorLog: durableObjectClass(clientErrorLogRequest, (native: NativeStorage) =>
    Layer.mergeAll(storageLayer(native), clientErrorThrottleLayer(makeClientErrorThrottle()))),
  RecommendLog: durableObjectClass(recommendLogRequest, (native: NativeRecommendStorage) => recommendStorageLayer(native))
})

/**
 * The export descriptor Alchemy's Durable Object bridge instantiates
 * (DurableObject.ts:32-40, DurableObjectBridge.ts:57-89, whose constructor
 * runs it inside `state.blockConcurrencyWhile`): the outer Effect
 * runs once per in-memory object with `DurableObjectState`, the inner one is
 * the object's shape. `klass.layers(...)` therefore runs once per object —
 * that is what makes the client-error throttle window per-object memory —
 * and `fetch` runs the module's request Effect over it.
 *
 * `HttpServerRequest.toWeb` hands back the very `Request` the bridge built
 * the server request from (HttpServerRequest.ts:1051-1053), so no body is
 * re-streamed; its `RequestError` is unreachable on that path.
 */
const durableObjectExport = <Storage, R>(klass: DurableObjectClass<Storage, R>): Cloudflare.DurableObjectExport => ({
  kind: "durableObject",
  constructor: Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    const services = klass.layers(state.raw.storage as unknown as Storage)
    return Effect.succeed({
      fetch: Effect.gen(function* () {
        const request = yield* Effect.orDie(HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest))
        const response = yield* klass.handle(request).pipe(Effect.provide(services))
        return HttpServerResponse.fromWeb(response)
      })
    })
  }),
  services: Context.empty()
})

const optionalSecret = (name: string) => Config.option(Config.redacted(name))
const optionalVar = (name: string) => Config.option(Config.string(name))

const present = (values: Readonly<Record<string, Option.Option<string>>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).flatMap(([name, value]) => (Option.isSome(value) ? [[name, value.value]] : []))
  )

const durableObjectBindings = Object.fromEntries(
  WORKER_IDENTITY.durableObjects.map(({ binding, className }) => [binding, Cloudflare.DurableObject(binding, { className })])
)

/**
 * The props Alchemy deploys. `name` pins the physical script name regardless
 * of stack and stage (Worker.ts:622-626); `domain` and `routes` are attached
 * to whatever already holds them when that is this script
 * (WorkerProvider.ts:1393, :1929-1932).
 */
export const workerProps = {
  name: WORKER_IDENTITY.name,
  main: import.meta.url,
  compatibility: { date: WORKER_IDENTITY.compatibility.date, flags: [...WORKER_IDENTITY.compatibility.flags] },
  workersDev: WORKER_IDENTITY.workersDev,
  domain: { name: WORKER_IDENTITY.domain.name, zoneId: WORKER_IDENTITY.domain.zoneId },
  routes: WORKER_IDENTITY.routes.map((route) => ({ pattern: route.pattern, zoneId: route.zoneId })),
  assets: {
    directory: WORKER_IDENTITY.assets.directory,
    notFoundHandling: WORKER_IDENTITY.assets.notFoundHandling,
    runWorkerFirst: [...WORKER_IDENTITY.assets.runWorkerFirst]
  },
  env: {
    ...WORKER_IDENTITY.vars,
    ...durableObjectBindings
  }
} satisfies Cloudflare.WorkerProps

/**
 * The isolate-lifetime scope the service Layers are built in. workerd never
 * tears an isolate down through us, so it is never closed; Alchemy's own
 * bridge does the same (WorkerBridge.ts:271-279).
 */
const isolateScope = Scope.makeUnsafe()

/**
 * The router, run the way `runRequest` (src/Boundary.ts) runs it, but as an
 * Effect: Alchemy owns the promise, so this entrypoint forks the fiber itself.
 *
 * The client's AbortSignal interrupts that fiber, which is what runs the
 * route's finalizers — the cancel registry settles, the upstream body is
 * released, the provider fetch is aborted — instead of leaving the work
 * running for an isolate nobody is reading. `responseFromExit` is the shared
 * policy: the route's answer, 499 for an interruption, or a logged, generic
 * 500 carrying the isolation headers for a defect.
 *
 * Exported for src/Worker.test.ts, which is where the 499 and the 500 are
 * pinned; a deployment cannot be asked to demonstrate either.
 */
export const runFetch = (
  routed: Effect.Effect<Response, never>,
  signal: AbortSignal
): Effect.Effect<Response> =>
  signal.aborted
    ? Effect.sync(clientDisconnectedResponse)
    : Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(routed)
        const onAbort = () => {
          fiber.interruptUnsafe()
        }
        signal.addEventListener("abort", onAbort, { once: true })
        const exit = yield* Fiber.await(fiber).pipe(
          Effect.ensuring(Effect.sync(() => signal.removeEventListener("abort", onAbort)))
        )
        return responseFromExit(exit)
      })

export const worker = Cloudflare.Worker(
  WORKER_IDENTITY.name,
  workerProps,
  Effect.gen(function* () {
    const secrets = yield* Effect.all(
      Object.fromEntries(WORKER_IDENTITY.secrets.map((name) => [name, optionalSecret(name)])),
      { concurrency: "unbounded" }
    )
    const knobs = yield* Effect.all(
      Object.fromEntries(WORKER_IDENTITY.optionalVars.map((name) => [name, optionalVar(name)])),
      { concurrency: "unbounded" }
    )
    const resolved: Record<string, string> = {
      ...present(knobs),
      ...present(
        Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, Option.map(value, Redacted.value)]))
      )
    }

    // The raw bindings: `{}` at plan time, the platform env at runtime
    // (WorkerBridge.ts:310). The Config-resolved values win over the packed
    // strings Alchemy stores Config-bound values as.
    const env = yield* Cloudflare.WorkerEnvironment
    const deployment = { ...(env as WorkerEnv), ...resolved } as WorkerEnv

    // The Durable Object bodies are registered AFTER the bag exists, and each
    // export closes over it: GatewaySessionRegistry provisions inside the
    // object and cannot do it from an empty env. The bridge re-runs this init
    // closure in the object's own isolate, so what the object sees is that
    // isolate's bindings, resolved the same way (DurableObjectBridge.ts:57-89).
    const self = yield* Cloudflare.Worker
    const classes = durableObjectClasses(deployment)
    for (const { className } of WORKER_IDENTITY.durableObjects) {
      const klass = classes[className]
      if (klass === undefined) return yield* Effect.die(new Error(`no Durable Object body for class ${className}`))
      yield* self.export(className, durableObjectExport(klass))
    }

    // The router's Layer is built once per isolate, on the first request, so
    // services that hold state across requests (the single-flight GitHub App
    // mint, the catalog cache) keep it.
    const services = yield* Effect.cached(Layer.buildWithScope(layersFromEnv(deployment), isolateScope))

    return {
      /*
       * One request, with the same boundary semantics as the native adapter.
       *
       * Services. The isolate's come from the cached context above;
       * `ExecutionContext` is the one per-request service, because
       * `waitUntil` belongs to this invocation — work a route forks through
       * it (a turn's settlement after the client hangs up) keeps the isolate
       * alive past the response. `execution.raw` is workerd's own
       * ExecutionContext (alchemy Worker.ts:125); its Effect-native
       * `execution.waitUntil` takes an Effect, while `executionContextFrom`
       * (Environment.ts:204) wants the platform's promise-shaped `waitUntil`,
       * which is what the native adapter in src/index.ts is handed too. Both
       * entrypoints therefore give the router the identical service.
       *
       * Disconnect and defects. Alchemy's bridge attaches no abort listener
       * (HttpServer.ts:24-52 calls `toHandled`, not `toWebHandlerWith`), so
       * this handler owns them: the router runs in a forked fiber that the
       * request's AbortSignal interrupts, and `responseFromExit`
       * (src/Boundary.ts) maps the exit — the route's answer, or 499 for an
       * interruption, or a logged, generic 500 with the isolation headers for
       * a defect. Without it a disconnected client leaves the upstream fetch
       * running and the registry unsettled, an interruption surfaces as
       * Alchemy's 503, and a defect answers a bodyless 500 that the
       * cross-origin-isolated app document cannot read.
       */
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Workers.Request
        const execution = yield* Cloudflare.WorkerExecutionContext
        const context = yield* services
        const routed = handleRequest(request).pipe(
          Effect.provideService(
            ExecutionContext,
            executionContextFrom({ waitUntil: (promise: Promise<unknown>) => execution.raw.waitUntil(promise) })
          ),
          Effect.provideContext(context)
        )
        return HttpServerResponse.fromWeb(yield* runFetch(routed, request.signal))
      })
    }
  })
)

export default worker
