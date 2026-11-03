import { earlySearch, type EarlySearchHost, type EarlyRead } from "./earlySearch"
import { Context, Data, type Duration, Effect, Layer, Option, Schema, type SubscriptionRef } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { renewalOf, renewed, withBearer, withoutCookie } from "../../flows/bearer"
import { CONFIRM_401_HEADER, sessionCheckOf } from "../auth/contract"
import { issuesRoute, type TriageDecision, type WriteOp, writesRoute } from "./contract"
import { ListedIssue, WriteTaken } from "./schema"

// ChatApi's writes route as the browser calls it (decision 0012 §4, docs/features/issues.md#routes), through Effect's
// HttpClient, with one deadline covering the whole exchange, its body included.

/**
 * ChatApi didn't take the write: no whole answer within the deadline, or no network (`status` absent), any status but
 * 200 and 202 (`status`), or a 200 or 202 whose body isn't the contract's. A session write's `401` the page's transport
 * checked against the session carries what it found (`sessionCheck`).
 */
export class WriteNotTaken extends Data.TaggedError("WriteNotTaken")<{
  readonly status?: number
  readonly code?: string
  readonly sessionCheck?: "same_person"
}> {}

/** A write as the route takes it. It names nobody: who acts is the session's or the run credential's to say. */
export type WriteRequest =
  | { readonly writeId: string; readonly op: "issue/commitment"; readonly number: number; readonly commitment: import("./lifecycle").Commitment }
  | { readonly writeId: string; readonly op: Extract<WriteOp, "issue/create">; readonly title: string; readonly body: string }
  | {
    readonly writeId: string
    readonly op: Extract<WriteOp, "issue/comment">
    readonly number: number
    readonly body: string
  }
  | {
    readonly writeId: string
    readonly op: Extract<WriteOp, "issue/triage">
    readonly number: number
    readonly decision: TriageDecision
    readonly reason?: string
  }
  | { readonly writeId: string; readonly op: Extract<WriteOp, "triage/run">; readonly number: number }
  | { readonly writeId: string; readonly op: Extract<WriteOp, "triage/enable">; readonly dailyTokens?: number }
  | { readonly writeId: string; readonly op: Extract<WriteOp, "triage/pause"> }

const decodeTaken = Schema.decodeUnknownEffect(WriteTaken)

/** A refusal's `{ code }`, when its body has one. */
const decodeCode = (body: unknown): string | undefined =>
  Option.getOrUndefined(Option.map(Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(body), ({ code }) => code))

/**
 * `POST /api/repos/<owner>/<name>/writes`: `202` took a new write, `200` had it already. With `credential`, the write
 * goes as the run that wrote it, with that run credential and without the session cookie (decision 0017 slice 0).
 */
