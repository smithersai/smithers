// A person's own model's routes (worker/personal/) for the worker tests, on a test file's own schema of the compose
// Postgres and through the compose Electric (`pnpm db:up`, db/TestDatabase.ts). `model/Put` and `model/Delete` run for
// real on the Node host's durable engine (worker/test/flowHost.ts), so a write is in Postgres when its request answers;
// a test may set a failing `FlowStarter` instead. The person's provider, OpenAI's auth server and Vercel's gateway are
// scripted at the network (`worker/personal/test/provider.ts`). Every log line, span and metric is kept.
import { type Flow, FlowRuntime } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Scrub } from "@smthrs/secrets"
import { ConfigProvider, Context, type Duration, Effect, Exit, Layer, Logger, Metric, Option, Redacted, Scope, Tracer } from "effect"
import { FetchHttpClient, HttpEffect, HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import * as TestDatabase from "../../../db/TestDatabase.ts"
import type { ModelTier } from "../../../src/features/model/contract.ts"
import { type ConnectionKind, keyTail, PERSONAL_MODELS_TABLE, type Protocol } from "../../../src/features/personal-model/contract.ts"
import * as Actor from "../../Actor.ts"
import * as Flows from "../../Flows.ts"
import { SecretKeys } from "../../secrets/Keys.ts"
import * as SandboxEgress from "../../secrets/SandboxEgress.ts"
import * as FlowHost from "../../test/flowHost.ts"
import { signedIn, type testFile } from "../../test/harness.ts"
import * as PersonalApi from "../Api.ts"
import * as ModelFlows from "../ModelFlows.ts"
import { PersonalModels, sealContext } from "../Models.ts"
import * as Store from "../Store.ts"
import type * as Subscriptions from "../Subscriptions.ts"
import { OPENAI_ORIGIN } from "./provider.ts"

type Runtime = ReturnType<typeof testFile>
type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

/** SECRETS_KEY in these tests. */
export const KEY = Redacted.make("0123456789abcdef".repeat(4))

/** A key no test text otherwise contains, with characters that make its encoded forms differ. Its tail is `"~9Zq`. */
export const VALUE = "sk-proj-SENTINEL key/+=\"quoted\"~9Zq"

export const member: Actor.Actor = { subject: { kind: "person", id: "person-member" }, role: "member", login: "member" }
export const admin: Actor.Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin", login: "admin" }
export const guest: Actor.Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest", login: "guest" }
/** Signed in with no role on the repository. */
export const roleless: Actor.Actor = { subject: { kind: "person", id: "person-roleless" }, role: null }
/** An agent acting for the Member. */
export const agent: Actor.Actor = { ...member, act: { kind: "agent", id: "agent-run-1" } }

/** A valid save of the scripted OpenAI-compatible provider: one connection, its key, and `gpt-test` as the fast model. */
export const SAVE = {
  connections: [
    { kind: "api_key", protocol: "openai-chat", baseUrl: `${OPENAI_ORIGIN}/v1`, key: VALUE, models: { fast: "gpt-test" } },
  ],
}

/** Every form an echo of `values` may take that `text` contains: none when nothing leaked. */
export const leaks = (text: string, values: ReadonlyArray<string> = [VALUE]) =>
  values.flatMap((value) => Scrub.forms(value).filter((form) => text.includes(form)))

/** What the file's engine reaches beyond Postgres: OpenAI's auth server, scripted, and its keys. */
export interface EngineOptions {
  readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
  /** The network its steps reach: the runtime's unless set. */
  readonly fetch?: typeof globalThis.fetch
  /** Configuration its steps read; `SECRETS_KEY` is `KEY`, as the routes' is, unless `keys` is `false`. */
  readonly config?: Record<string, string>
  readonly keys?: boolean
}

/**
 * The Node host's engine with `model/Put`, `model/Delete` and `model/CodexLink` over the file's schema, built once for
 * the file, and a `FlowStarter` that runs a started flow to its end before it answers.
 */
export const engine = async (runtime: Runtime, options: EngineOptions = {}) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const scope = Effect.runSync(Scope.make())
  const config = ConfigProvider.fromUnknown({
    ...(options.keys === false ? {} : { SECRETS_KEY: Redacted.value(KEY) }),
    ...options.config,
  })
  // A step runs with the context its implementation was registered in: the host's own, so these go in there.
  const registration = ModelFlows.registration(
    options.database ?? scratch.database,
    Layer.unwrap(ModelFlows.captureCredentials).pipe(Layer.provide(ConfigProvider.layer(config)), Layer.orDie),
  ).pipe(
    Layer.provide(ConfigProvider.layer(config)),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, options.fetch ?? globalThis.fetch)),
  )
  const built = await Effect.runPromise(Scope.provide(FlowHost.build(registration), scope))
  const flows = Context.get(built.context, FlowRuntime.FlowRuntime)
  const exits: Array<Exit.Exit<unknown, unknown>> = []
  const starter = Flows.FlowStarter.of({
    start: (flow: Flow.Any, { executionId, payload }) =>
      Effect.exit(
        (flows.execute(flow as never, { executionId, payload: payload as never }) as Effect.Effect<unknown, unknown>).pipe(
          Effect.provide(built.context),
        ),
      ).pipe(Effect.map((exit) => void exits.push(exit))),
  })
  return {
    starter,
    exits,
    schema: built.engine.schema,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

export interface Options {
  /** Inject a faulty database while retaining the real sessions and model services. */
  readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
  /** Who is signed in: nobody unless set. */
  readonly actor?: Actor.Actor | null
  /** Where flows start: the file's engine unless set. */
  readonly starter?: Flows.FlowStarter["Service"]
  /** Keys on, under `KEY`, unless `false`. */
  readonly keys?: boolean
  /** People's own models in place of the real ones over the file's schema. */
  readonly personalModels?: Layer.Layer<PersonalModels>
  /** The providers, scripted; Electric passes through. */
  readonly provider?: typeof globalThis.fetch
  /** How long a test's call may take. */
  readonly testWithin?: Duration.Input
  /** Configuration the routes read: `MOONSHOT_BASE_URL`, `CODEX_AUTH_ORIGIN` and the like. */
  readonly config?: Record<string, string>
}

/** The personal model routes on the file's schema, recording every log line, span, metric and Electric request. */
export const personalHarness = async (
  runtime: Runtime,
  starter: Flows.FlowStarter["Service"],
  options: Options = {},
) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const database = options.database ?? scratch.database
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions)
      spans.push(span)
      return span
    },
  })
  const logs: Array<StructuredLog> = []
  const logger = Logger.make((logOptions) => void logs.push(StructuredLogger.formatStructured.log(logOptions)))
  const registry: Metric.MetricRegistry = new Map()
  /** Every request sent to Electric, as sent, before the table is pointed at the file's schema. */
  const electric: Array<URL> = []
  const toElectric: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    electric.push(new URL(url))
    if (url.searchParams.get("table") === PERSONAL_MODELS_TABLE) {
      url.searchParams.set("table", `${scratch.name}.${PERSONAL_MODELS_TABLE}`)
    }
    return globalThis.fetch(url, init)
  }
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return url.hostname === "localhost" || options.provider === undefined
      ? toElectric(input, init)
      : options.provider(input, init)
  }
  const config = ConfigProvider.fromUnknown({ ELECTRIC_URL: await runtime.runPromise(TestDatabase.electricUrl), ...options.config })
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(ConfigProvider.ConfigProvider, config),
    )
  const keys = options.keys === false ? SecretKeys.off : SecretKeys.layer(KEY)
  const personal = options.personalModels ?? PersonalModels.layer(database).pipe(Layer.provide(keys))
  const sessions = options.actor === undefined || options.actor === null ? Actor.signedOut : signedIn(options.actor)
  const api = await runtime.runPromise(
    observed(PersonalApi.make(database, options.testWithin === undefined ? {} : { testWithin: options.testWithin })),
  )
  const served = observed(
    api.fetch.pipe(
      Effect.provideService(Flows.FlowStarter, options.starter ?? starter),
      Effect.provide(personal),
      Effect.provide(keys),
      Effect.provide(sessions),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  )
  const handler = HttpEffect.toWebHandler(served)
  const line = (message: string) => logs.filter((log) => log.message === message)
  /** A box's requests to its vendor's host, through the egress, as `guest`. */
  const subscriptionEgress = (guest: SandboxEgress.Guest, subscription: Subscriptions.Subscription) =>
    HttpEffect.toWebHandler(
      observed(
        SandboxEgress.forwardSubscription(guest, subscription).pipe(
          Effect.provide(keys),
          Effect.provide(database),
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        ),
      ),
    )
  return {
    fetch: (path: string, init?: RequestInit) => handler(new Request(`http://chat.test${path}`, init)),
    /** The request served as a fiber of its own, so a test can interrupt it as a cancelled request would be. */
    fork: (path: string, init?: RequestInit) =>
      Effect.runFork(
        Effect.scoped(served).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(new Request(`http://chat.test${path}`, init)),
          ),
        ),
      ),
    subscriptionEgress,
    electric,
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(
          Effect.provideService(Metric.MetricRegistry, registry),
        ),
      ).count,
    line,
    spans,
    /** Everything recorded, as an exporter would send it: log lines, span attributes, events and failures. */
    recorded: () =>
      JSON.stringify(
        {
          logs,
          spans: spans.map((span) => ({
            name: span.name,
            attributes: [...span.attributes],
            events: span.events,
            failure: span.status._tag === "Ended" && Exit.isFailure(span.status.exit) ? String(span.status.exit.cause) : null,
          })),
          metrics: runtime.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)))
            .map((metric) => metric.attributes),
        },
        (_, value) => (typeof value === "bigint" ? String(value) : value),
      ),
  }
}

