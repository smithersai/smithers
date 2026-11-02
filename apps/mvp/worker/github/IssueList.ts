import { Effect, Option, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { ISSUE_PAGE_DEFAULT, ISSUE_PAGE_MAX, ISSUES_SEGMENT, issuesRoute } from "../../src/features/issues/contract.ts"
import { isRepository, REPOS_ROUTE } from "../../src/features/repo/contract.ts"
import { WORK_FILTERS, type WorkFilter, type WorkStatus } from "../../src/features/issues/work.ts"
import { type ListedLink, workOf } from "./WorkLinks.ts"

// `GET /api/repos/<owner>/<name>/issues` (docs/features/issues.md#routes): a repository's issues from Smithers'
// projection, one page at a time, for a client that doesn't sync the whole list (the CLI, the proof, an agent). The
// browser's list stays the synced `item-summaries` shape. Who may read is the shapes' rule (`Access.repositoryReadable`),
// and a runner registered on the repository, with its token.
//
// Order is the latest update first, then the highest number. A page is at most `ISSUE_PAGE_MAX` issues; when more
// follow, `Link: <...&cursor=<c>>; rel="next"` names the next page, as GitHub's REST API does. The cursor is the
// last issue's `(updated_at, number)`, so a page never repeats or skips an issue that didn't change meanwhile.

/** The repository an issues route names, from `/api/repos/<owner>/<name>/issues`; none for any other path. */
export const parseIssuesPath = (path: string): { readonly owner: string; readonly name: string } | undefined => {
  if (!path.startsWith(`${REPOS_ROUTE}/`)) return undefined
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  if (segments.length !== 3 || segments[2] !== ISSUES_SEGMENT) return undefined
  try {
    const owner = decodeURIComponent(segments[0]!)
    const name = decodeURIComponent(segments[1]!)
    return isRepository(owner, name) ? { owner, name } : undefined
  } catch {
    return undefined
  }
}

/** Where a page starts after: the last issue's update time (Postgres' microseconds, UTC) and number. */
export interface Cursor {
  readonly updatedAt: string
  readonly number: number
}

const CursorJson = Schema.fromJsonString(Schema.Struct({ u: Schema.String, n: Schema.Int }))
const decodeCursorJson = Schema.decodeUnknownOption(CursorJson)
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

export const encodeCursor = (cursor: Cursor): string =>
  btoa(JSON.stringify({ u: cursor.updatedAt, n: cursor.number })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** Base64url text as ASCII, or `undefined` when it isn't base64. A cursor holds only ASCII. */
const fromBase64Url = (text: string): string | undefined => {
  try {
    return atob(text.replace(/-/g, "+").replace(/_/g, "/"))
  } catch {
    return undefined
  }
}

/** A cursor this route made, or `undefined` for anything else. */
export const decodeCursor = (text: string): Cursor | undefined => {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(text)) return undefined
  return Option.getOrUndefined(Option.flatMap(decodeCursorJson(fromBase64Url(text) ?? ""), ({ u, n }) =>
    TIME.test(u) && !Number.isNaN(Date.parse(u)) && n >= 1 ? Option.some({ updatedAt: u, number: n }) : Option.none()))
}

/** What one request asks for. */
export interface Query {
  readonly state: "open" | "closed" | "all"
  readonly q: string
  readonly limit: number
  readonly cursor: Cursor | undefined
  /** Only issues whose work links reach a pull request or a queue entry, or that have any link (decision 0147). */
  readonly work: WorkFilter | undefined
}

/** The request's query, or `undefined` when any part is one this route doesn't take. */
export const parseQuery = (search: URLSearchParams): Query | undefined => {
  const state = search.get("state") ?? "open"
  if (state !== "open" && state !== "closed" && state !== "all") return undefined
  const rawLimit = search.get("limit")
  const limit = rawLimit === null ? ISSUE_PAGE_DEFAULT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1) return undefined
  const rawCursor = search.get("cursor")
  const cursor = rawCursor === null || rawCursor === "" ? undefined : decodeCursor(rawCursor)
  if (rawCursor !== null && rawCursor !== "" && cursor === undefined) return undefined
  const work = search.get("work") ?? ""
  if (work !== "" && !(WORK_FILTERS as ReadonlyArray<string>).includes(work)) return undefined
  return {
    state,
    q: (search.get("q") ?? "").trim().slice(0, 256),
    limit: Math.min(limit, ISSUE_PAGE_MAX),
    cursor,
    work: work === "" ? undefined : work as WorkFilter,
  }
}

