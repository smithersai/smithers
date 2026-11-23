import type { ImmutableCache } from "@smthrs/artifacts"
import { digestSync } from "@smthrs/crypto"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { agentAttribution, writeExecutionId } from "../../src/features/issues/contract.ts"
import { repoId, textOf } from "../../src/features/repo/contract.ts"
import { TreeListing as RepoTreeListing } from "../../src/features/repo/schema.ts"
import type { FlowStarter } from "../Flows.ts"
import * as IssueList from "../github/IssueList.ts"
import * as Store from "../github/Store.ts"
import * as WorkLinks from "../github/WorkLinks.ts"
import { Write } from "../github/Write.ts"
import type * as RepoReads from "../RepoReads.ts"
import { McpToolError } from "./Contract.ts"
import { makeLiveToolDeps, type McpToolDeps, type WriteReceipt } from "./Tools.ts"

const decoder = new TextDecoder("utf-8", { fatal: false })
const decodeTree = Schema.decodeUnknownEffect(Schema.fromJsonString(RepoTreeListing))
const SHA_RE = /^[0-9a-f]{40}$/i

const mapReadError = (error: RepoReads.ReadRefused): McpToolError => {
  switch (error.code) {
    case "not_found":
    case "not_imported":
    case "not_synced":
      return new McpToolError({ code: "not_found", message: `Repository content not found (${error.code})` })
    case "too_large":
      return new McpToolError({ code: "invalid_params", message: "File exceeds maximum preview size" })
    case "rate_limited":
    case "capacity":
      return new McpToolError({ code: "rate_limited", message: "Repository read capacity exceeded" })
    default:
      return new McpToolError({ code: "unavailable", message: "Repository storage is temporarily unavailable" })
  }
}

const mapSqlError = (what: string) => () =>
  new McpToolError({ code: "unavailable", message: `Database error while executing ${what}` })

/**
 * Strips the trailing `Smithers for @<login> (agent)` footer `Tools.ts` adds before handing `body` to `github/Write`,
 * which appends `agentAttribution(login)` itself for `via: "agent"` writes, so GitHub receives one clean footer.
 */
const stripDuplicateFooter = (body: string, login: string): string => {
  const footer = `${agentAttribution(login)} (agent)`
  if (body === footer) return ""
  const suffix = `\n\n${footer}`
  return body.endsWith(suffix) ? body.slice(0, -suffix.length) : body
}

export interface LiveDepsOptions<R = never> {
  readonly database: Layer.Layer<SqlClient.SqlClient, unknown, R>
  readonly reads: Option.Option<ReturnType<typeof RepoReads.make<unknown, R>>>
  readonly repoCache: Layer.Layer<ImmutableCache.ImmutableCache>
  readonly starter: FlowStarter["Service"]
}

/**
 * Binds `McpToolDeps` to ChatApi's live services: `RepoReads` (Code Storage + edge cache), Postgres projections
 * (`items`, `comments`, `pulls`, `reviews`, `runs`, `todos`), durable `github/Write` admission, and `WorkLinks.write`.
 */
