// A person's own model's routes (worker/personal/) for the worker tests, on a test file's own schema of the compose
// Postgres and through the compose Electric (`pnpm db:up`, db/TestDatabase.ts). `model/Put` and `model/Delete` run for
// real on the Node host's durable engine (worker/test/flowHost.ts), so a write is in Postgres when its request answers;
// a test may set a failing `FlowStarter` instead. The person's provider is scripted at the network
// (`worker/personal/test/provider.ts`). Every log line, span and metric is kept.
import { type Flow, FlowRuntime } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Scrub } from "@smthrs/secrets"
import { ConfigProvider, Context, type Duration, Effect, Exit, Layer, Logger, Metric, Option, Redacted, Scope, Tracer } from "effect"
import { FetchHttpClient, HttpEffect, HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import * as TestDatabase from "../../../db/TestDatabase.ts"
import { keyTail, PERSONAL_MODELS_TABLE, type Protocol } from "../../../src/features/personal-model/contract.ts"
import * as Actor from "../../Actor.ts"
import * as Flows from "../../Flows.ts"
import { SecretKeys } from "../../secrets/Keys.ts"
import * as FlowHost from "../../test/flowHost.ts"
import { signedIn, type testFile } from "../../test/harness.ts"
import * as PersonalApi from "../Api.ts"
import * as ModelFlows from "../ModelFlows.ts"
import { PersonalModels, sealContext } from "../Models.ts"
import * as Store from "../Store.ts"
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

/** A valid save of the scripted OpenAI-compatible provider: its key, and `gpt-test` as the fast model. */
export const SAVE = {
  keys: [{ protocol: "openai-chat", baseUrl: `${OPENAI_ORIGIN}/v1`, key: VALUE }],
  models: { fast: { protocol: "openai-chat", modelId: "gpt-test" } },
}

/** Every form an echo of `values` may take that `text` contains: none when nothing leaked. */
export const leaks = (text: string, values: ReadonlyArray<string> = [VALUE]) =>
  values.flatMap((value) => Scrub.forms(value).filter((form) => text.includes(form)))

/**
 * The Node host's engine with `model/Put` and `model/Delete` over the file's schema, built once for the file, and a
 * `FlowStarter` that runs a started flow to its end before it answers.
 */
export const engine = async (runtime: Runtime, database?: Layer.Layer<SqlClient.SqlClient, unknown>) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const scope = Effect.runSync(Scope.make())
  const built = await Effect.runPromise(
    Scope.provide(FlowHost.build(ModelFlows.registration(database ?? scratch.database)), scope),
  )
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
}

/** The personal model routes on the file's schema, recording every log line, span, metric and Electric request. */
export const personalHarness = async (
  runtime: Runtime,
  starter: Flows.FlowStarter["Service"],
  options: Options = {},
) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const database = scratch.database
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
  const config = ConfigProvider.fromUnknown({ ELECTRIC_URL: await runtime.runPromise(TestDatabase.electricUrl) })
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

/** The saved models, as Postgres keeps them. */
export const rows = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{
        readonly personId: string
        readonly protocol: string
        readonly baseUrl: string
        readonly fastModel: string | null
        readonly implementModel: string | null
        readonly hardModel: string | null
        readonly ciphertext: string
        readonly keyVersion: number
        readonly keyLast4: string
        readonly failureStatus: number | null
        readonly failedAt: Date | null
      }>`
        SELECT person_id AS "personId", protocol, base_url AS "baseUrl", fast_model AS "fastModel",
          implement_model AS "implementModel", hard_model AS "hardModel", ciphertext, key_version AS "keyVersion",
          key_last4 AS "keyLast4", failure_status AS "failureStatus", failed_at AS "failedAt"
        FROM personal_models ORDER BY person_id, protocol`),
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
        readonly protocol: string | null
        readonly tier: string | null
        readonly inputTokens: number
        readonly outputTokens: number
        readonly outcome: string | null
        readonly errorCode: string | null
        readonly httpStatus: number | null
        readonly settled: boolean
      }>`
        SELECT person_id AS "personId", role, model_id AS "modelId", protocol, tier, input_tokens AS "inputTokens",
          output_tokens AS "outputTokens", outcome, error_code AS "errorCode", http_status AS "httpStatus",
          settled_at IS NOT NULL AS settled
        FROM personal_model_usage ORDER BY created_at, invocation_id`),
  )

/** One key a seeded configuration keeps: its protocol, base URL and key text (`VALUE` unless set). */
export interface SeedKey {
  readonly protocol: Protocol
  readonly baseUrl: string
  readonly key?: string
}

/**
 * Saves `person`'s keys and tiers' models straight through the store, each key sealed under `key` (`KEY` unless set),
 * as `model/Put` would: for a test of what reads saved models.
 */
export const seedKeys = (
  runtime: Runtime,
  person: string,
  saved: { readonly keys: ReadonlyArray<SeedKey>; readonly models: Store.Put["models"] },
  key: Redacted.Redacted<string> = KEY,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const keys = Option.getOrThrow(yield* Effect.service(SecretKeys).pipe(Effect.provide(SecretKeys.layer(key))))
      const writes = yield* Effect.forEach(saved.keys, (each) => {
        const value = each.key ?? VALUE
        return Effect.map(
          keys.cipher.seal(Redacted.make(value), sealContext(person, keys.version)),
          (sealed) => ({
            protocol: each.protocol,
            baseUrl: each.baseUrl,
            sealed: { ...sealed, keyVersion: keys.version, keyLast4: keyTail(value) },
          }),
        )
      })
      return yield* Store.put({ personId: person, keys: writes, models: saved.models, invocationKey: crypto.randomUUID() })
    }),
  )

/**
 * Saves `person`'s one key with its fast model (`gpt-test` at the scripted OpenAI-compatible provider unless set), as
 * `model/Put` would.
 */
export const seed = (
  runtime: Runtime,
  person: string,
  model: { readonly protocol?: Protocol; readonly baseUrl?: string; readonly modelId?: string; readonly key?: string } = {},
  key: Redacted.Redacted<string> = KEY,
) => {
  const protocol = model.protocol ?? "openai-chat"
  return seedKeys(runtime, person, {
    keys: [{ protocol, baseUrl: model.baseUrl ?? OPENAI_ORIGIN, ...(model.key === undefined ? {} : { key: model.key }) }],
    models: { fast: { protocol, modelId: model.modelId ?? "gpt-test" } },
  }, key)
}
