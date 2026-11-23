import { GitHub } from "@smthrs/integrations"
import { Clock, Config, Duration, Effect, Metric, Option, Redacted, Ref, Schema } from "effect"
import { HttpClient } from "effect/http"
import { profileKey } from "../../src/features/profile/contract.ts"
import { GITHUB_WEB } from "../GitHubAuth.ts"
import * as GitHubConfig from "../github/Config.ts"
import { withUserAgent } from "../github/Http.ts"
import * as ReadToken from "../github/ReadToken.ts"
import { graphql, ProfileRefused, type ProfileStage, rest } from "./GitHubRead.ts"
import * as ProfileMetrics from "./Metrics.ts"
import type { KeptAnswer, KeptRefusal, ProfileStore, Via } from "./Store.ts"

// Postgres-backed single-flight reader for GitHub user & organization profiles (mirrors worker/RepoAbout.ts):
// - Serves fresh answers from `owner_profile` across every Cloudflare data center.
// - Claims one in-flight read per owner at a time, so a crowd triggers one GitHub API call.
// - Prefers the deployment's `ReadToken` (GraphQL: 1 call for profile, pinned repos, README, and contribution graph),
//   falling back seamlessly to anonymous REST when no deployment token is configured.
// - Content-free observability: logs and metrics never carry logins, names, bios or repository titles.

export const CLAIM = Duration.seconds(30)
export const HOLD = Duration.seconds(5)
export const RATE_HOLD = Duration.minutes(1)
export const NOT_FOUND_HOLD = Duration.minutes(1)
export const MAX_HOLD = Duration.minutes(15)
export const PARTIAL_FRESH = Duration.minutes(5)
export const WAIT = Duration.seconds(1)
export const WAIT_FOR = Duration.seconds(10)
export const POLL = Duration.millis(250)
export const REQUEST_TIMEOUT = Duration.seconds(8)

export interface Settings {
  readonly token: ReadToken.ReadToken
  readonly apiBaseUrl: string
  readonly freshFor: Duration.Duration
  readonly anonymousFreshFor: Duration.Duration
}

const minutes = (name: string, fallback: number) =>
  Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), name).pipe(Config.withDefault(fallback), Config.map(Duration.minutes))

/** Reads {@link Settings} at program build (never inside a request handler). */
export const settings = Effect.gen(function* () {
  return {
    token: yield* ReadToken.fromConfig,
    apiBaseUrl: yield* Config.String("GITHUB_API_URL").pipe(Config.withDefault(GitHubConfig.DEFAULT_API_URL)),
    freshFor: yield* minutes("PROFILE_FRESH_MINUTES", 10),
    anonymousFreshFor: yield* minutes("PROFILE_ANONYMOUS_FRESH_MINUTES", 60),
  } satisfies Settings
})

export interface GitHubReadRecord {
  readonly via: Via
  readonly outcome: "answered" | "partial" | KeptRefusal
  readonly stage?: ProfileStage
  readonly upstreamStatus?: number
  readonly rateRemaining?: number
  readonly missing: ReadonlyArray<ProfileStage>
  readonly durationMs: number
}

export type Answer =
  & (
    | {
      readonly _tag: "Answered"
      readonly text: string
      readonly cache: "hit" | "miss"
      readonly via: Via
      readonly maxAgeSeconds: number
    }
    | {
      readonly _tag: "Refused"
      readonly code: KeptRefusal | "unavailable"
      readonly cache: "miss" | "refusal" | "wait"
      readonly retryAfterMillis?: number
    }
  )
  & { readonly read?: GitHubReadRecord; readonly store?: ReadonlyArray<string>; readonly writeRejected?: "keep" | "refuse" }

export type Outcome = Answer & { readonly waitedMs?: number; readonly refusalVia?: Via }

export const fieldsOf = (outcome: Outcome): Record<string, string | number> => ({
  cache: outcome.cache,
  ...(outcome.writeRejected === undefined ? {} : { writeRejected: outcome.writeRejected }),
  ...(outcome.refusalVia === undefined ? {} : { refusalVia: outcome.refusalVia }),
  ...(outcome._tag === "Refused" && outcome.retryAfterMillis !== undefined ? { retryAfterMs: outcome.retryAfterMillis } : {}),
  ...(outcome.waitedMs === undefined ? {} : { waitedMs: outcome.waitedMs }),
  ...(outcome._tag === "Answered" ? { via: outcome.via } : {}),
  ...(outcome.store === undefined ? {} : { store: outcome.store.join(",") }),
  ...(outcome.read === undefined ? {} : {
    via: outcome.read.via,
    read: outcome.read.outcome,
    ...(outcome.read.stage === undefined ? {} : { stage: outcome.read.stage }),
    ...(outcome.read.upstreamStatus === undefined ? {} : { upstreamStatus: outcome.read.upstreamStatus }),
    ...(outcome.read.rateRemaining === undefined ? {} : { rateRemaining: outcome.read.rateRemaining }),
  }),
})

export interface Source<R = never> {
  readonly answer: (owner: string) => Effect.Effect<Outcome, never, HttpClient.HttpClient | R>
}

