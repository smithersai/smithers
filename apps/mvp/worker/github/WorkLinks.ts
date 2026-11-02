import { digestSync } from "@smthrs/crypto"
import { Effect, Option, Schema } from "effect"
import type { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { ISSUES_SEGMENT } from "../../src/features/issues/contract.ts"
import { isRepository, REPOS_ROUTE } from "../../src/features/repo/contract.ts"
import {
  LINKS_SEGMENT,
  MAX_LABEL_LENGTH,
  MAX_LINKS_PER_POST,
  MAX_REF_LENGTH,
  MAX_URL_LENGTH,
  WORK_LINK_KINDS,
  WORK_LINK_STATES,
  type WorkLinkKind,
  type WorkLinkState,
  workLinkId,
  workStatusOf,
  type WorkStatus,
} from "../../src/features/issues/work.ts"
import { bearerOf } from "../RunCredentials.ts"

// Work links' server side (decision 0147, docs/features/work-links.md): decoding a post, who may post (a Member or
// above on the repository, in their session or a run's credential, or a runner registered on that repository with its
// own token), writing the rows, and reading them back for the issues list.

/** The repository and issue a links route names, from `/api/repos/<owner>/<name>/issues/<number>/links`. */
export const parseLinksPath = (
  path: string,
): { readonly owner: string; readonly name: string; readonly number: number } | undefined => {
  if (!path.startsWith(`${REPOS_ROUTE}/`)) return undefined
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  if (segments.length !== 5 || segments[2] !== ISSUES_SEGMENT || segments[4] !== LINKS_SEGMENT) return undefined
  if (!/^[1-9]\d{0,9}$/.test(segments[3]!) || Number(segments[3]) > 2_147_483_647) return undefined
  try {
    const owner = decodeURIComponent(segments[0]!)
    const name = decodeURIComponent(segments[1]!)
    return isRepository(owner, name) ? { owner, name, number: Number(segments[3]) } : undefined
  } catch {
    return undefined
  }
}

const Text = (max: number) =>
  Schema.String.check(Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value)))
const Url = Schema.String.check(Schema.makeFilter((value: string) => {
  if (value.length > MAX_URL_LENGTH) return false
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}))
const Time = Schema.String.check(Schema.makeFilter((value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value) && !Number.isNaN(Date.parse(value))))

const PostedLink = Schema.Struct({
  kind: Schema.Literals(WORK_LINK_KINDS),
  ref: Text(MAX_REF_LENGTH),
  label: Schema.optional(Text(MAX_LABEL_LENGTH)),
  url: Schema.optional(Schema.NullOr(Url)),
  state: Schema.optional(Schema.NullOr(Schema.Literals(WORK_LINK_STATES))),
  /** When the linked thing changed (UTC ISO 8601); the server's receipt time when absent. */
  at: Schema.optional(Time),
})
const Post = Schema.Struct({
  links: Schema.Array(PostedLink).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_LINKS_PER_POST)),
})
export type Post = typeof Post.Type
const decodePost = Schema.decodeUnknownOption(Schema.fromJsonString(Post))

/** A post's body, or `undefined` for one this route doesn't take. */
export const decode = (text: string): Post | undefined => Option.getOrUndefined(decodePost(text))

/** How far ahead of the server's clock a link's `at` may be: a little clock skew, never a future that pins a state. */
export const MAX_SKEW_MS = 5 * 60 * 1000

/** Whether any link's `at` is further ahead than `MAX_SKEW_MS` of `now`. */
export const fromTheFuture = (post: Post, now: number): boolean =>
  post.links.some((link) => link.at !== undefined && Date.parse(link.at) > now + MAX_SKEW_MS)

/** The runner whose token a request carries, when it is one registered on `repoId` and not removed. */
export const runnerOf = (request: HttpServerRequest.HttpServerRequest, repoId: string) =>
  Effect.gen(function* () {
    const token = bearerOf(request)
    if (Option.isNone(token)) return Option.none<string>()
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly name: string }>`
      SELECT name FROM runners WHERE token_sha256 = ${digestSync(token.value)} AND repo_id = ${repoId} AND removed_at IS NULL`
    return Option.map(Option.fromNullishOr(row), (found) => found.name)
  })

/**
 * Writes `post`'s links of issue `number` as `source`, in one statement. A link already there changes only for an `at`
 * no older than its own and something to change. Answers how many rows changed.
 */
export const write = (repoId: string, number: number, post: Post, source: string, now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const received = new Date(now).toISOString()
    // One row per key: the last of a post's duplicates wins.
    const rows = [...new Map(post.links.map((link) => [workLinkId(repoId, number, link.kind, link.ref), link])).entries()].map(([id, link]) => ({
      id,
      repo_id: repoId,
      number,
      kind: link.kind,
      ref: link.ref,
      label: link.label ?? link.ref,
      url: link.url ?? null,
      state: link.state ?? null,
      source,
      updated_at: link.at ?? received,
    }))
    const changed = yield* sql<{ readonly id: string }>`
      INSERT INTO work_links (id, repo_id, number, kind, ref, label, url, state, source, updated_at)
      SELECT id, repo_id, number, kind, ref, label, url, state, source, updated_at
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(id text, repo_id text, number integer, kind text,
        ref text, label text, url text, state text, source text, updated_at timestamptz)
      ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, url = EXCLUDED.url, state = EXCLUDED.state,
        source = EXCLUDED.source, updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at >= work_links.updated_at
        AND (work_links.label, work_links.url, work_links.state, work_links.source)
          IS DISTINCT FROM (EXCLUDED.label, EXCLUDED.url, EXCLUDED.state, EXCLUDED.source)
      RETURNING id`
    return { links: rows.length, changed: changed.length }
  })

/** One link as the issues list answers it. */
export interface ListedLink {
  readonly kind: WorkLinkKind
  readonly ref: string
  readonly label: string
  readonly url: string | null
  readonly state: WorkLinkState | null
  readonly source: string
  readonly updated_at: string
}

/** The work on each of `numbers`: its status and links, newest first. Issues with no link are absent. */
export const workOf = (repoId: string, numbers: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const found = new Map<number, { status: WorkStatus; links: Array<ListedLink> }>()
    if (numbers.length === 0) return found
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<ListedLink & { readonly number: number }>`
      SELECT number, kind, ref, label, url, state, source,
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
      FROM work_links WHERE repo_id = ${repoId} AND number = ANY(${numbers.map(String)}::integer[])
      ORDER BY updated_at DESC, id`
    for (const { number, ...link } of rows) {
      const entry = found.get(number) ?? { status: "none" as WorkStatus, links: [] }
      entry.links.push(link)
      found.set(number, entry)
    }
    for (const entry of found.values()) {
      entry.status = workStatusOf(entry.links.map((link) => ({ kind: link.kind, state: link.state, updatedAt: link.updated_at })))
    }
    return found
  })

/** The largest post, in bytes: `MAX_LINKS_PER_POST` links of the longest ref, label and URL, and their JSON. */
export const MAX_POST_BYTES = 4 * MAX_LINKS_PER_POST * (MAX_REF_LENGTH + MAX_LABEL_LENGTH + MAX_URL_LENGTH + 200)