/** One issue as the route answers it. */
export interface ListedIssue {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly author: { readonly login: string | null }
  readonly comments: number
  readonly created_at: string
  readonly updated_at: string
  readonly triage: string
  readonly commitment: string | null
  /** The work on it, from its links: `none` with no links. */
  readonly work: { readonly status: WorkStatus; readonly links: ReadonlyArray<ListedLink> }
}

interface Row {
  readonly number: number
  readonly title: string
  readonly state: string
  readonly author_login: string | null
  readonly comments: number
  readonly created_at: string
  readonly updated_at: string
  readonly cursor_at: string
  readonly triage: string
  readonly commitment: string | null
}

const UTC_MICROS = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'

/** One page of `repoId`'s issues for `query`, and the cursor of the page after it when there is one. */
export const page = (repoId: string, query: Query) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const number = /^#?(\d{1,10})$/.exec(query.q)?.[1]
    const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const rows = yield* sql<Row>`
      SELECT number, title, state, author_login, comments, triage, commitment,
        to_char(created_at AT TIME ZONE 'UTC', ${UTC_MICROS}) AS created_at,
        to_char(updated_at AT TIME ZONE 'UTC', ${UTC_MICROS}) AS updated_at,
        to_char(updated_at AT TIME ZONE 'UTC', ${UTC_MICROS}) AS cursor_at
      FROM items
      WHERE repo_id = ${repoId} AND kind = 'issue' AND deleted_at IS NULL
        ${query.state === "all" ? sql`` : sql`AND state = ${query.state}`}
        ${query.q === "" ? sql`` : number === undefined
          ? sql`AND title ILIKE ${like}`
          : sql`AND (number = ${Number(number)} OR title ILIKE ${like})`}
        ${query.cursor === undefined ? sql`` : sql`AND (updated_at, number) < (${query.cursor.updatedAt}::timestamptz, ${query.cursor.number})`}
        ${query.work === undefined ? sql`` : sql`AND EXISTS (SELECT 1 FROM work_links w WHERE w.repo_id = items.repo_id
          AND w.number = items.number ${query.work === "pr-or-queue" ? sql`AND w.kind IN ('pr', 'queue')` : sql``})`}
      ORDER BY updated_at DESC, number DESC
      LIMIT ${query.limit + 1}`
    const shown = rows.slice(0, query.limit)
    const last = shown.at(-1)
    const work = yield* workOf(repoId, shown.map((row) => row.number))
    const issues: Array<ListedIssue> = shown.map((row) => ({
      number: row.number,
      title: row.title,
      state: row.state,
      author: { login: row.author_login },
      comments: row.comments,
      created_at: row.created_at,
      updated_at: row.updated_at,
      triage: row.triage,
      commitment: row.commitment,
      work: work.get(row.number) ?? { status: "none", links: [] },
    }))
    return {
      issues,
      next: rows.length > query.limit && last !== undefined ? encodeCursor({ updatedAt: last.cursor_at, number: last.number }) : undefined,
    }
  })

/** The answer for one page: the issues, and a relative `Link` to the next page when there is one. */
export const answer = (
  target: { readonly owner: string; readonly name: string },
  search: URLSearchParams,
  found: { readonly issues: ReadonlyArray<ListedIssue>; readonly next: string | undefined },
) => {
  const headers: Record<string, string> = { "cache-control": "no-store", vary: "cookie, authorization" }
  if (found.next !== undefined) {
    const params = new URLSearchParams(search)
    params.set("cursor", found.next)
    headers.link = `<${issuesRoute(target.owner, target.name)}?${params.toString()}>; rel="next"`
  }
  return HttpServerResponse.jsonUnsafe(found.issues, { headers })
}
