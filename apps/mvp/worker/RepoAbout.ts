import { withUserAgent } from "./github/Http.ts"
import { GitHub } from "@smthrs/integrations"
import { Clock, Config, Duration, Effect, Function, type Layer, Metric, Option, Redacted, Ref, Schema } from "effect"
import { HttpClient } from "effect/http"
import type { SqlClient } from "effect/sql"
import { repoId } from "../src/features/repo/contract.ts"
import { AboutRefused, type AboutStage, graphql, rest } from "./about/GitHubRead.ts"
import type { AboutStore, KeptAnswer, KeptRefusal, Via } from "#vibelang/source/worker/about/Store"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import { appSlug, GITHUB_WEB } from "./GitHubAuth.ts"
import * as GitHubConfig from "#vibelang/emitted/worker/github/Config"
import * as ReadToken from "./github/ReadToken.ts"
import { allowed as allowedRepositories } from "./github/RepoRoles.ts"
import * as Tokens from "./github/Tokens.ts"
import * as Curated from "./home/Curated.ts"
import * as RepoMetrics from "./RepoMetrics.ts"

// What GitHub says of a repository (docs/features/repo.md#about): the answer the repository page, its home before a
// clone, the Docs tab and the code root all start from. Visitors open it most, so it must not hang on GitHub's
// anonymous quota (60 calls an hour per address, shared by every Worker on Cloudflare's egress).
//
// - **Kept for every data center** in Postgres (worker/about/Store.ts): a fresh answer serves everyone. When it goes
//   stale, one request claims the next read and the rest wait for a fresh answer or a refusal, watching the store.
//   An answer past its freshUntil is never served, including while GitHub can't answer or another read is held.
//   A crowd causes one read of GitHub.
// - **Nothing is shared between requests.** A Worker isolate serves many requests at once, and a request may not
//   resume on another's I/O: on 2026-10-25 a lookup shared through Effect's `Cache` answered 23 of 30 concurrent
//   visitors 500. Each request reads the store, GitHub and the App's signer on its own; only the store is common.
// - **Read with the App's quota where its owner let Smithers act**: on a repository the Smithers App is installed on
//   and `GITHUB_ALLOWED_REPOSITORIES` doesn't leave out, with an installation token minted for that repository, for
//   everyone, visitors included. Elsewhere a Member's read uses the deployment's read token, and anyone else's is
//   anonymous, so naming arbitrary repositories can't spend the App's quota. Curated public homes use the
//   deployment read token over REST, avoiding Cloudflare's exhausted shared anonymous quota.
// - **Few calls**: with a token, one GraphQL query and the contributors; anonymously, a slimmer REST read
//   (worker/about/GitHubRead.ts).
//
// Every read of GitHub logs `repo.about.read` and counts `repo_about_reads`: the token it used, its outcome, the
// stage and status GitHub refused at, the rate limit left, and the parts GitHub left out. Never a token or the answer.

export { AboutRefused, type AboutStage } from "./about/GitHubRead.ts"
export type { Via } from "#vibelang/source/worker/about/Store"

/**
 * How long a claimed read holds every other request off: longer than a read's three rounds of calls at
 * `REQUEST_TIMEOUT`. A claim is no lease on work: a read that never finishes is simply read by the next request after.
 */
export const CLAIM = Duration.seconds(30)
/**
 * How long nobody asks GitHub again after it didn't answer: long enough to make a burst of visitors one read, short
 * enough that a page waiting through a moment's outage shows as soon as GitHub answers.
 */
export const HOLD = Duration.seconds(5)
/** How long nobody asks GitHub again after a rate limit, at least, when it names an earlier reset or none. */
export const RATE_HOLD = Duration.minutes(1)
/** How long nobody asks GitHub again after it said the repository isn't there. */
export const NOT_FOUND_HOLD = Duration.minutes(1)
/** The longest a rate limit holds every read off, whatever GitHub says of its reset. */
export const MAX_HOLD = Duration.minutes(15)
/** How long an answer GitHub left parts out of is fresh, at most. */
export const PARTIAL_FRESH = Duration.minutes(5)
/** How long the App's absence from a repository is remembered before GitHub is asked again. */
export const APP_RECHECK = Duration.hours(1)
/** How long a request asks the browser to wait when another request's first read didn't land in `WAIT_FOR`. */
export const WAIT = Duration.seconds(1)
/** How long a request waits for another request's first read of a repository, watching the store. */
export const WAIT_FOR = Duration.seconds(10)
/** How often a waiting request looks at the store. */
export const POLL = Duration.millis(250)
/** Each GitHub call's deadline. */
export const REQUEST_TIMEOUT = Duration.seconds(8)

