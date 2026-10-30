// Repository feeds' routes (worker/feeds/Api.ts) for the worker tests, on a test file's own schema of the compose
// Postgres and through the compose Electric (`pnpm db:up`, db/TestDatabase.ts). Roles come from the real `RepoRoles` as
// local development builds it, with each test's people's roles on each repository; a role GitHub couldn't give is an
// injected `RepoRoles` that refuses. Every log line, span, metric and Electric request is kept.
import { digestSync } from "@smthrs/crypto"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ConfigProvider, Effect, type Layer, Logger, Metric, Option, Tracer } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import type { SqlClient } from "effect/sql"
import * as TestDatabase from "../../../db/TestDatabase.ts"
import type * as Actor from "../../Actor.ts"
import { repositoryOf } from "../../github/Config.ts"
import * as RepoRoles from "../../github/RepoRoles.ts"
import { signedIn, signedOut, type testFile } from "../../test/harness.ts"
import * as FeedsApi from "../Api.ts"

type Runtime = ReturnType<typeof testFile>

/** The repository the factory feeds, which isn't the deployment's own. */
export const REPO = { owner: "smithersai", name: "vibelang" } as const
/** The deployment's own repository, where the session's role holds. */
export const OWN = "smithersai/smithers"

/** The collector's key for `REPO` in these tests: a sentinel no record may carry. */
export const KEY = "feed-key-sentinel-5b1f"
/** `FEED_KEYS` naming `REPO`'s key's digest. */
export const FEED_KEYS = `SmithersAI/VibeLang=${digestSync(KEY)},acme/other=${"0".repeat(64)}`

export const maintainer: Actor.Actor = {
  subject: { kind: "person", id: "person-maintainer" },
  role: "member",
  login: "maya-sentinel-login",
}
/** An Admin whose login sign-in doesn't know. */
export const admin: Actor.Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin" }
export const member: Actor.Actor = { subject: { kind: "person", id: "person-member" }, role: "member", login: "mo" }
/** An agent acting for the Maintainer: never allowed an answer. */
export const agent: Actor.Actor = { ...maintainer, act: { kind: "agent", id: "agent-run-1" } }

/** Each person's role on `REPO`, as GitHub would say it; on the deployment's own the session's holds. */
const vibelangRoles: Readonly<Record<string, Actor.Role | null>> = {
  "person-maintainer": "maintainer",
  "person-admin": "admin",
  "person-member": "member",
}

/** `RepoRoles` as local development builds it, with the people above on `REPO`. */
export const localRoles = (database: Layer.Layer<SqlClient.SqlClient, unknown>) =>
  RepoRoles.make(database, {
    repository: repositoryOf(OWN),
    app: Option.none(),
    local: true,
    localRoles: (actor, repository) =>
      repository.id === repositoryOf(`${REPO.owner}/${REPO.name}`).id ? vibelangRoles[actor.subject.id] ?? null : undefined,
  })

/** `RepoRoles` that can't give anyone a role now: `code` for every repository. */
export const refusingRoles = (code: RepoRoles.Refusal): RepoRoles.RepoRoles<never> => ({
  repository: repositoryOf(OWN),
  resolve: () => Effect.fail(new RepoRoles.RoleRefused({ code })),
})

export interface Options {
  /** Who is signed in: nobody unless set. */
  readonly actor?: Actor.Actor | null
  /** Sessions in place of `actor`. */
  readonly sessions?: Layer.Layer<Actor.Sessions>
  /** Roles in place of the local ones. */
  readonly roles?: RepoRoles.RepoRoles<never>
  /** The database the routes reach: the file's schema unless set. */
  readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
  /** The deployment's configuration beside Electric's URL: `FEED_KEYS` unless set. */
  readonly config?: Record<string, string>
  /** The routes' own options: a development key, as `alchemy dev` passes one. */
  readonly api?: FeedsApi.Options
}

/** The feeds' routes on the file's schema, recording every log line, span, metric and Electric request. */
export const feedsHarness = async (runtime: Runtime, options: Options = {}) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions)
      spans.push(span)
      return span
    },
  })
  const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const logger = Logger.make((logOptions) => void logs.push(StructuredLogger.formatStructured.log(logOptions)))
  const registry: Metric.MetricRegistry = new Map()
  /** Every request sent to Electric, as sent, before the table is pointed at the file's schema. */
  const electric: Array<URL> = []
  const toElectric: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    electric.push(new URL(url))
    const table = url.searchParams.get("table")
    if (table !== null) url.searchParams.set("table", `${scratch.name}.${table}`)
    return globalThis.fetch(url, init)
  }
  const config = ConfigProvider.fromUnknown({
    ELECTRIC_URL: await runtime.runPromise(TestDatabase.electricUrl),
    ...(options.config ?? { FEED_KEYS }),
  })
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(ConfigProvider.ConfigProvider, config),
    )
  const sessions = options.sessions ??
    (options.actor === undefined || options.actor === null ? signedOut : signedIn(options.actor))
  const database = options.database ?? scratch.database
  const roles = options.roles ?? await runtime.runPromise(localRoles(scratch.database))
  const api = await runtime.runPromise(observed(FeedsApi.make(database, roles, options.api)))
  const handler = HttpEffect.toWebHandler(
    observed(
      api.fetch.pipe(
        Effect.provide(sessions),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, toElectric),
      ),
    ),
  )
  const snapshot = () => runtime.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)))
  return {
    fetch: (path: string, init?: RequestInit) => handler(new Request(`http://chat.test${path}`, init)),
    electric,
    logs,
    spans,
    snapshot,
    line: (message: string) => logs.filter((log) => log.message === message),
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
  }
}

export type FeedsHarness = Awaited<ReturnType<typeof feedsHarness>>
