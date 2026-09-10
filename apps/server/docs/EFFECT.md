# The Worker as Effects

`apps/server` is one Effect program from the request to every upstream call
and every Durable Object. This page is the map: the entrypoint, how services
and Layers compose, where the platform boundaries are, how to add a service,
and the check that keeps promise interop out of the middle.

Effect v4 (`effect@4.0.0-rc.112`) is authoritative. When an API is in doubt,
read `node_modules/effect/src/*.ts`; there is no v3 idiom in this package
(`Context.Service`, not `Context.Tag`; `Effect.catch`, not `catchAll`).

## Entrypoints

There are two, and they share everything but the adapter.

| Entry | Runs where | Adapter |
| --- | --- | --- |
| `src/Worker.ts` | the deployment (Alchemy bundles it; `alchemy.run.ts` files it under a Stack) | Alchemy's Effect-native Worker bridge runs the Effects itself |
| `src/index.ts` `export default` | tests and the local host | `runRequest` in `src/Boundary.ts` |

Both call the same router, `handleRequest(request)` in `src/index.ts`, an
`Effect<Response, never, RequestServices>`: typed failures are already mapped
to responses inside, so the error channel is `never`, and everything it needs
is a service.

`RequestServices = AllServices | ExecutionContext` (`src/Environment.ts`).
`AllServices` is everything one *deployment* provides — one isolate's worth of
services, built once from the env bag by `layersFromEnv`. `ExecutionContext`
is the one service that belongs to a single *request*, because `waitUntil` is
this invocation's: work a route forks through it (a turn's settlement after the
client hangs up) keeps the isolate alive past the response. Each adapter
therefore provides two things — the isolate's `AllServices` context and its own
`ExecutionContext` — and neither adapter can accidentally share a `waitUntil`
between requests, because the type will not let it.

### `src/Worker.ts`, phase by phase

Alchemy's `Cloudflare.Worker(id, props, init)` has two phases. The `init`
Effect runs at plan time on the deploying machine and once per isolate at cold
start; what it returns is the runtime shape, whose `fetch` runs per request.

Init, in order:

1. Every secret and optional knob is `yield*`ed as
   `Config.option(Config.redacted(name))` / `Config.option(Config.string(name))`.
   At plan time Alchemy's ConfigProvider interceptor (`Platform.ts:554-593`)
   records each present value as `Output.literal(Redacted.make(value))`, which
   the runtime context stores with the `Redacted` wrapper outermost
   (`WorkerRuntimeContext.ts:48-57`) and the binding lowering turns into
   `secret_text` (`WorkerAsyncBindings.ts:366-373`). `Config.string` is not
   exempt: the optional knobs deploy as secrets too. At runtime the same yield
   reads the binding back. The values are unwrapped here, once, into a plain
   record. A value absent from the deploying shell is simply not bound.
2. `yield* Cloudflare.WorkerEnvironment` is the raw platform env: `{}` at plan
   time (`WorkerRuntimeContext.ts:82-83`), the bindings (`ASSETS`, the five
   namespaces, the plain vars) at runtime (`WorkerBridge.ts:310`). The record
   from step 1 is spread over it into `deployment`, the one bag everything
   downstream reads. The spread is not a convenience: a Config-bound value
   reaches workerd's `env` packed as the string
   `{"_tag":"Redacted","value":…}` (`RuntimeContext.ts:100-114`), so the
   resolved record from step 1 is the only place the Worker reads a secret
   from.
3. `yield* Cloudflare.Worker` gives the Worker's runtime context. For each
   Durable Object class in `WORKER_IDENTITY.durableObjects`,
   `self.export(className, durableObjectExport(durableObjectClasses(deployment)[className]))`
   registers the class body under its frozen class name (`worker.export`
   stores it at `WorkerRuntimeContext.ts:78-81`); the bundle's generated entry
   exports one `class <name> extends DurableObjectBridge("<name>")` per
   registered key (alchemy `Sources/Rolldown.ts:211-262`, emitted at `:251`).
   **This runs after step 2 on purpose**: `durableObjectClasses` takes the
   deployment bag, because the gateway registry provisions inside the object
   and cannot do it from an empty env (see "Durable Objects" below).