/** How the about read reaches GitHub, and how long its answers are fresh. */
export interface Settings {
  /**
   * The deployment's read token (worker/github/ReadToken.ts) a Member's read of a repository without the App uses:
   * `GITHUB_TOKEN`, else the App's for the deployment's own repository; neither, anonymous.
   */
  readonly token: ReadToken.ReadToken
  /** `GITHUB_API_URL`: GitHub's REST API, `https://api.github.com` unless set. */
  readonly apiBaseUrl: string
  /** `GITHUB_APP_SLUG`: the Smithers GitHub App's name in its URL, `smithers` unless set. */
  readonly appSlug: string
  /** `REPO_ABOUT_FRESH_MINUTES`: how long an answer read with a token is fresh, 10 unless set. */
  readonly freshFor: Duration.Duration
  /** `REPO_ABOUT_ANONYMOUS_FRESH_MINUTES`: how long an anonymous read is fresh, 60 unless set. */
  readonly anonymousFreshFor: Duration.Duration
  /** The GitHub App, when this deployment has one: it mints the installation tokens. */
  readonly app: Option.Option<GitHubConfig.GitHubApp>
  /** `GITHUB_ALLOWED_REPOSITORIES`: the repositories besides the deployment's own it may act on; none, every one. */
  readonly allowed: Option.Option<ReadonlySet<string>>
}

const minutes = (name: string, fallback: number) =>
  Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), name).pipe(Config.withDefault(fallback), Config.map(Duration.minutes))

/** Reads {@link Settings} at program build. An App configuration that doesn't read leaves the App out. */
export const settings = Effect.gen(function* () {
  return {
    token: yield* ReadToken.fromConfig,
    apiBaseUrl: yield* Config.String("GITHUB_API_URL").pipe(Config.withDefault(GitHubConfig.DEFAULT_API_URL)),
    appSlug: yield* appSlug,
    freshFor: yield* minutes("REPO_ABOUT_FRESH_MINUTES", 10),
    anonymousFreshFor: yield* minutes("REPO_ABOUT_ANONYMOUS_FRESH_MINUTES", 60),
    app: yield* GitHubConfig.configured.pipe(Effect.orElseSucceed(() => Option.none<GitHubConfig.GitHubApp>())),
    allowed: yield* allowedRepositories,
  } satisfies Settings
})

/** What one read of GitHub did, for the records: never a token or the answer. */
export interface GitHubRead {
  readonly via: Via
  readonly outcome: "answered" | "partial" | KeptRefusal
  readonly stage?: AboutStage
  readonly upstreamStatus?: number
  /** The least `x-ratelimit-remaining` GitHub answered the read's calls with. */
  readonly rateRemaining?: number
  /** The parts GitHub couldn't give now. */
  readonly missing: ReadonlyArray<AboutStage>
  /** Why the App's token couldn't be had, when the read fell back without it. */
  readonly tokenError?: string
  readonly durationMs: number
}

/**
 * What GitHub's answer is for a repository: an answer (`hit`: fresh from the store; `miss`: read from GitHub now)
 * or a refusal (`miss`: GitHub refused now; `refusal`: GitHub's refusal the store keeps; `wait`: another data center
 * is reading it). `read` is what this lookup's read of GitHub did, and `store` names the store operations that failed.
 */
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
  & { readonly read?: GitHubRead; readonly store?: ReadonlyArray<string>; readonly writeRejected?: "keep" | "refuse" }

/** One request's answer; `waitedMs` says how long it waited for another request's first read. */
export type Outcome = Answer & { readonly waitedMs?: number; readonly refusalVia?: Via }

