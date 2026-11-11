// The custom-domain routes and flows (worker/domains/) for the worker tests, on a test file's own schema of the compose
// Postgres and through the compose Electric (`pnpm db:up`, db/TestDatabase.ts). `domain/Verify` and `domain/Remove` run
// for real on the Node host's durable engine (worker/test/flowHost.ts), so a write is in Postgres when its request
// answers. The happy path's provider is the real `Dns` adapter, whose resolver is scripted at the network (`fetch`) as
// the model is; an unhappy path swaps in a faulty provider. Every log line, span and metric is kept.
import { type Flow, FlowRuntime } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ConfigProvider, Context, Effect, Exit, type Layer, Logger, Metric, type Option, Scope, Tracer } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import * as TestDatabase from "../../../db/TestDatabase.ts"
import { DOMAINS_TABLE } from "../../../src/features/domains/contract.ts"
import * as Actor from "../../Actor.vibe"
import * as Flows from "../../Flows.vibe"
import * as FlowHost from "../../test/flowHost.ts"
import { signedIn, type testFile } from "../../test/harness.ts"
import * as DomainsApi from "../Api.ts"
import * as Dns from "../Dns.ts"
import * as DomainFlows from "../DomainFlows.ts"
import { DomainProvider, type Provider } from "../Provider.vibe"

type Runtime = ReturnType<typeof testFile>
type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

export const REPO = { owner: "acme", name: "widgets" }
export const REPO_ID = "github/acme/widgets"

/** The deployment's zone and its CNAME target in these tests. */
export const ZONE = "smithers.test"
export const TARGET = "domains.smithers.test"

/** The scripted resolver's origin. */
export const DOH_URL = "https://doh.test/dns-query"

export const admin: Actor.Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin" }
export const maintainer: Actor.Actor = { subject: { kind: "person", id: "person-maintainer" }, role: "maintainer" }
export const member: Actor.Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }
export const guest: Actor.Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest" }
/** An agent acting for the Maintainer: never allowed a domain write. */
export const agent: Actor.Actor = { ...maintainer, act: { kind: "agent", id: "agent-1" } }

/** Public DNS as the scripted resolver answers it: `<name> <type>` to the records' data. */
export type Zone = Map<string, ReadonlyArray<string>>

/** RR type numbers the resolver answers with. */
const TYPES: Record<string, number> = { A: 1, CNAME: 5 }

/**
 * A DNS-over-HTTPS resolver at `DOH_URL` answering from `zone`, counting each lookup; `fail` makes it answer 503. Every
 * other request goes to the real `fetch`: Electric's, pointed at the file's schema.
 */
export const network = (scratchName: string, zone: Zone, state: { fail: boolean; lookups: number }) => {
  const electric: Array<URL> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === new URL(DOH_URL).origin) {
      state.lookups++
      if (state.fail) return new Response("unavailable", { status: 503 })
      const name = url.searchParams.get("name")!
      const type = url.searchParams.get("type")!
      const data = zone.get(`${name} ${type}`) ?? []
      return Response.json({ Status: 0, Answer: data.map((value) => ({ name, type: TYPES[type], data: value })) })
    }
    electric.push(new URL(url))
    if (url.searchParams.get("table") === DOMAINS_TABLE) url.searchParams.set("table", `${scratchName}.${DOMAINS_TABLE}`)
    return globalThis.fetch(url, init)
  }
  return { fetch, electric }
}

/**
 * A provider the test can swap: the real `Dns` adapter over the scripted resolver until `use` names another, such as a
 * faulty one.
 */