export const makeLiveDeps = <R = never>(options: LiveDepsOptions<R>): Effect.Effect<McpToolDeps, never, R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const database = options.database.pipe(Layer.provide(Layer.succeedContext(context)))
    const { reads, repoCache, starter } = options
    const withCtx = <A, E>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E> => eff.pipe(Effect.provide(context))

    const resolveSha = (owner: string, name: string, ref?: string) =>
      Effect.gen(function* () {
        if (Option.isNone(reads)) {
          return yield* new McpToolError({ code: "unavailable", message: "Code storage is not configured" })
        }
        if (ref !== undefined && SHA_RE.test(ref)) return ref.toLowerCase()
        const listing = yield* withCtx(reads.value.refs(owner, name).pipe(Effect.provide(repoCache))).pipe(
          Effect.mapError(mapReadError),
        )
        if (ref === undefined || ref === listing.defaultBranch) return listing.head
        const branch = listing.branches.find((b) => b.name === ref)
        if (branch !== undefined) return branch.sha
        const tag = listing.tags.find((t) => t.name === ref)
        if (tag !== undefined) return tag.sha
        return yield* new McpToolError({ code: "not_found", message: `Unknown ref ${ref}` })
      })

  const admitWrite = (
    owner: string,
    name: string,
    writeId: string,
    personId: string,
    payload: { readonly op: "issue/create"; readonly title: string; readonly body: string } | { readonly op: "issue/comment"; readonly number: number; readonly body: string },
  ): Effect.Effect<WriteReceipt, McpToolError> =>
    Effect.gen(function* () {
      const id = repoId(owner, name)
      const via = "agent" as const
      const payloadHash = digestSync(JSON.stringify({ via, ...payload }))
      const inserted = yield* Store.insertWrite({
        id: writeId,
        repoId: id,
        actorId: personId,
        sessionId: null,
        via,
        payload,
        payloadHash,
      }).pipe(Effect.provide(database), Effect.mapError(mapSqlError(payload.op)))

      if (inserted.kind === "stale") {
        return yield* new McpToolError({ code: "forbidden", message: "Repository permission no longer holds" })
      }
      if (inserted.kind === "taken" || (inserted.kind === "existing" && inserted.payloadHash !== payloadHash)) {
        return yield* new McpToolError({ code: "conflict", message: "Idempotency key already used for a different write" })
      }
      if (inserted.kind === "inserted" || inserted.status === "pending") {
        yield* starter.start(Write, {
          executionId: writeExecutionId(writeId),
          payload: { writeId },
        }).pipe(
          Effect.mapError(() => new McpToolError({ code: "unavailable", message: "Could not start durable GitHub write" })),
        )
      }
      return {
        writeId,
        status: inserted.kind === "inserted" ? "pending" : inserted.status,
      }
    })

  return makeLiveToolDeps({
    readTree: (owner, name, ref) =>
      Effect.gen(function* () {
        if (Option.isNone(reads)) {
          return yield* new McpToolError({ code: "unavailable", message: "Code storage is not configured" })
        }
        const sha = yield* resolveSha(owner, name, ref)
        const bytes = yield* withCtx(reads.value.tree(owner, name, sha).pipe(Effect.provide(repoCache))).pipe(
          Effect.mapError(mapReadError),
        )
        const parsed = yield* decodeTree(decoder.decode(bytes)).pipe(
          Effect.mapError(() => new McpToolError({ code: "unavailable", message: "Malformed tree listing" })),
        )
        return { ref: sha, paths: parsed.paths, truncated: parsed.truncated }
      }),

    readFile: (owner, name, path, ref) =>
      Effect.gen(function* () {
        if (Option.isNone(reads)) {
          return yield* new McpToolError({ code: "unavailable", message: "Code storage is not configured" })
        }
        const sha = yield* resolveSha(owner, name, ref)
        const entry = yield* withCtx(reads.value.blob(owner, name, sha, path).pipe(Effect.provide(repoCache))).pipe(
          Effect.mapError(mapReadError),
        )
        const content = textOf(entry.bytes)
        if (content === undefined) {
          return { path, ref: sha, content: "\u0000" }
        }
        return { path, ref: sha, content }
      }),

    listRefs: (owner, name) =>
      Effect.gen(function* () {
        if (Option.isNone(reads)) {
          return yield* new McpToolError({ code: "unavailable", message: "Code storage is not configured" })
        }
        const listing = yield* withCtx(reads.value.refs(owner, name).pipe(Effect.provide(repoCache))).pipe(
          Effect.mapError(mapReadError),
        )
        return {
          defaultBranch: listing.defaultBranch,
          head: listing.head,
          branches: listing.branches.map((b) => b.name),
          tags: listing.tags.map((t) => t.name),
        }
      }),

    listIssues: (owner, name, query) =>
      Effect.gen(function* () {
        const cursor = query.cursor === undefined ? undefined : IssueList.decodeCursor(query.cursor)
        if (query.cursor !== undefined && cursor === undefined) {
          return yield* new McpToolError({ code: "invalid_params", message: "Invalid pagination cursor" })
        }
        const found = yield* IssueList.page(repoId(owner, name), {
          state: query.state,
          q: query.q,
          limit: query.limit,
          cursor,
          work: undefined,
        }).pipe(Effect.provide(database), Effect.mapError(mapSqlError("issues_list")))
        return {
          issues: found.issues.map((issue) => ({
            number: issue.number,
            title: issue.title,
            state: issue.state,
            author: issue.author.login,
            comments: issue.comments,
            updatedAt: issue.updated_at,
            triage: issue.triage,
            work: issue.work.status,
          })),
          nextCursor: found.next ?? null,
        }
      }),

    getIssue: (owner, name, number) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const id = repoId(owner, name)
        const [item] = yield* sql<{
          readonly id: string
          readonly number: number
          readonly title: string
          readonly state: string
          readonly author_login: string | null
          readonly body: string
          readonly triage: string
          readonly commitment: string | null
          readonly created_at: string
          readonly updated_at: string
        }>`
          SELECT id, number, title, state, author_login, body, triage, commitment,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
          FROM items
          WHERE repo_id = ${id} AND number = ${number} AND kind = 'issue' AND deleted_at IS NULL`
        if (item === undefined) {
          return yield* new McpToolError({ code: "not_found", message: `Issue #${number} not found` })
        }
        const comments = yield* sql<{
          readonly author_login: string | null
          readonly body: string
          readonly created_at: string
        }>`
          SELECT author_login, body,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
          FROM comments
          WHERE repo_id = ${id} AND item_id = ${item.id} AND deleted_at IS NULL
          ORDER BY created_at ASC, id ASC
          LIMIT 101`
        const labels: Array<string> = []
        if (item.triage === "accepted") labels.push("smithers:accepted")
        else if (item.triage === "not_accepted") labels.push("smithers:not-accepted")
        if (item.commitment !== null) labels.push(`smithers:${item.commitment}`)
        return {
          number: item.number,
          title: item.title,
          state: item.state,
          author: item.author_login,
          body: item.body,
          labels,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          comments: comments.map((c) => ({ author: c.author_login, body: c.body, createdAt: c.created_at })),
        }
      }).pipe(
        Effect.provide(database),
        Effect.mapError((error) => (error instanceof McpToolError ? error : mapSqlError("issue_get")())),
      ),

    listPulls: (owner, name, state = "open") =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const id = repoId(owner, name)
        const rows = yield* sql<{
          readonly number: number
          readonly title: string
          readonly state: string
          readonly author_login: string | null
          readonly head_ref: string
          readonly base_ref: string
          readonly draft: boolean
          readonly updated_at: string
        }>`
          SELECT i.number, i.title, i.state, i.author_login, p.head_ref, p.base_ref, p.draft,
            to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
          FROM pulls p
          JOIN items i ON i.id = p.item_id
          WHERE p.repo_id = ${id} AND i.deleted_at IS NULL
            ${state === "all" ? sql`` : sql`AND i.state = ${state}`}
          ORDER BY i.updated_at DESC, i.number DESC
          LIMIT 50`
        return rows.map((row) => ({
          number: row.number,
          title: row.title,
          state: row.state,
          author: row.author_login,
          head: row.head_ref,
          base: row.base_ref,
          draft: row.draft,
          updatedAt: row.updated_at,
        }))
      }).pipe(Effect.provide(database), Effect.mapError(mapSqlError("pulls_list"))),

    getPull: (owner, name, number) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const id = repoId(owner, name)
        const [pull] = yield* sql<{
          readonly item_id: string
          readonly number: number
          readonly title: string
          readonly state: string
          readonly author_login: string | null
          readonly body: string
          readonly head_ref: string
          readonly head_sha: string
          readonly base_ref: string
          readonly draft: boolean
          readonly updated_at: string
        }>`
          SELECT p.item_id, i.number, i.title, i.state, i.author_login, i.body,
            p.head_ref, p.head_sha, p.base_ref, p.draft,
            to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
          FROM pulls p
          JOIN items i ON i.id = p.item_id
          WHERE p.repo_id = ${id} AND p.number = ${number} AND i.deleted_at IS NULL`
        if (pull === undefined) {
          return yield* new McpToolError({ code: "not_found", message: `Pull request #${number} not found` })
        }
        const reviews = yield* sql<{
          readonly author_login: string | null
          readonly state: string
          readonly body: string
        }>`
          SELECT author_login, state, body
          FROM reviews
          WHERE repo_id = ${id} AND item_id = ${pull.item_id}
          ORDER BY submitted_at ASC NULLS LAST, id ASC
          LIMIT 100`
        const runs = yield* sql<{
          readonly flow: string
          readonly status: string
        }>`
          SELECT flow, status
          FROM runs
          WHERE repo_id = ${id} AND sha = ${pull.head_sha}
          ORDER BY created_at DESC
          LIMIT 50`
        return {
          number: pull.number,
          title: pull.title,
          state: pull.state,
          author: pull.author_login,
          head: pull.head_ref,
          base: pull.base_ref,
          draft: pull.draft,
          updatedAt: pull.updated_at,
          body: pull.body,
          reviews: reviews.map((r) => ({ author: r.author_login, state: r.state, body: r.body })),
          checks: runs.map((r) => ({
            name: r.flow,
            status: r.status,
            conclusion: r.status === "completed" ? "success" : r.status === "failed" ? "failure" : null,
          })),
        }
      }).pipe(
        Effect.provide(database),
        Effect.mapError((error) => (error instanceof McpToolError ? error : mapSqlError("pull_get")())),
      ),

    createIssue: (params) =>
      admitWrite(params.owner, params.name, params.writeId, params.personId, {
        op: "issue/create",
        title: params.title,
        body: stripDuplicateFooter(params.body, params.login),
      }),

    commentIssue: (params) =>
      admitWrite(params.owner, params.name, params.writeId, params.personId, {
        op: "issue/comment",
        number: params.number,
        body: stripDuplicateFooter(params.body, params.login),
      }),

    listTodos: (owner, name) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{
          readonly id: string
          readonly title: string
          readonly state: string
          readonly position: number | null
          readonly number: number
        }>`
          SELECT id::text, title, state, position, number
          FROM todos
          WHERE repo_id = ${repoId(owner, name)}
          ORDER BY position ASC NULLS LAST, number DESC
          LIMIT 100`
        return rows.map((row) => ({
          id: row.id,
          title: row.title,
          state: row.state,
          position: row.position ?? row.number,
          lane: null,
        }))
      }).pipe(Effect.provide(database), Effect.mapError(mapSqlError("todo_list"))),

    draftTodo: () =>
      Effect.sync(() => ({
        id: crypto.randomUUID(),
        state: "draft" as const,
      })),

    postWorkLink: (params) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const written = yield* WorkLinks.write(
          repoId(params.owner, params.name),
          params.number,
          {
            links: [
              {
                kind: params.kind,
                ref: params.ref,
                state: params.status,
                ...(params.url === undefined ? {} : { url: params.url }),
                ...(params.summary === undefined ? {} : { label: params.summary }),
              },
            ],
          },
          params.source,
          now,
        ).pipe(Effect.provide(database), Effect.mapError(mapSqlError("work_link_post")))
        return { recorded: Option.isSome(written) && written.value.changed > 0 }
      }),
    })
  })