/**
 * What an answer's `repo.about` line records: where it came from (`cache`), the token (`via`: this request's read of
 * GitHub's, else the kept answer's), how long it waited for another request's read, the store operations that failed,
 * and the read's outcome, stage, status and rate limit left. Never a token or the answer.
 */
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

/** The about read; `R` is what its store and database need. */
export interface Source<R = never> {
  /**
   * What GitHub says of `owner/name` for one request. `member` says whether the asker is a Member or above; it is
   * asked only when a read of a repository without the App must choose between the deployment's token and none.
   */
  readonly answer: (
    owner: string,
    name: string,
    member: Effect.Effect<boolean>,
  ) => Effect.Effect<Outcome, never, HttpClient.HttpClient | R>
}

/** The token a read goes out with, and why the App's couldn't be had when the read fell back without it. */
interface Chosen {
  readonly via: Via
  readonly token: Option.Option<Redacted.Redacted<string>>
  readonly tokenError?: string
}

const ms = Duration.toMillis

/** The least of the `x-ratelimit-remaining` values seen so far and `header`. */
const least = (current: number | undefined, header: string | undefined) => {
  const value = header === undefined || header === "" ? Number.NaN : Number(header)
  return !Number.isFinite(value) ? current : current === undefined ? value : Math.min(current, value)
}

/** How long a waiting request waits for another's first read, and how often it looks: `WAIT_FOR` and `POLL`. */
export interface Timing {
  readonly waitFor: Duration.Duration
  readonly poll: Duration.Duration
}