export type PersonalHarness = Awaited<ReturnType<typeof personalHarness>>

/** Every row of every table in `schema`, as JSON text, for searching for a key. */
export const dump = (runtime: Runtime, schema: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{ readonly name: string }>`
        SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${schema}`
      const texts: Array<string> = []
      for (const { name } of tables) {
        const rows = yield* sql.unsafe<{ readonly row: string }>(
          `SELECT row_to_json(t)::text AS row FROM "${schema}"."${name}" t`,
        )
        texts.push(...rows.map((row) => row.row))
      }
      return texts.join("\n")
    }),
  )

/** Empties the personal model tables. */
export const resetModels = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`TRUNCATE personal_models, personal_model_events, personal_model_usage RESTART IDENTITY`,
    ),
  )

/** The saved connections, as Postgres keeps them: by person, then in their order. */
export const rows = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{
        readonly personId: string
        readonly id: string
        readonly kind: ConnectionKind
        readonly position: number
        readonly active: boolean
        readonly protocol: string | null
        readonly baseUrl: string | null
        readonly fastModel: string | null
        readonly implementModel: string | null
        readonly hardModel: string | null
        readonly ciphertext: string
        readonly nonce: string
        readonly keyVersion: number
        readonly keyLast4: string
        readonly failureStatus: number | null
        readonly failedAt: Date | null
      }>`
        SELECT person_id AS "personId", id, kind, position, active, protocol, base_url AS "baseUrl",
          fast_model AS "fastModel", implement_model AS "implementModel", hard_model AS "hardModel", ciphertext, nonce,
          key_version AS "keyVersion", key_last4 AS "keyLast4", failure_status AS "failureStatus", failed_at AS "failedAt"
        FROM personal_models ORDER BY person_id, position`),
  )

