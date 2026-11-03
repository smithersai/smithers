import { Cause, Context, Duration, Effect, Exit, Fiber, Option } from "effect"
import { HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { FIRST_PAINT_SEGMENT, type FirstPaint, type FirstPaintIssue, ISSUE_PAGE_DEFAULT } from "../../src/features/issues/contract.ts"
import { isRepository, REPOS_ROUTE } from "../../src/features/repo/contract.ts"

// `GET /api/repos/<owner>/<name>/first-paint?issue=<n>` and `?list=all` (docs/features/issues.md#first-paint, devpriv
// FINAL §3.10): what a cold issue page or issues list paints before the app boots, from the shell's inline script. Who may
// read is the shapes' rule (`Access.repositoryReadable`) for the session cookie's person alone: never a run credential or
// a runner's token. A first paint never says why it can't paint: every refusal, an invalid request, a missing issue, a
// read Postgres couldn't answer and a read past its deadline are one empty `204`. Every answer is `private, no-store`, so
// no cache keeps a person's titles. It starts no Reconcile: the app's own shapes do a second later.

/** The headers of every first-paint answer, a paint or not. */
export const FIRST_PAINT_HEADERS = {
  "cache-control": "private, no-store",
  vary: "cookie",
  "x-robots-tag": "noindex",
} as const

/**
 * How long the route reads before it answers `204`. A person back after five minutes has a stale role, which only
 * GitHub can renew (a stale role never decides): about 1.5 s, so this leaves that read room. A title at 2.5 s still
 * beats the app's own, which comes later.
 */
export const FIRST_PAINT_DEADLINE_MS = 2_500

/** How long the role read a late first paint leaves behind may run, past the response. */
export const BEHIND_WITHIN = Duration.seconds(15)

/**
 * Work a request leaves to run after its response (worker/RequestBackground.ts). A first paint past its deadline leaves
 * its role read here, so the person's next read finds it fresh. Absent, as in a test that gives none, nothing runs.
 */
export class Behind extends Context.Service<Behind, { readonly run: (work: Effect.Effect<void>) => Effect.Effect<void> }>()(
  "@smthrs/mvp/github/first-paint/Behind",
) {}

/** What a first paint asks for: one issue, or the list's first page. */
export type Form = { readonly kind: "issue"; readonly number: number } | { readonly kind: "list" }

/** The repository a first-paint route names, from `/api/repos/<owner>/<name>/first-paint`; none for any other path. */
export const parseFirstPaintPath = (path: string): { readonly owner: string; readonly name: string } | undefined => {
  if (!path.startsWith(`${REPOS_ROUTE}/`)) return undefined
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  if (segments.length !== 3 || segments[2] !== FIRST_PAINT_SEGMENT) return undefined
  try {
    const owner = decodeURIComponent(segments[0]!)
    const name = decodeURIComponent(segments[1]!)
    return isRepository(owner, name) ? { owner, name } : undefined
  } catch {
    return undefined
  }
}

/** The form a query asks for: exactly one of `issue=<n>` (a positive number) or `list=all`; none for anything else. */
export const parseForm = (search: URLSearchParams): Form | undefined => {
  const keys = [...search.keys()]
  if (keys.length !== 1) return undefined
  if (search.get("list") === "all") return { kind: "list" }
  const issue = search.get("issue")
  if (issue === null || !/^[1-9]\d{0,9}$/.test(issue)) return undefined
  const number = Number(issue)
  return number <= 2_147_483_647 ? { kind: "issue", number } : undefined
}

interface Row {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly author_login: string | null
}

const issueOf = (row: Row): FirstPaintIssue => ({ number: row.number, title: row.title, state: row.state, author: row.author_login })

/**
 * What `form` reads of repository `repoId`: its issue, or the first page of its issues in the list's default order
 * (latest update first, then the highest number; `IssueList.page`'s order). `undefined`: no such issue.
 */
export const read = (repoId: string, form: Form) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (form.kind === "issue") {
      const rows = yield* sql<Row>`
        SELECT number, title, state, author_login FROM items
        WHERE repo_id = ${repoId} AND number = ${form.number} AND kind = 'issue' AND deleted_at IS NULL`
      const [row] = rows
      return row === undefined ? undefined : { issue: issueOf(row) }
    }
    const rows = yield* sql<Row>`
      SELECT number, title, state, author_login FROM items
      WHERE repo_id = ${repoId} AND kind = 'issue' AND deleted_at IS NULL
      ORDER BY updated_at DESC, number DESC
      LIMIT ${ISSUE_PAGE_DEFAULT}`
    return { list: rows.map(issueOf) }
  })

/** The one answer every first paint that doesn't paint gets. */
export const nothing = () => HttpServerResponse.empty({ status: 204, headers: FIRST_PAINT_HEADERS })

/** A paint: `body` for the viewer, with the headers every answer carries. */
export const painted = (body: FirstPaint) => HttpServerResponse.jsonUnsafe(body, { status: 200, headers: FIRST_PAINT_HEADERS })

/**
 * `answer` within `deadlineMs`: past it, or failing or dying, the empty `204`, with `fields.outcome` saying which
 * (`deadline` or `error`, and the failure's `errorCode` by `codeOf`). The deadline never interrupts the read, so no
 * cleanup of its (a role claim given back, a transaction that must first begin) holds the answer: the read keeps running
 * on its own fiber behind the response (`Behind`), at most `behindMs`, and what it renews, such as the person's role,
 * is there for their next read. Its answer goes nowhere. With no `Behind`, it is interrupted, on a fiber of its own.
 */
export const guarded = <E, R>(
  answer: (fields: Record<string, string | number>) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  fields: Record<string, string | number>,
  codeOf: (error: unknown) => string,
  deadlineMs: number = FIRST_PAINT_DEADLINE_MS,
  behindMs: Duration.Input = BEHIND_WITHIN,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  Effect.gen(function* () {
    // The read writes its own fields, which only an answer in time hands back: a late read rewrites nothing counted.
    const own = { ...fields }
    const read = yield* Effect.forkDetach(answer(own))
    const answered = yield* Fiber.join(read).pipe(Effect.timeoutOption(Duration.millis(deadlineMs)))
    if (Option.isSome(answered)) {
      Object.assign(fields, own)
      return answered.value
    }
    fields.outcome = "deadline"
    const stop = Effect.asVoid(Effect.forkDetach(Fiber.interrupt(read)))
    const behind = yield* Effect.serviceOption(Behind)
    yield* Option.isNone(behind) ? stop : behind.value.run(
      Fiber.await(read).pipe(
        Effect.timeoutOption(behindMs),
        Effect.flatMap(Option.match({
          onNone: () => stop,
          // Behind the response nothing else says a read failed.
          onSome: Exit.match({
            onFailure: (cause) => Effect.logWarning("github.first_paint.behind").pipe(Effect.annotateLogs({ errorCode: codeOf(Cause.squash(cause)) })),
            onSuccess: () => Effect.void,
          }),
        })),
      ),
    )
    return nothing()
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        fields.outcome = "error"
        fields.errorCode = codeOf(Cause.squash(cause))
        return nothing()
      })
    ),
  )