4. `layersFromEnv(deployment)` builds the Layer every route runs under, **once
   per isolate**, lazily on the first request:
   `Effect.cached(Layer.buildWithScope(layer, isolateScope))`. The scope is
   never closed; workerd has no isolate-teardown hook, and Alchemy's own bridge
   does the same (`WorkerBridge.ts:271-279`). Building per request would reset
   every service that holds state across requests (the single-flight GitHub
   App mint, the public-catalog cache).

Runtime (`fetch`):

```ts
const request = yield* Cloudflare.Workers.Request            // the web Request, untouched
const execution = yield* Cloudflare.WorkerExecutionContext   // this invocation's ctx
const context = yield* services                              // the cached isolate context
const response = yield* handleRequest(request).pipe(
  Effect.provideService(
    ExecutionContext,
    executionContextFrom({ waitUntil: (promise: Promise<unknown>) => execution.raw.waitUntil(promise) })
  ),
  Effect.provideContext(context)
)
return HttpServerResponse.fromWeb(response)
```

`WorkerExecutionContext` is yielded **inside** `fetch`, not in init. The init
closure can yield it, but what it gets there is the *deferred* context whose
`raw` throws outside a handler (`Worker.ts:178-183`); the per-event Layer that
`processEvent` merges over the isolate context is the live one
(`WorkerBridge.ts:104-108`). Alchemy's own `execution.waitUntil` takes an
Effect, while `executionContextFrom` (`src/Environment.ts:204`) wants the
platform's promise-shaped `waitUntil` — the same thing the native adapter in
`src/index.ts` is handed by workerd — so both entrypoints hand the router an
identical `ExecutionContext` service.

The router works in web `Request`/`Response` terms (that is what every seam
and test speaks), so the only conversion is `HttpServerResponse.fromWeb` on
the way out; a streaming body (the NDJSON turn stream) passes through as a
`Stream` and becomes a `ReadableStream` again at Alchemy's edge.

### Durable Objects

Each Durable Object module exports, in this order of importance:

1. `<name>Request(request): Effect<Response, never, DurableStorage>` (or
   `RecommendStorage` for the recommender's ring), the whole class body as an
   Effect over the storage service. Storage failures are handled inside, the
   clock is `Clock.currentTimeMillis`.
2. The native class (`class TurnCancelRegistry { fetch(request) { return
   runDurable(...) } }`), kept for tests and the local host; its `fetch` line
   is a declared boundary (below).
3. The Worker-side service (`TurnCancels`, `GatewaySessions`, `TurnLimits`,
   `ClientErrors`, `RecommendLogStore`) and its Layer constructor from a
   `NativeNamespace | undefined` (undefined = the binding is absent, unit-test
   behaviour).

`src/Worker.ts` deploys (1) through Alchemy's bridge: `durableObjectExport`
resolves `Cloudflare.DurableObjectState` once per in-memory object, builds the
module's Layers from `state.raw.storage` (`storageLayer` in
`src/DurableStorage.ts`, `recommendStorageLayer` in `src/recommend.ts`), and
its `fetch` runs the request Effect over them. `HttpServerRequest.toWeb` hands
back the very `Request` the bridge started from
(`HttpServerRequest.ts:1051-1053`), so nothing is re-streamed.

**A Durable Object's in-memory state is made once by the object.** The object,
not the request, is the thing that remembers. Two services live by that rule:

- `ClientErrorThrottle` — the throttle window, a `Ref<ClientErrorWindow>` from
  `makeClientErrorThrottle()`. A window rebuilt per request throttles nothing.
- `GatewayResolutions` — the registry's join map,
  `Map<string, Deferred<ProvisionOutcome>>` from `makeGatewayResolutions()`,
  built inside `gatewayRegistryLayers`. A map rebuilt per request joins
  nothing, and eight cold callers would provision eight workspaces.

Both are created in the per-object factory: the native class's field
initialiser (`src/clientErrorLog.ts:306`, `src/gateway.ts:284`) and, under
Alchemy, the `layers` callback that `durableObjectExport` invokes in the outer
per-object Effect. So `clientErrorLogRequest` requires
`DurableStorage | ClientErrorThrottle` and `gatewaySessionRequest` requires
`GatewayRegistryServices = DurableStorage | Transport | ServerConfig |
GatewayResolutions`. The same rule governs any future per-object counter,
cache or lock.