/** The audit's rows, oldest first. */
export const events = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly personId: string; readonly action: string }>`
        SELECT person_id AS "personId", action FROM personal_model_events ORDER BY id`),
  )

/** The ledger's rows, oldest first. */
export const usage = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{
        readonly personId: string
        readonly role: string
        readonly modelId: string
        readonly connectionId: string | null
        readonly protocol: string | null
        readonly tier: string | null
        readonly inputTokens: number
        readonly outputTokens: number
        readonly outcome: string | null
        readonly errorCode: string | null
        readonly httpStatus: number | null
        readonly settled: boolean
      }>`
        SELECT person_id AS "personId", role, model_id AS "modelId", connection_id AS "connectionId", protocol, tier, input_tokens AS "inputTokens",
          output_tokens AS "outputTokens", outcome, error_code AS "errorCode", http_status AS "httpStatus",
          settled_at IS NOT NULL AS settled
        FROM personal_model_usage ORDER BY created_at, invocation_id`),
  )

/** One connection a seeded list keeps: `api_key` and active unless set, its text `VALUE` unless set. */
export interface SeedConnection {
  readonly id?: string
  readonly kind?: ConnectionKind
  readonly active?: boolean
  readonly protocol?: Protocol | null
  readonly baseUrl?: string | null
  readonly key?: string
  readonly models?: Readonly<Partial<Record<ModelTier, string>>>
}

/**
 * Saves `person`'s connections, in their order, straight through the store, each credential sealed under `key` (`KEY`
 * unless set), as `model/Put` would: for a test of what reads saved models. Answers each connection's id.
 */
export const seedKeys = (
  runtime: Runtime,
  person: string,
  connections: ReadonlyArray<SeedConnection>,
  key: Redacted.Redacted<string> = KEY,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const keys = Option.getOrThrow(yield* Effect.service(SecretKeys).pipe(Effect.provide(SecretKeys.layer(key))))
      const writes = yield* Effect.forEach(connections, (each) => {
        const value = each.key ?? VALUE
        return Effect.map(
          keys.cipher.seal(Redacted.make(value), sealContext(person, keys.version)),
          (sealed) => ({
            id: each.id ?? crypto.randomUUID(),
            kind: each.kind ?? "api_key" as const,
            active: each.active ?? true,
            protocol: each.protocol ?? null,
            baseUrl: each.baseUrl ?? null,
            models: each.models ?? {},
            sealed: { ...sealed, keyVersion: keys.version, keyLast4: keyTail(value) },
          }),
        )
      })
      yield* Store.put({ personId: person, connections: writes, invocationKey: crypto.randomUUID() })
      return writes.map((write) => write.id)
    }),
  )

/**
 * Saves `person`'s one key with its fast model (`gpt-test` at the scripted OpenAI-compatible provider unless set), as
 * `model/Put` would. Answers its id.
 */
export const seed = async (
  runtime: Runtime,
  person: string,
  model: {
    readonly id?: string
    readonly protocol?: Protocol
    readonly baseUrl?: string
    readonly modelId?: string
    readonly key?: string
  } = {},
  key: Redacted.Redacted<string> = KEY,
) => {
  const [id] = await seedKeys(runtime, person, [{
    ...(model.id === undefined ? {} : { id: model.id }),
    protocol: model.protocol ?? "openai-chat",
    baseUrl: model.baseUrl ?? OPENAI_ORIGIN,
    models: { fast: model.modelId ?? "gpt-test" },
    ...(model.key === undefined ? {} : { key: model.key }),
  }], key)
  return id!
}