/** The about read over `settings`, keeping its answers in `store`; the App's installations live in `database`. */
export const make = <E, R>(
  options: Settings,
  store: AboutStore<R>,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  timing: Timing = { waitFor: WAIT_FOR, poll: POLL },
) =>
  Effect.gen(function* () {
    // The App's JWT signer, built for each read that mints a token: a signer one request built and another awaited
    // would resume that request on the first one's I/O.
    const app = Option.map(options.app, (configured) => ({
      repository: configured.repository,
      auth: GitHub.AppAuth.make({ appId: configured.appId, privateKey: configured.privateKey, apiBaseUrl: configured.apiBaseUrl }),
    }))

    /** Whether the deployment may act on `id` with the App: its own repository, or one the allowed list doesn't leave out. */
    const mayAct = (own: GitHubConfig.Repository, id: string) =>
      id === own.id || Option.match(options.allowed, { onNone: () => true, onSome: (ids) => ids.has(id) })

    /**
     * The token a read of `owner/name` goes out with: the App's for that repository where it is installed and the
     * deployment may act; else the deployment's for a Member; else none.
     */
    const tokenFor = (
      owner: string,
      name: string,
      id: string,
      appAbsentUntilMs: number | null,
      nowMs: number,
      member: Effect.Effect<boolean>,
      failed: Array<string>,
    ): Effect.Effect<Chosen, never, HttpClient.HttpClient | R> =>
      Effect.gen(function* () {
        let tokenError: string | undefined
        if (Option.isSome(app) && mayAct(app.value.repository, id) && !(appAbsentUntilMs !== null && appAbsentUntilMs > nowMs)) {
          const minted = yield* Effect.gen(function* () {
            const tokens = Tokens.make({ app: yield* app.value.auth, keys: Option.none(), refresh: Function.constant(Effect.void) })
            return yield* tokens.forInstallation({ owner, name, id }, "contents")
          }).pipe(Effect.provide(database), Effect.result)
          if (minted._tag === "Success") return { via: "app", token: Option.some(minted.success) }
          if (minted.failure instanceof Tokens.TokenUnavailable && minted.failure.reason === "app_not_installed") {
            yield* store.appAbsent(id, nowMs + ms(APP_RECHECK)).pipe(Effect.catch(() => Effect.sync(() => void failed.push("app_absent"))))
          } else {
            tokenError = minted.failure instanceof Tokens.TokenUnavailable ? `token:${minted.failure.reason}` : codeOf(minted.failure)
          }
        }
        // Curated repositories are deployment-owned public entry points, not arbitrary caller input.
        const deployment = (Curated.find(owner, name) !== undefined || (yield* member))
          ? yield* options.token : Option.none<Redacted.Redacted<string>>()
        return {
          via: Option.isSome(deployment) ? "deployment" : "anonymous",
          token: deployment,
          ...(tokenError === undefined ? {} : { tokenError }),
        }
      })

    /** One read of GitHub with `token`: GraphQL with one, REST without; and the least rate limit its calls left. */
    const fromGitHub = (owner: string, name: string, token: Option.Option<Redacted.Redacted<string>>) =>
      Effect.gen(function* () {
        const remaining = yield* Ref.make<number | undefined>(undefined)
        const http = HttpClient.tap(
          yield* HttpClient.HttpClient,
          (response) => Ref.update(remaining, (current) => least(current, response.headers["x-ratelimit-remaining"])),
        )
        const client = yield* GitHub.GitHubClient.make(
          {
            apiBaseUrl: options.apiBaseUrl,
            requestTimeout: REQUEST_TIMEOUT,
            ...(Option.isSome(token) ? { token: Redacted.value(token.value) } : {}),
          },
          // An explicit, empty environment: no ambient GITHUB_TOKEN chooses the account.
          {},
        ).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.orDie)
        const read = yield* (Option.isSome(token) && Curated.find(owner, name) === undefined ? graphql : rest)(client, owner, name, options.appSlug).pipe(Effect.result)
        return { read, rateRemaining: yield* Ref.get(remaining) }
      })

    /**
     * Whether github.com's own page for `owner/name` is a 404, the answer the spent anonymous API quota withheld. The
     * website spends no API quota and takes no token, so this widens nobody's access. Only an exact 404 counts:
     * a 429, a redirect's end or a failure leaves the repository unknown. A deployment on another GitHub API has no
     * github.com to ask.
     */
    const absentOnWeb = (owner: string, name: string) =>
      options.apiBaseUrl !== GitHubConfig.DEFAULT_API_URL
        ? Effect.succeed(false)
        : Effect.flatMap(HttpClient.HttpClient, (client) =>
            client.head(`${GITHUB_WEB}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`)).pipe(
            withUserAgent,
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.map((response) => response.status === 404),
            Effect.orElseSucceed(() => false),
          )

    /** A fresh answer as a request's: the browser keeps it until it goes stale. */
    const answered = (kept: KeptAnswer, cache: "hit" | "miss", nowMs: number) => ({
      _tag: "Answered" as const,
      text: kept.text,
      cache,
      via: kept.via,
      maxAgeSeconds: Math.max(0, Math.floor((kept.freshUntilMs - nowMs) / 1000)),
    })

    /** How long nobody asks GitHub again after `refusal`. */
    const holdFor = (refusal: AboutRefused, nowMs: number) =>
      refusal.code === "not_found"
        ? ms(NOT_FOUND_HOLD)
        : refusal.code === "rate_limited"
        ? Math.min(ms(MAX_HOLD), Math.max(ms(RATE_HOLD), refusal.retryAfterMillis ?? 0, (refusal.resetAtMillis ?? 0) - nowMs))
        : ms(HOLD)

    /** Records one read of GitHub: `repo.about.read` and `repo_about_reads`, and the rate limit it left. */
    const recorded = (id: string, read: GitHubRead) =>
      Effect.gen(function* () {
        yield* Metric.update(Metric.withAttributes(RepoMetrics.aboutReads, { via: read.via, outcome: read.outcome }), 1)
        if (read.rateRemaining !== undefined) {
          yield* Metric.update(Metric.withAttributes(RepoMetrics.aboutRateRemaining, { via: read.via }), read.rateRemaining)
        }
        yield* Effect.logWithLevel(read.outcome === "answered" ? "Info" : "Warn")("repo.about.read").pipe(
          Effect.annotateLogs({
            repoId: id,
            via: read.via,
            outcome: read.outcome,
            durationMs: read.durationMs,
            ...(read.stage === undefined ? {} : { stage: read.stage }),
            ...(read.upstreamStatus === undefined ? {} : { upstreamStatus: read.upstreamStatus }),
            ...(read.rateRemaining === undefined ? {} : { rateRemaining: read.rateRemaining }),
            ...(read.missing.length === 0 ? {} : { missing: read.missing.join(",") }),
            ...(read.tokenError === undefined ? {} : { tokenError: read.tokenError }),
          }),
        )
      })

    /**
     * Another request's first read of `id`, watched in the store from `startedMs` until it keeps an answer or a
     * refusal, for `timing.waitFor` at most; then the browser is asked to come back in `WAIT`.
     */
    const awaitRead = (id: string, startedMs: number): Effect.Effect<Outcome, never, R> =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(timing.poll)
          // A store that can't answer now is nothing yet; the wait still ends at its deadline.
          const row = Option.getOrUndefined(Option.flatten(yield* store.get(id).pipe(Effect.option)))
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
          if (waitedMs >= ms(timing.waitFor)) {
            return { _tag: "Refused" as const, code: "unavailable" as const, cache: "wait" as const, retryAfterMillis: ms(WAIT), waitedMs }
          }
        }
      })

    /** The answer for `id` (`owner/name` as the request named it) for one request. */
    const resolve = (
      id: string,
      owner: string,
      name: string,
      member: Effect.Effect<boolean>,
    ): Effect.Effect<Outcome, never, HttpClient.HttpClient | R> =>
      Effect.gen(function* () {
        const failed: Array<string> = []
        const storeDown = <A>(op: string, fallback: A) => () => Effect.sync(() => (failed.push(op), fallback))
        const kept = yield* store.get(id).pipe(Effect.option)
        const nowMs = yield* Clock.currentTimeMillis
        if (Option.isNone(kept)) {
          return { _tag: "Refused", code: "unavailable", cache: "wait", retryAfterMillis: ms(WAIT), store: ["get"] }
        }
        const row = Option.flatten(kept)
        const answer = Option.flatMap(row, (found) => found.answer)
        const extra = () => (failed.length === 0 ? {} : { store: [...failed] })
        if (Option.isSome(answer) && answer.value.freshUntilMs > nowMs) {
          return { ...answered(answer.value, "hit", nowMs), ...extra() }
        }
        // A read is due without a row or once its `next_read_at` passed. Every upstream read requires a claim.
        const due = Option.match(row, {
          onNone: () => true,
          onSome: (found) => found.nextReadAtMs === null || found.nextReadAtMs <= nowMs,
        })
        // An anonymous rate limit belongs to a different quota. A curated home may recover once with the
        // deployment token; the store atomically replaces the refusal with a claim, so concurrent reads still wait.
        // Even the deployment token effect may mint through GitHub. Take ownership before choosing any token;
        // if none is available, restore the original anonymous hold without reading repository metadata.
        const recoverAnonymous = !due && Curated.find(owner, name) !== undefined &&
          Option.isSome(row) && row.value.refusal === "rate_limited" &&
          (row.value.refusalVia === undefined || row.value.refusalVia === "anonymous")
        // Unknown ownership refuses both cold reads and refreshes; an outage never fans out to GitHub.
        const claim = store.claim(id, nowMs, nowMs + ms(CLAIM), recoverAnonymous).pipe(
          Effect.catch(storeDown("claim", undefined)),
        )
        const claimed = (due || recoverAnonymous) && (yield* claim)
        if (claimed === undefined) {
          return { _tag: "Refused", code: "unavailable", cache: "wait", retryAfterMillis: ms(WAIT), ...extra() }
        }
        if (!claimed) {
          const found = Option.getOrUndefined(row)
          const refusal = found?.refusal ?? null
          // Nothing fresh to serve: another request is reading it.
          if (refusal === null || recoverAnonymous) return { ...(yield* awaitRead(id, nowMs)), ...extra() }
          // A kept refusal always has its wait: `refuse` writes both.
          return {
            _tag: "Refused" as const,
            code: refusal,
            cache: "refusal" as const,
            ...(found!.refusalVia === undefined ? {} : { refusalVia: found!.refusalVia }),
            retryAfterMillis: Math.max(1000, found!.nextReadAtMs! - nowMs),
            ...extra(),
          }
        }
        const chosen = yield* tokenFor(owner, name, id, Option.getOrUndefined(row)?.appAbsentUntilMs ?? null, nowMs, member, failed)
        if (recoverAnonymous && Option.isNone(chosen.token)) {
          // Authentication could not be obtained: retain the anonymous quota hold without reading metadata.
          const held = Option.getOrThrow(row)
          const saved = yield* store.refuse(id, "rate_limited", held.nextReadAtMs!, held.refusalVia, claimed)
            .pipe(Effect.catch(storeDown("refuse", false)))
          return { _tag: "Refused", code: saved ? "rate_limited" : "unavailable", cache: saved ? "refusal" : "wait",
            retryAfterMillis: saved ? Math.max(1000, held.nextReadAtMs! - nowMs) : ms(WAIT),
            ...(held.refusalVia === undefined ? {} : { refusalVia: held.refusalVia }),
            ...(saved ? {} : { writeRejected: "refuse" as const }), ...extra() }
        }
        const { read, rateRemaining } = yield* fromGitHub(owner, name, chosen.token)
        const durationMs = (yield* Clock.currentTimeMillis) - nowMs
        const facts = {
          via: chosen.via,
          ...(rateRemaining === undefined ? {} : { rateRemaining }),
          ...(chosen.tokenError === undefined ? {} : { tokenError: chosen.tokenError }),
          durationMs,
        }
        if (read._tag === "Success") {
          const { about, missing } = read.success
          const window = ms(chosen.via === "anonymous" ? options.anonymousFreshFor : options.freshFor)
          const fresh: KeptAnswer = {
            text: JSON.stringify(about),
            via: chosen.via,
            readAtMs: nowMs,
            freshUntilMs: nowMs + (missing.length === 0 ? window : Math.min(window, ms(PARTIAL_FRESH))),
          }
          const record: GitHubRead = { ...facts, outcome: missing.length === 0 ? "answered" : "partial", missing }
          yield* recorded(id, record)
          const saved = yield* store.keep(id, fresh, claimed).pipe(Effect.catch(storeDown("keep", false)))
          if (!saved) {
            return { _tag: "Refused", code: "unavailable", cache: "wait", retryAfterMillis: ms(WAIT),
              read: record, writeRejected: "keep", ...extra() }
          }
          const answeredAtMs = yield* Clock.currentTimeMillis
          if (fresh.freshUntilMs <= answeredAtMs) {
            return { _tag: "Refused", code: "unavailable", cache: "wait", retryAfterMillis: ms(WAIT), read: record, ...extra() }
          }
          return { ...answered(fresh, "miss", answeredAtMs), read: record, ...extra() }
        }
        // GH-4: with the shared anonymous quota spent and nothing to serve, a rate limit says nothing of the repository,
        // so github.com's own 404 decides.
        const absent = read.failure.code === "rate_limited" && chosen.via === "anonymous" &&
          (yield* absentOnWeb(owner, name))
        const refusal = absent ? new AboutRefused({ code: "not_found", stage: "web", upstreamStatus: 404 }) : read.failure
        const record: GitHubRead = {
          ...facts,
          outcome: refusal.code,
          stage: refusal.stage,
          ...(refusal.upstreamStatus === undefined ? {} : { upstreamStatus: refusal.upstreamStatus }),
          missing: [],
        }
        yield* recorded(id, record)
        const saved = yield* store.refuse(id, refusal.code, nowMs + holdFor(refusal, nowMs), chosen.via, claimed).pipe(Effect.catch(storeDown("refuse", false)))
        if (!saved) {
          return { _tag: "Refused", code: "unavailable", cache: "wait", retryAfterMillis: ms(WAIT),
            read: record, writeRejected: "refuse", ...extra() }
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

    const answer: Source<R>["answer"] = (owner, name, member) =>
      resolve(repoId(owner, name), owner, name, member).pipe(Effect.withSpan("repo.about.answer"))

    return { answer } satisfies Source<R>
  })