export interface Timing {
  readonly waitFor: Duration.Duration
  readonly poll: Duration.Duration
}

const ms = Duration.toMillis

const least = (current: number | undefined, header: string | undefined) => {
  const value = header === undefined || header === "" ? Number.NaN : Number(header)
  return !Number.isFinite(value) ? current : current === undefined ? value : Math.min(current, value)
}

/** Builds the Postgres-backed profile source over `settings` and `store`. */
export const make = <R>(
  options: Settings,
  store: ProfileStore<R>,
  timing: Timing = { waitFor: WAIT_FOR, poll: POLL },
): Source<R> => {
  const fromGitHub = (owner: string, token: Option.Option<Redacted.Redacted<string>>) =>
    Effect.gen(function* () {
      const remaining = yield* Ref.make<number | undefined>(undefined)
      const base = yield* HttpClient.HttpClient
      const watched = HttpClient.make((request) =>
        base.execute(request).pipe(
          Effect.tap((response) => Ref.update(remaining, (current) => least(current, response.headers["x-ratelimit-remaining"]))),
        )
      )
      const read = yield* GitHub.GitHubClient.make(
        {
          apiBaseUrl: options.apiBaseUrl,
          requestTimeout: REQUEST_TIMEOUT,
          ...(Option.isSome(token) ? { token: Redacted.value(token.value) } : {}),
        },
        {},
      ).pipe(
        Effect.mapError(() => new ProfileRefused({ code: "github_unavailable", stage: "owner" })),
        Effect.flatMap((client) => (Option.isSome(token) ? graphql(client, owner) : rest(client, owner))),
        Effect.provideService(HttpClient.HttpClient, watched),
        Effect.result,
      )
      return { read, rateRemaining: yield* Ref.get(remaining) }
    })

  const absentOnWeb = (owner: string) =>
    options.apiBaseUrl !== GitHubConfig.DEFAULT_API_URL
      ? Effect.succeed(false)
      : Effect.flatMap(HttpClient.HttpClient, (client) =>
          client.head(`${GITHUB_WEB}/${encodeURIComponent(owner)}`)).pipe(
          withUserAgent,
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.map((response) => response.status === 404),
          Effect.orElseSucceed(() => false),
        )

  const answered = (kept: KeptAnswer, cache: "hit" | "miss", nowMs: number) => ({
    _tag: "Answered" as const,
    text: kept.text,
    cache,
    via: kept.via,
    maxAgeSeconds: Math.max(0, Math.floor((kept.freshUntilMs - nowMs) / 1000)),
  })

  const holdFor = (refusal: ProfileRefused, nowMs: number) =>
    refusal.code === "not_found"
      ? ms(NOT_FOUND_HOLD)
      : refusal.code === "rate_limited"
      ? Math.min(ms(MAX_HOLD), Math.max(ms(RATE_HOLD), refusal.retryAfterMillis ?? 0, (refusal.resetAtMillis ?? 0) - nowMs))
      : ms(HOLD)

  const recorded = (read: GitHubReadRecord) =>
    Effect.gen(function* () {
      yield* Metric.update(Metric.withAttributes(ProfileMetrics.profileReads, { via: read.via, outcome: read.outcome }), 1)
      yield* Effect.logWithLevel(read.outcome === "answered" ? "Info" : "Warn")("profile.read").pipe(
        Effect.annotateLogs({
          via: read.via,
          outcome: read.outcome,
          durationMs: read.durationMs,
          ...(read.stage === undefined ? {} : { stage: read.stage }),
          ...(read.upstreamStatus === undefined ? {} : { upstreamStatus: read.upstreamStatus }),
          ...(read.rateRemaining === undefined ? {} : { rateRemaining: read.rateRemaining }),
          ...(read.missing.length === 0 ? {} : { missing: read.missing.join(",") }),
        }),
      )
    })

  const awaitRead = (key: string, startedMs: number): Effect.Effect<Outcome, never, R> =>
    Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(timing.poll)
        const row = Option.getOrUndefined(Option.flatten(yield* store.get(key).pipe(Effect.option)))
        const nowMs = yield* Clock.currentTimeMillis
        const waitedMs = nowMs - startedMs
        const answer = row === undefined ? undefined : Option.getOrUndefined(row.answer)
        const refusal = row?.refusal ?? null
        if (answer !== undefined && answer.freshUntilMs > nowMs) return { ...answered(answer, "hit", nowMs), waitedMs }
        if (refusal !== null) {
          return {
            _tag: "Refused" as const,
            code: refusal,
            cache: "refusal" as const,
            ...(row!.refusalVia === undefined ? {} : { refusalVia: row!.refusalVia }),
            retryAfterMillis: Math.max(1000, row!.nextReadAtMs! - nowMs),
            waitedMs,
          }
        }
        if (waitedMs >= ms(timing.waitFor) || row === undefined || row.nextReadAtMs === null || row.nextReadAtMs <= nowMs) {
          return { _tag: "Refused" as const, code: "unavailable" as const, cache: "wait" as const, retryAfterMillis: ms(WAIT), waitedMs }
        }
      }
    }).pipe(Effect.withSpan("profile.wait"))

  const resolve = (key: string, owner: string): Effect.Effect<Outcome, never, HttpClient.HttpClient | R> =>
    Effect.gen(function* () {
      const failed: Array<string> = []
      const extra = () => (failed.length === 0 ? {} : { store: [...failed] })
      const storeDown = <A>(op: string, fallback: A) => () =>
        Effect.sync(() => {
          failed.push(op)
          return fallback
        })

      const row = yield* store.get(key).pipe(Effect.catch(storeDown("get", Option.none())))
      const nowMs = yield* Clock.currentTimeMillis
      const found = Option.getOrUndefined(row)
      const kept = found === undefined ? undefined : Option.getOrUndefined(found.answer)
      if (kept !== undefined && kept.freshUntilMs > nowMs) return { ...answered(kept, "hit", nowMs), ...extra() }

      const token = yield* options.token
      const via: Via = Option.isSome(token) ? "deployment" : "anonymous"
      const recoverAnonymous =
        found?.refusal === "rate_limited" &&
        (found.refusalVia === undefined || found.refusalVia === "anonymous") &&
        via === "deployment"

      const claimed = yield* store.claim(key, nowMs, nowMs + ms(CLAIM), recoverAnonymous).pipe(
        Effect.catch(storeDown("claim", false as string | false)),
      )
      if (claimed === false) {
        if (failed.includes("claim")) {
          return { _tag: "Refused" as const, code: "unavailable" as const, cache: "wait" as const, retryAfterMillis: ms(WAIT), ...extra() }
        }
        const refusal = found?.refusal ?? null
        if (refusal === null || recoverAnonymous) return { ...(yield* awaitRead(key, nowMs)), ...extra() }
        return {
          _tag: "Refused" as const,
          code: refusal,
          cache: "refusal" as const,
          ...(found!.refusalVia === undefined ? {} : { refusalVia: found!.refusalVia }),
          retryAfterMillis: Math.max(1000, found!.nextReadAtMs! - nowMs),
          ...extra(),
        }
      }

      const { read, rateRemaining } = yield* fromGitHub(owner, token)
      const durationMs = (yield* Clock.currentTimeMillis) - nowMs
      const facts = { via, ...(rateRemaining === undefined ? {} : { rateRemaining }), durationMs }

      if (read._tag === "Success") {
        const { profile, missing } = read.success
        const window = ms(via === "anonymous" ? options.anonymousFreshFor : options.freshFor)
        const fresh: KeptAnswer = {
          text: JSON.stringify(profile),
          via,
          readAtMs: nowMs,
          freshUntilMs: nowMs + (missing.length === 0 ? window : Math.min(window, ms(PARTIAL_FRESH))),
        }
        const record: GitHubReadRecord = { ...facts, outcome: missing.length === 0 ? "answered" : "partial", missing }
        yield* recorded(record)
        const saved = yield* store.keep(key, fresh, claimed).pipe(Effect.catch(storeDown("keep", false)))
        if (!saved) {
          return {
            _tag: "Refused" as const,
            code: "unavailable" as const,
            cache: "wait" as const,
            retryAfterMillis: ms(WAIT),
            read: record,
            writeRejected: "keep" as const,
            ...extra(),
          }
        }
        const answeredAtMs = yield* Clock.currentTimeMillis
        if (fresh.freshUntilMs <= answeredAtMs) {
          return {
            _tag: "Refused" as const,
            code: "unavailable" as const,
            cache: "wait" as const,
            retryAfterMillis: ms(WAIT),
            read: record,
            ...extra(),
          }
        }
        return { ...answered(fresh, "miss", answeredAtMs), read: record, ...extra() }
      }

      const absent = read.failure.code === "rate_limited" && via === "anonymous" && (yield* absentOnWeb(owner))
      const refusal = absent ? new ProfileRefused({ code: "not_found", stage: "web", upstreamStatus: 404 }) : read.failure
      const record: GitHubReadRecord = {
        ...facts,
        outcome: refusal.code,
        stage: refusal.stage,
        ...(refusal.upstreamStatus === undefined ? {} : { upstreamStatus: refusal.upstreamStatus }),
        missing: [],
      }
      yield* recorded(record)
      const saved = yield* store.refuse(key, refusal.code, nowMs + holdFor(refusal, nowMs), via, claimed).pipe(
        Effect.catch(storeDown("refuse", false)),
      )
      if (!saved) {
        return {
          _tag: "Refused" as const,
          code: "unavailable" as const,
          cache: "wait" as const,
          retryAfterMillis: ms(WAIT),
          read: record,
          writeRejected: "refuse" as const,
          ...extra(),
        }
      }
      return {
        _tag: "Refused" as const,
        code: refusal.code,
        cache: "miss" as const,
        ...(refusal.retryAfterMillis === undefined ? {} : { retryAfterMillis: refusal.retryAfterMillis }),
        read: record,
        ...extra(),
      }
    })

  return {
    answer: (owner) => resolve(profileKey(owner), owner).pipe(Effect.withSpan("profile.answer")),
  }
}