**The gateway registry needs the deployment's config, and getting that wrong is
an outage.** Since upstream `e089305e5d` the object serves `POST /resolve`: it
mints the Cloud token and provisions the workspace itself, so it reads
`IDENTITY_UPSTREAM_URL`, `IDENTITY_SERVICE_TOKEN`,
`SMITHERS_CLOUD_API_BASE_URL` and `UPSTREAM_TIMEOUT_MS` from its own
`ServerConfig`. That is why `durableObjectClasses(env)` is a function of the
deployment bag and why the Worker registers its exports only after building
`deployment`. An empty bag typechecks, deploys, and passes every router test —
the router just forwards to the binding — while every resolution answers
`unavailable: IDENTITY_UPSTREAM_URL is unset on this deployment.`
`src/Worker.test.ts` is the gate: it builds the registry's Layer from a
fixture bag and asserts the `ServerConfig` the object would run on.

Why both names survive adoption, briefly (DEPLOY.md has the procedure): the
binding is declared in `env` with the props form
`Cloudflare.DurableObject("TURN_CANCELS", { className: "TurnCancelRegistry" })`,
which is a plain descriptor `{ kind, name: "TURN_CANCELS", className:
"TurnCancelRegistry" }` (`DurableObject.ts:1260-1268`) lowered to
`{ type: "durable_object_namespace", name: "TURN_CANCELS", className:
"TurnCancelRegistry" }` (`WorkerAsyncBindings.ts:464-471`), and the class is
exported under `TurnCancelRegistry`. The class-form
`Cloudflare.DurableObject<Self>()("Name")` cannot do this: it binds
`{ name: namespace, className: namespace }` (`DurableObject.ts:1148-1153`) and
exports under the same string (`:1251`).

## Services and Layers

Every dependency is a `Context.Service` with a Layer constructor, and every
handler declares what it needs in its `R`:

| Service | Module | Layer | What it wraps |
| --- | --- | --- | --- |
| `ServerConfig` | `src/Config.ts` | `configLayer(env)` | vars and `Redacted` secrets, read once |
| `Transport` | `src/Http.ts` | `TransportLive`, `transportLayer(fetch)` | outbound fetch with a header-only deadline |
| `Assets`, `BrowserEgress` | `src/Environment.ts` | `assetsLayer`, `browserEgressLayer` | the `ASSETS` and `BROWSER_EGRESS` fetchers |
| `TurnCancels`, `GatewaySessions`, `TurnLimits`, `ClientErrors`, `RecommendLogStore` | their modules | `<x>Layer(namespace \| undefined)` | one Durable Object namespace each |
| `EdgeCache`, `GithubAppAuth` | `src/githubApp.ts` | `edgeCacheLayer(cache)`, `githubAppAuthLayer` | the Cache API and the single-flight App mint |
| `DeploymentBindings` | `src/Environment.ts` | `deploymentBindingsLayer(env)` | which optional bindings this deployment has, so admin reads answer honestly |
| `ExecutionContext` | `src/Environment.ts` | `Effect.provideService(ExecutionContext, executionContextFrom(ctx))` | this request's `waitUntil`; provided by the adapter, never by `layersFromEnv` |
| `DurableStorage` / `RecommendStorage` | `src/DurableStorage.ts`, `src/recommend.ts` | `storageLayer(native)`, `recommendStorageLayer(native)` | a Durable Object's own storage, inside the object |
| `ClientErrorThrottle` | `src/clientErrorLog.ts` | `clientErrorThrottleLayer(makeClientErrorThrottle())` | one object's throttle window, made once per in-memory object |
| `GatewayResolutions` | `src/gateway.ts` | `gatewayRegistryLayers(storage, env)` | one registry object's provisioning join map, made once per in-memory object |

`layersFromEnv(env)` in `src/Environment.ts` is the one composition point; it
returns `Layer<AllServices>` — everything except `ExecutionContext`, which the
adapter adds per request. `runtimeFor(env)` memoizes a `ManagedRuntime` per env
object in a `WeakMap`, so an isolate's services outlive one request while two
env bags never share a credential. Tests provide what they need directly:
`Effect.runPromise(effect.pipe(Effect.provide(testConfigLayer({...}))))`,
with `transportLayer(fakeFetch)` instead of patching `globalThis.fetch` and
`memoryStorage()` for a Durable Object body.

Failures are typed in `src/Failures.ts` (`UpstreamTimeout`,
`UpstreamUnreachable`, `BodyTooLarge`, `BodyNotJson`, `StorageFailure`,
`CryptoFailure`, `NotConfigured`, ...) and mapped to responses where the
route maps them, with the same status codes and message text as before. An
interruption is never a 500: `src/Boundary.ts` answers 499, and under
Alchemy the platform cancels the invocation.

