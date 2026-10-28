// Sign-in's real routes (worker/SignIn.ts) for the tests, on a test file's own schema of the compose Postgres, with the
// scripted GitHub (worker/test/github.ts). Every log line, span and metric the routes record is kept, as in
// worker/test/harness.ts. `RoleChecks` records the role checks a request starts, unless a test sets one;
// worker/flows/RecheckRole.test.ts runs them. The routes start remote flows through a `FlowStarter` that records the
// sessions a sign-out starts signing out (`revocations`), unless a test sets one; worker/flows/RevokeGitHubToken.test.ts
// runs them. `advance` moves the clock the routes read, so a test can ask an hour later.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Clock, ConfigProvider, Effect, Layer, Logger, Metric, Tracer } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import type { SqlClient } from "effect/sql"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as Flows from "../Flows.ts"
import * as SignIn from "../SignIn.ts"
import { type ScriptedGitHub, scriptedGitHub } from "./github.ts"
import type { testFile } from "./harness.ts"

type Runtime = ReturnType<typeof testFile>

/** A SESSION_SECRET for tests: long enough, and a sentinel no record may carry. */
export const SECRET = "session-secret-sentinel-".padEnd(64, "7")

/** The GitHub App's client secret for tests: another sentinel. */
export const CLIENT_SECRET = "client-secret-sentinel"

/** Sign-in configured: the scripted App, the secret and the repository. */
export const configured: Record<string, string> = {
  GITHUB_APP_CLIENT_ID: "Iv1.scripted",
  GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
  SESSION_SECRET: SECRET,
  GITHUB_REPOSITORY: "smithersai/smithers",
}

type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

/** The cookies a response sets, by name: the value, and the whole `Set-Cookie` line. */
export const setCookies = (response: Response) =>
  Object.fromEntries(
    response.headers.getSetCookie().map((line) => {
      const pair = line.split(";")[0]!
      const at = pair.indexOf("=")
      return [pair.slice(0, at), { value: pair.slice(at + 1), line }]
    }),
  )

/** A `Cookie` header from name-value pairs. */
export const cookie = (cookies: Record<string, string>) =>
  Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ")

export interface Options {
  /** Sign-in's configuration: `configured` unless set. */
  readonly config?: Record<string, string>
  readonly github?: ScriptedGitHub
  /** The database: the file's schema unless set. */
  readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
  readonly fallback?: SignIn.Signed
  /** Local development's other people, by the name their dev person cookie gives. */
  readonly teammates?: Readonly<Record<string, SignIn.Signed>>
  /** Local development's newcomers, by their dev person cookie's value (worker/DevChatApi.ts `newcomer`). */
  readonly newcomer?: (name: string) => SignIn.Signed | undefined
  /** Where the browser is: `http://smithers.test` unless set. */
  readonly origin?: string
  /** Where a request starts a role check: one that records each start in `roleChecks` unless set. */
  readonly roleChecks?: SignIn.RoleChecks["Service"]
  /** Where a route starts a remote flow: one that records each sign-out it starts in `revocations` unless set. */
  readonly starter?: Flows.FlowStarter["Service"]
}

/** `clock`, read `offset()` milliseconds later. */
const later = (clock: Clock.Clock, offset: () => number): Clock.Clock => ({
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: (duration) => clock.sleep(duration),
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + offset(),
  currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + offset()),
  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(offset()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe() + BigInt(offset()) * 1_000_000n),
})

/** Sign-in's routes on the file's schema and the scripted GitHub, recording every log line, span and metric. */
export const signInHarness = async (runtime: Runtime, options: Options = {}) => {
  const scratch = await runtime.runPromise(Effect.gen(function* () {
    return yield* TestDatabase.Scratch
  }))
  const github = options.github ?? scriptedGitHub()
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
  let offset = 0
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.updateService(Clock.Clock, (clock) => later(clock, () => offset)),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(options.config ?? configured)),
    )
  const signIn = await runtime.runPromise(
    observed(
      SignIn.make(options.database ?? scratch.database, {
        github: github.service,
        ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
        ...(options.teammates === undefined ? {} : { teammates: options.teammates }),
        ...(options.newcomer === undefined ? {} : { newcomer: options.newcomer }),
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  )
  const roleChecks: Array<{ readonly sessionId: string; readonly generation: number }> = []
  const checks = Layer.succeed(
    SignIn.RoleChecks,
    options.roleChecks ??
      SignIn.RoleChecks.of({
        start: (sessionId, generation) => Effect.sync(() => void roleChecks.push({ sessionId, generation })),
      }),
  )
  const revocations: Array<string> = []
  const starter = options.starter ?? Flows.FlowStarter.of({
    start: (_, { payload }) => Effect.sync(() => void revocations.push((payload as { readonly sessionId: string }).sessionId)),
  })
  const handler = HttpEffect.toWebHandler(
    observed(signIn.fetch.pipe(Effect.provide(checks), Effect.provideService(Flows.FlowStarter, starter))),
  )
  const origin = options.origin ?? "http://smithers.test"
  const fetch = (path: string, init?: RequestInit) => handler(new Request(`${origin}${path}`, init))
  const snapshot = () => runtime.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)))

  /** Presses "Sign in with GitHub" in a fresh browser at `returnTo`: the redirect and the state cookie. */
  const start = async (returnTo = "/app") => {
    const response = await fetch(`/api/auth/sign-in?return=${encodeURIComponent(returnTo)}`)
    return { response, location: response.headers.get("location")!, cookies: setCookies(response) }
  }

  /** GitHub's callback for a sign-in, from a browser holding `cookies`. */
  const callback = (query: Record<string, string>, cookies: Record<string, string> = {}) =>
    fetch(`/api/auth/callback?${new URLSearchParams(query)}`, { headers: { cookie: cookie(cookies) } })

  /** Signs in all the way, as the scripted GitHub's person: the callback's response and the browser's cookies. */
  const signInAs = async (returnTo = "/app") => {
    const started = await start(returnTo)
    const { code, state } = github.approve(started.location)
    const stateCookies = Object.fromEntries(Object.entries(started.cookies).map(([name, set]) => [name, set.value]))
    const response = await callback({ code, state }, stateCookies)
    const session = Object.entries(setCookies(response)).filter(([name]) => name.endsWith("smithers_session"))
    return { started, response, code, state, cookies: Object.fromEntries(session.map(([name, set]) => [name, set.value])) }
  }

  return {
    signIn,
    github,
    fetch,
    start,
    callback,
    signInAs,
    roleChecks,
    /** The sessions a request started signing out (`auth/RevokeGitHubToken`), in order, through the default starter. */
    revocations,
    /** Moves the clock the routes read `ms` later, for every request from now on. */
    advance: (ms: number) => void (offset += ms),
    /** `Actor.Sessions` from sign-in, recording role checks, for worker/test/harness.ts. */
    sessions: signIn.sessions.pipe(Layer.provide(checks)),
    /** Who `GET /api/auth/session` says this browser is. */
    session: async (cookies: Record<string, string> = {}) =>
      (await fetch("/api/auth/session", { headers: { cookie: cookie(cookies) } })).json(),
    logs,
    spans,
    snapshot,
    line: (message: string) => logs.filter((log) => log.message === message),
    span: (name: string) => spans.filter((span) => span.name === name),
    count: (attributes: Record<string, string>) =>
      snapshot()
        .filter((entry) =>
          entry.id === "smithers_auth_requests" &&
          Object.entries(attributes).every(([key, value]) => entry.attributes?.[key] === value)
        )
        .reduce((sum, entry) => sum + (entry.state as { readonly count: number }).count, 0),
  }
}