export const postWrite = (
  origin: string,
  repository: { readonly owner: string; readonly name: string },
  write: WriteRequest,
  within: Duration.Input,
  credential?: string,
) =>
  Effect.gen(function* () {
    if (credential !== undefined && Option.isNone(renewalOf(credential))) {
      return yield* new WriteNotTaken({ status: 400 })
    }
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(`${origin}${writesRoute(repository.owner, repository.name)}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(write),
    )
    // A run's write goes with a fresh credential of that run, never in the person's session (flows/bearer.ts `renewed`).
    const authority = credential === undefined
      ? undefined
      : yield* renewed(origin, credential).pipe(
        Effect.mapError(({ status }) => new WriteNotTaken(status === undefined ? {} : { status })),
      )
    // A 401 in the session is checked against the session first, so a queued write can be held (writes.ts); a run's
    // 401 is about the run, and stands.
    const response = yield* (authority === undefined
      ? client.execute(HttpClientRequest.setHeader(request, CONFIRM_401_HEADER, "1"))
      : withoutCookie(client.execute(withBearer(request, authority))))
      .pipe(Effect.mapError(() => new WriteNotTaken({})))
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
    if (response.status === 404) {
      // One status, two reasons (decision 0079 §7): the body's code says whether the App isn't installed.
      const code = yield* response.json.pipe(Effect.map(decodeCode), Effect.orElseSucceed(() => undefined))
      return yield* new WriteNotTaken(code === undefined ? { status: 404 } : { status: 404, code })
    }
    if (response.status !== 200 && response.status !== 202) {
      return yield* new WriteNotTaken({ status: response.status, ...sessionCheckOf(response.headers) })
    }
    return yield* response.json.pipe(
      Effect.flatMap(decodeTaken),
      Effect.mapError(() => new WriteNotTaken({ status: response.status })),
    )
  }).pipe(
    // Interrupting the request aborts its fetch, so a stalled body stops too.
    Effect.timeoutOrElse({ duration: within, orElse: () => Effect.fail(new WriteNotTaken({})) }),
  )

/** The issues route didn't answer a search: no whole answer within the deadline (`status` absent), a refusal, or another body. */
export class SearchNotAnswered extends Data.TaggedError("SearchNotAnswered")<{ readonly status?: number }> {}

const decodeListed = Schema.decodeUnknownEffect(Schema.Array(ListedIssue))

/**
 * The list's first search page, or the exact `number` across those pages for a direct issue. Title matches can precede
 * that number, so a direct read follows the route's cursors until found or exhausted, under one whole-read deadline.
 * It retains only the exact issue and never follows a link's authority or path.
 */
export const getSearch = (
  origin: string,
  repository: { readonly owner: string; readonly name: string },
  q: string,
  within: Duration.Input,
  number?: number,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const url = `${origin}${issuesRoute(repository.owner, repository.name)}?state=all&q=${encodeURIComponent(q)}`
    let cursor: string | undefined
    const seen = new Set<string>()
    while (true) {
      const response = yield* client.execute(HttpClientRequest.get(cursor === undefined ? url : `${url}&cursor=${encodeURIComponent(cursor)}`))
      if (response.status !== 200) return yield* new SearchNotAnswered({ status: response.status })
      const issues = yield* decodeListed(yield* response.json)
      if (number === undefined) return issues
      const exact = issues.find((issue) => issue.number === number)
      if (exact !== undefined) return [exact]
      const link = response.headers.link
      if (link === undefined) return []
      const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1]
      const nextUrl = next === undefined ? undefined : new URL(next, url)
      cursor = nextUrl?.searchParams.get("cursor") ?? undefined
      if (cursor === undefined || seen.has(cursor)) return yield* new SearchNotAnswered({})
      seen.add(cursor)
    }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(within),
    Effect.flatMap(Option.match({ onNone: () => Effect.fail(new SearchNotAnswered({})), onSome: Effect.succeed })),
    Effect.catch((error) => error instanceof SearchNotAnswered ? Effect.fail(error) : Effect.fail(new SearchNotAnswered({}))),
  )

/**
 * ChatApi's writes route, as a service: the one way the browser sends a git write. Tests of a route that fails provide
 * a faulty one; every other test uses the real one.
 */
export class IssuesClient extends Context.Service<
  IssuesClient,
  {
    /** Sends `write`: as the run whose `credential` it carries, else in the person's session. */
    readonly write: (
      owner: string,
      name: string,
      write: WriteRequest,
      credential?: string,
    ) => Effect.Effect<WriteTaken, WriteNotTaken>
    readonly early?: SubscriptionRef.SubscriptionRef<EarlyRead | undefined>
    /** The list's first search page, or only the exact `number` across its pages for a direct issue. */
    readonly search: (owner: string, name: string, q: string, number?: number) => Effect.Effect<ReadonlyArray<ListedIssue>, SearchNotAnswered>
  }
>()("@smthrs/mvp/issues/IssuesClient") {
  /** The real client: ChatApi at `origin`, with `within` for each whole request. */
  static readonly layer = (options: { readonly origin: string; readonly within: Duration.Input; readonly early?: EarlySearchHost }) =>
    Layer.effect(
      IssuesClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const search: IssuesClient["Service"]["search"] = (owner, name, q, number) =>
          getSearch(options.origin, { owner, name }, q, options.within, number).pipe(Effect.provideService(HttpClient.HttpClient, client))
        const early = options.early === undefined ? undefined : yield* earlySearch(search, options.early)
        return IssuesClient.of({
          ...(early === undefined ? {} : { early: early.pending }),
          write: (owner, name, write, credential) =>
            postWrite(options.origin, { owner, name }, write, options.within, credential).pipe(
              Effect.provideService(HttpClient.HttpClient, client),
            ),
          search: early ?? search,
        })
      }),
    )
}