## Boundaries

Promise interop exists in exactly these places:

- `src/Http.ts`: `Transport` over `fetch`, bounded body readers over
  `ReadableStream` readers.
- `src/DurableStorage.ts` (and `recommendStorageFrom` in `src/recommend.ts`):
  `Effect.tryPromise` over the platform storage.
- `src/Boundary.ts`: `runRequest` (request abort ⇒ fiber interruption ⇒ 499)
  and `runDurable`, for the native adapter and the native Durable Object
  classes; `responseFromExit` is the pure policy both entrypoints share
  (success / 499 for interrupts-only / a logged, generic 500 with the
  isolation headers for a defect).
- `src/Worker.ts`: Alchemy's bridge runs Effects, so the only promise here is
  handing `ctx.waitUntil` to the router as a function. The bridge attaches no
  abort listener (`HttpServer.ts:24-52` calls `toHandled`, not
  `toWebHandlerWith`), so `runFetch` owns the disconnect: it forks the router,
  interrupts that fiber from the request's `AbortSignal`, and maps the exit
  with `responseFromExit` from `src/Boundary.ts` — the same policy the native
  adapter applies, one implementation.
- The native Durable Object class `fetch` methods, one line each, marked
  `// effect-policy: boundary`.
- WebCrypto and stream readers, wrapped once in `Effect.tryPromise` where
  they are used.

Web `ReadableStream` response bodies are built at the boundary; inside, a
stream is an Effect `Stream` or a forked fiber writing to a `ReadableStream`
whose finalizers settle the registry and release the upstream body.

## Adding a service

1. Declare it: `export class Thing extends Context.Service<Thing,
   ThingShape>()("smithers-server/Thing") {}` in its module, with a shape of
   Effects, and a Layer constructor from the native binding or from other
   services (`Layer.succeed`, `Layer.effect`).
2. Compose it: add the Layer to `layersFromEnv` in `src/Environment.ts` and
   the tag to `AllServices` (or to `RequestServices` only, if it is per
   request like `ExecutionContext`, and provide it in both adapters). If it
   is a Durable Object's own in-memory state, it is a `Ref` the object makes
   once — see above. If it needs a new binding, add the binding to
   `WORKER_IDENTITY` (`src/workerIdentity.ts`), to `WorkerEnv`, and, if it is
   a secret, to `WORKER_IDENTITY.secrets`; `src/Worker.ts` declares bindings
   from that object, and `src/workerIdentity.test.ts` pins it.
3. Use it: `yield* Thing` inside the handler; the handler's `R` grows by
   `Thing` and the compiler tells every caller.
4. Test it with an injected Layer, not with a global patch. Keep state that
   must survive across requests inside the constructed service (the isolate
   context is built once), never in a per-request closure.
5. Run `pnpm run check` (`tsc --noEmit` and the policy below).

## The policy check

`pnpm run check:effect` runs `scripts/effect-policy.ts`, which scans every
`src/**/*.ts` that is not a test and fails on `async `, `await `, `.then(`,
`Effect.runPromise`, `Effect.runFork`, `runWeb`, or `EffectPlatform` outside
the allowlist (`src/Http.ts`, `src/DurableStorage.ts`, `src/Boundary.ts`,
`src/Worker.ts`) and off a line carrying `// effect-policy: boundary`, which
is reserved for a native Durable Object class's `fetch`. Comments are stripped
first, so prose may say the words. `scripts/effect-policy.test.ts` holds the
scanner to fixtures.

## Deploying

`DEPLOY.md`: the frozen identity, the adopting deploy and its preflight
(`scripts/adopt-durable-objects.ts`), the secrets list, dry runs, rollback.

Two rules worth repeating here, because they bite in this file's territory:

- **Run the Alchemy CLI under bun**, on its own TypeScript entry
  (`bun node_modules/alchemy/bin/alchemy.ts <command>`).
  `node_modules/.bin/alchemy` re-execs under node unless the environment names
  bun (`alchemy bin/cli.js:98-116`), and node's ESM resolver does not
  implement the extensionless imports this package uses.
- **`alchemy plan` is not the adoption verdict.** It evaluates the program —
  the Worker module, its init closure, the bindings it declares — with no
  credential and no live read, so it prints `create` from an empty local
  state no matter what is deployed. The preflight is the verdict.