export const switchable = (fetch: typeof globalThis.fetch) => {
  const dns = Effect.runSync(
    Dns.make({ zone: ZONE, target: TARGET, dohUrl: DOH_URL }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  )
  let current: Provider = dns
  const provider: Provider = {
    name: "switchable",
    target: TARGET,
    zone: ZONE,
    ensure: (hostname) => Effect.suspend(() => current.ensure(hostname)),
    status: (id, hostname) => Effect.suspend(() => current.status(id, hostname)),
    remove: (id) => Effect.suspend(() => current.remove(id)),
  }
  return {
    provider,
    layer: DomainProvider.layer(provider),
    use: (next: Partial<Provider>) => void (current = { ...dns, ...next }),
    reset: () => void (current = dns),
  }
}

/**
 * The Node host's engine with `domain/Verify` and `domain/Remove` over the file's schema and `provider`, built once for
 * the file: `starter` runs a started flow to its end before it answers, `detached` only starts it.
 */
export const engine = async (runtime: Runtime, provider: Layer.Layer<DomainProvider>) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const scope = Effect.runSync(Scope.make())
  const built = await Effect.runPromise(
    Scope.provide(FlowHost.build(DomainFlows.registration(scratch.database, provider)), scope),
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
  /** A starter that answers once the flow started, as the Cloudflare host does: a poll that waits goes on waiting. */
  const detached = Flows.FlowStarter.of({
    start: (flow: Flow.Any, { executionId, payload }) =>
      Effect.asVoid(
        Effect.forkIn(
          (flows.execute(flow as never, { executionId, payload: payload as never }) as Effect.Effect<unknown, unknown>)
            .pipe(Effect.provide(built.context)),
          scope,
        ),
      ),
  })
  return { starter, detached, exits, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
}

export interface Options {
  /** Who is signed in: nobody unless set. */
  readonly actor?: Actor.Actor | null
  /** Where flows start. */
  readonly starter: Flows.FlowStarter["Service"]
  /** The provider: off when `none`. */
  readonly provider: Option.Option<Provider>
  /** The network: Electric's and the resolver's. */
  readonly fetch: typeof globalThis.fetch
}

/** The domain routes on the file's schema, recording every log line, span and metric. */
export const domainsHarness = async (runtime: Runtime, options: Options) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
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
  const provider = ConfigProvider.fromUnknown({ ELECTRIC_URL: await runtime.runPromise(TestDatabase.electricUrl) })
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
    )
  const sessions = options.actor === undefined || options.actor === null ? Actor.signedOut : signedIn(options.actor)
  const api = await runtime.runPromise(observed(DomainsApi.make({ id: REPO_ID }, scratch.database)))
  const handler = HttpEffect.toWebHandler(
    observed(
      api.fetch.pipe(
        Effect.provideService(Flows.FlowStarter, options.starter),
        Effect.provideService(DomainProvider, options.provider),
        Effect.provide(sessions),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, options.fetch),
      ),
    ),
  )
  return {
    fetch: (path: string, init?: RequestInit) => handler(new Request(`http://chat.test${path}`, init)),
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(
          Effect.provideService(Metric.MetricRegistry, registry),
        ),
      ).count,
    line: (message: string) => logs.filter((log) => log.message === message),
    spans,
  }
}

/** Empties the domain tables. */
export const resetDomains = (runtime: Runtime) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE domains, domain_events RESTART IDENTITY`))

/** The domains rows, as Postgres keeps them. */
export const rows = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{
        readonly hostname: string
        readonly repoId: string
        readonly providerId: string | null
        readonly pollId: string
        readonly state: string
        readonly verification: string
        readonly certificate: string
        readonly records: ReadonlyArray<{ readonly type: string; readonly name: string; readonly value: string }>
        readonly problem: string | null
        readonly checkedAt: Date | null
        readonly updatedBy: string
      }>`
        SELECT hostname, repo_id AS "repoId", provider_id AS "providerId", poll_id AS "pollId", state, verification,
          certificate, records, problem, checked_at AS "checkedAt", updated_by AS "updatedBy"
        FROM domains ORDER BY hostname`),
  )

/** The audit's rows, oldest first. */
export const events = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{
        readonly hostname: string
        readonly action: string
        readonly actorId: string | null
        readonly state: string | null
        readonly problem: string | null
      }>`
        SELECT hostname, action, actor_id AS "actorId", state, problem FROM domain_events ORDER BY id`),
  )

/** Inserts a row as a step would, for tests that start from a state. */
export const seed = (runtime: Runtime, row: {
  readonly hostname: string
  readonly repoId?: string
  readonly pollId?: string
  readonly providerId?: string | null
  readonly state?: string
}) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`
        INSERT INTO domains (hostname, repo_id, provider_id, poll_id, state, verification, certificate, updated_by)
        VALUES (${row.hostname}, ${row.repoId ?? REPO_ID}, ${row.providerId ?? null}, ${row.pollId ?? "poll-seed"},
          ${row.state ?? "pending"}, 'pending', 'pending', 'person-seed')`),
  )

