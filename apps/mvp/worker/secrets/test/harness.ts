import { afterBody } from "../../WriteAdmission.ts"
// The secrets routes and the sandbox egress (worker/secrets/) for the worker tests, on a test file's own schema of the
// compose Postgres and through the compose Electric (`pnpm db:up`, db/TestDatabase.ts). `secret/Put` and
// `secret/Delete` run for real on the Node host's durable engine (worker/test/flowHost.ts), so a write is in Postgres
// when its request answers; a test may set a failing `FlowStarter` instead. The third-party hosts a box reaches are
// scripted at the network (`fetch`), as the model is. Every log line, span and metric is kept.
import { type Flow, FlowRuntime } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Scrub } from "@smthrs/secrets"
import { ConfigProvider, Context, Effect, Exit, type Layer, Logger, Metric, Redacted, Scope, Tracer } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import * as TestDatabase from "../../../db/TestDatabase.ts"
import { SECRETS_TABLE } from "../../../src/features/secrets/contract.ts"
import * as Actor from "../../Actor.ts"
import * as Flows from "../../Flows.ts"
import * as FlowHost from "../../test/flowHost.ts"
import { signedIn, type testFile } from "../../test/harness.ts"
import * as SecretsApi from "../Api.ts"
import { SecretKeys } from "../Keys.ts"
import * as SandboxEgress from "../SandboxEgress.ts"
import * as SecretFlows from "../SecretFlows.ts"

type Runtime = ReturnType<typeof testFile>
type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

/** SECRETS_KEY in these tests. */
export const KEY = Redacted.make("0123456789abcdef".repeat(4))

/** A value no test text otherwise contains, with characters that make its encoded forms differ. */
export const VALUE = "sk_test_SENTINEL value/+=\"quoted\"~"

export const REPO = { owner: "acme", name: "widgets" }
export const REPO_ID = "github/acme/widgets"

export const admin: Actor.Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin" }
export const member: Actor.Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }
/** An agent acting for the Admin: never allowed a secret write. */
export const agent: Actor.Actor = { ...admin, act: { kind: "agent", id: "agent-1" } }

/** Every form an echo of `values` may take that `text` contains: none when nothing leaked. */
export const leaks = (text: string, values: ReadonlyArray<string> = [VALUE]) =>
  values.flatMap((value) => Scrub.forms(value).filter((form) => text.includes(form)))

/**
 * The Node host's engine with `secret/Put` and `secret/Delete` over the file's schema, built once for the file, and a
 * `FlowStarter` that runs a started flow to its end before it answers.
 */
export const engine = async (runtime: Runtime, database?: Layer.Layer<SqlClient.SqlClient, unknown>) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const scope = Effect.runSync(Scope.make())
  const built = await Effect.runPromise(
    Scope.provide(FlowHost.build(SecretFlows.registration(database ?? scratch.database)), scope),
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
  readonly sessions?: Layer.Layer<Actor.Sessions>
  readonly actor?: Actor.Actor | null
  /** Where flows start: the file's engine unless set. */
  readonly starter?: Flows.FlowStarter["Service"]
  /** Secrets on, under `KEY`, unless `false`. */
  readonly keys?: boolean
  /** The database: the file's schema unless set. */
  readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
  /** The hosts a box reaches, scripted. */
  readonly upstream?: typeof globalThis.fetch
  /** Configuration the routes read. */
  readonly config?: Record<string, string>
}

/** The secrets routes and the egress on the file's schema, recording every log line, span, metric and Electric request. */
export const secretsHarness = async (runtime: Runtime, starter: Flows.FlowStarter["Service"], options: Options = {}) => {
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
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== "localhost") return options.upstream!(input, init)
    electric.push(new URL(url))
    if (url.searchParams.get("table") === SECRETS_TABLE) url.searchParams.set("table", `${scratch.name}.${SECRETS_TABLE}`)
    return globalThis.fetch(url, init)
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
  const sessions = options.sessions ?? (options.actor === undefined || options.actor === null ? Actor.signedOut : signedIn(options.actor))
  const api = await runtime.runPromise(observed(SecretsApi.make({ id: REPO_ID })))
  const handler = HttpEffect.toWebHandler(
    observed(
      afterBody(api.fetch).pipe(
        Effect.provideService(Flows.FlowStarter, options.starter ?? starter),
        Effect.provide(keys),
        Effect.provide(sessions),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    ),
  )
  const allowHosts = await runtime.runPromise(observed(SandboxEgress.allowHosts))
  /** A box's handler: its requests through the egress, as the guest `guest`. */
  const egress = (guest: SandboxEgress.Guest) =>
    HttpEffect.toWebHandler(
      observed(
        SandboxEgress.forward(guest, allowHosts).pipe(
          Effect.provide(keys),
          Effect.provide(database),
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        ),
      ),
    )
  const line = (message: string) => logs.filter((log) => log.message === message)
  return {
    fetch: (path: string, init?: RequestInit) => handler(new Request(`http://chat.test${path}`, init)),
    egress,
    environment: (guest: SandboxEgress.Guest) =>
      runtime.runPromise(observed(SandboxEgress.environment(guest).pipe(Effect.provide(keys), Effect.provide(database)))),
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

export type SecretsHarness = Awaited<ReturnType<typeof secretsHarness>>

/** Every row of a table in `schema`, as JSON text, for searching for a value. */
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

/** Empties the secrets tables. */
export const resetSecrets = (runtime: Runtime) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE secrets, secret_events RESTART IDENTITY`))

/** The audit's rows, oldest first. */
export const events = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{
        readonly action: string
        readonly names: ReadonlyArray<string>
        readonly actorId: string | null
        readonly scope: string | null
        readonly host: string | null
        readonly method: string | null
        readonly outcome: string | null
      }>`
        SELECT action, names, actor_id AS "actorId", scope, host, method, outcome FROM secret_events ORDER BY id`),
  )

/** The secrets rows, as Postgres keeps them. */
export const rows = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{
        readonly repoId: string
        readonly name: string
        readonly ciphertext: string
        readonly nonce: string
        readonly keyVersion: number
        readonly hosts: ReadonlyArray<string>
        readonly methods: ReadonlyArray<string> | null
        readonly updatedBy: string
      }>`
        SELECT repo_id AS "repoId", name, ciphertext, nonce, key_version AS "keyVersion", hosts, methods,
          updated_by AS "updatedBy"
        FROM secrets ORDER BY name`),
  )
