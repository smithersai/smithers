import type { BranchRoles } from "./branch/Access.ts"
import * as MirrorRefresh from "./MirrorRefresh.ts"
import * as RefReads from "./branch/RefReads.ts"
import { ImmutableCache } from "@smthrs/artifacts"
import type { CodeStorage } from "@smthrs/effect-code-storage"
import { ShapeProxy } from "@smthrs/effect-electric"
import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { type HttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../src/features/chat/contract.ts"
import {
  cloneExecutionId,
  isFilePath,
  isRepository,
  MAX_REQUEST_BYTES,
  type Refusal,
  repoId,
  LAUNCH_ROUTE,
  REPOS_ROUTE,
  REPOSITORIES_SHAPE_ROUTE,
  REPOSITORIES_TABLE,
  SHA_PATTERN,
  textOf,
} from "../src/features/repo/contract.ts"
import { canClone, Sessions } from "./Actor.ts"
import { readBounded } from "./Body.ts"
import { codeOf } from "./ErrorCode.ts"
import { FlowStarter } from "./Flows.ts"
import { Clone } from "./flows/RepoClone.ts"
import * as AboutStore from "./about/Store.ts"
import * as RepoAbout from "./RepoAbout.ts"
import * as RepoMetrics from "./RepoMetrics.ts"
import * as RepoReads from "./RepoReads.ts"
import * as Repos from "./Repos.ts"

// RepoApi (decision 0006 §1, docs/features/repo.md#repoapi): asking for a clone, the `repositories` shape, reading a
// cloned repository at a commit, and listing its branches and tags. ChatApi routes `/api/repos/*` and
// `/api/shapes/repositories` here. Who is asking comes
// from `Sessions`, where a clone runs from `FlowStarter` (a Durable Object in ChatApi), and the immutable cache from
// `ImmutableCache` (the Workers Cache API in ChatApi): all three are in context per request.
//
// Reading is open to everyone; cloning needs sign-in (decision 0008, "Sign-in is needed to: import") and the Member role
// or above (decision 0007), because a clone spends the deployment's Code Storage budget. Every input is bounded: the
// body, the owner and name, the SHA and the path.

const noStore = { "cache-control": "no-store" }
const immutable = { "cache-control": "public, max-age=31536000, immutable" }
/** A raw file is shown as plain text, never sniffed, and runs nothing even if a browser would render it. */
const rawHeaders = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" }

/** A refusal: its status, `{ code }` and any extra fields, never cached. */
const refuse = (status: number, code: Refusal, extra: Record<string, number> = {}, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe({ code, ...extra }, { status, headers: { ...noStore, ...headers } })

const encoder = new TextEncoder()

const CloneBody = Schema.fromJsonString(Schema.Struct({ owner: Schema.String, name: Schema.String }))
const decodeCloneBody = Schema.decodeUnknownOption(CloneBody)
const LaunchBody = Schema.fromJsonString(Schema.Struct({ owner: Schema.String, name: Schema.String, cloneId: Schema.String }))
const decodeLaunchBody = Schema.decodeUnknownOption(LaunchBody)

/** What a read route reads: a tree, a file's bytes (`blob`), a file as a page shows it (`raw`), or the refs. */
type ReadKind = "tree" | "blob" | "raw" | "refs"
const READ_KINDS: ReadonlySet<string> = new Set<ReadKind>(["tree", "blob", "raw", "refs"])

/**
 * A `/api/repos/<owner>/<name>/{tree,blob,raw}/<sha>[/<path>]` or `/api/repos/<owner>/<name>/refs` request, decoded, or
 * `undefined` for any other path. `extra` counts segments the kind doesn't take: a tree's after its SHA, any after refs.
 */
const parseRead = (path: string) => {
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  const [rawOwner, rawName, rawKind, sha, ...rest] = segments
  if (rawKind === undefined || !READ_KINDS.has(rawKind)) return undefined
  const kind = rawKind as ReadKind
  try {
    const owner = decodeURIComponent(rawOwner!)
    const name = decodeURIComponent(rawName!)
    const file = rest.map(decodeURIComponent).join("/")
    const extra = kind === "refs" ? segments.length - 3 : kind === "tree" ? rest.length : 0
    return { owner, name, kind, sha: sha ?? "", file, extra }
  } catch {
    return undefined
  }
}

/** `/api/repos/<owner>/<name>/about`, decoded, or `undefined` for any other path. */
const parseAbout = (path: string) => {
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  if (segments.length !== 3 || segments[2] !== "about") return undefined
  try {
    return { owner: decodeURIComponent(segments[0]!), name: decodeURIComponent(segments[1]!) }
  } catch {
    return undefined
  }
}

/** A raw file's type: text as UTF-8 plain text, anything else as bytes to save. */
const rawType = (bytes: Uint8Array): string =>
  textOf(bytes) === undefined ? "application/octet-stream" : "text/plain; charset=utf-8"

/** What RepoApi needs besides its database: the Code Storage client, when this deployment has an organization. */
export interface Options {
  readonly codeStorage: Option.Option<CodeStorage.Client>
}

/**
 * Reads the budgets and Electric's connection (`Repos.budgets`, `RepoReads.maxTreePaths`, `ShapeProxy.config`) and
 * returns RepoApi's `fetch` handler, and the reads it answers with, for the agent's flows on this host.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, options: Options) =>
  Effect.gen(function* () {
    const budgets = yield* Repos.budgets
    const aboutSource = yield* RepoAbout.make(yield* RepoAbout.settings, AboutStore.postgres(database), database)
    const maxTreePaths = yield* RepoReads.maxTreePaths
    const maxRefs = yield* RepoReads.maxRefs
    const reads = Option.map(
      options.codeStorage,
      (codeStorage) => RepoReads.make({ codeStorage, database, budgets, maxTreePaths, maxRefs }),
    )
    // GET /api/shapes/repositories: Electric's `repositories`, whole, with no subset requests.
    const shape = ShapeProxy.make({
      ...(yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })),
      shape: { table: REPOSITORIES_TABLE },
      name: "repo.shape",
      metric: RepoMetrics.shapes,
    })

    /**
     * Starts the clone a row asks for and answers whether it did. Its execution id names the attempt's own id, so
     * starting it again changes nothing. That id never repeats, so another payload under it (`StartConflict`) is a
     * bug: the attempt settles `failed` `unavailable`, which shows Try again, rather than staying `cloning` with no
     * execution to finish it.
     */
    const start = (id: string, clone: Repos.Clone) =>
      Effect.flatMap(FlowStarter, (starter) =>
        starter.start(Clone, {
          executionId: cloneExecutionId(id, clone.cloneId),
          payload: { id, owner: clone.owner, name: clone.name, cloneId: clone.cloneId, requestedAt: clone.requestedAt },
        })).pipe(
          Effect.as(true),
          Effect.catchTag("@smthrs/mvp/flows/StartConflict", () =>
            Repos.settle({ id, cloneId: clone.cloneId }, { status: "failed", failure: "unavailable" }, budgets).pipe(
              Effect.provide(database),
              Effect.as(false),
            )),
        )

    const clone = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const startedAt = yield* Clock.currentTimeMillis
      const fields: Record<string, string | number> = {}
      /** A refusal, recorded as the request's outcome: the refusal's code unless `outcome` says otherwise. */
      const refused = (status: number, code: Refusal, outcome: string = code) => {
        fields.outcome = outcome
        return refuse(status, code)
      }
      const response = yield* Effect.gen(function* () {
        if (request.method !== "POST") {
          fields.outcome = "method"
          return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        }
        const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
        if (Option.isNone(actor)) return refused(503, "unavailable")
        if (Option.isNone(actor.value)) return refused(401, "authentication")
        if (!canClone(actor.value.value)) return refused(403, "forbidden")
        if (Option.isNone(options.codeStorage)) return refused(503, "not_configured")
        const text = yield* readBounded(request, MAX_REQUEST_BYTES).pipe(Effect.result)
        if (text._tag === "Failure") {
          return text.failure.reason === "too_large" ? refused(413, "too_large") : refused(400, "invalid")
        }
        const body = decodeCloneBody(text.success)
        if (Option.isNone(body) || !isRepository(body.value.owner, body.value.name)) return refused(400, "invalid")
        const id = repoId(body.value.owner, body.value.name)
        fields.id = id
        yield* Effect.annotateCurrentSpan({ "smithers.repo.id": id })
        const requested = yield* Repos.request({ id, ...body.value }, budgets, actor.value.value.subject.id).pipe(
          Effect.provide(database),
        )
        if (requested.kind === "limit") return refused(429, "repository_limit")
        fields.attempt = requested.attempt
        fields.cloneId = requested.cloneId
        // The request is persisted: it answers now, and the asker's `repo/clone` launches it (`launch`, below).
        if (requested.kind === "existing") {
          if (requested.status === "ready") yield* MirrorRefresh.request(body.value.owner, body.value.name)
          fields.outcome = "existing"
          fields.row = requested.status
          return HttpServerResponse.jsonUnsafe(
            { txid: null, id, status: requested.status, cloneId: requested.cloneId },
            { status: 200, headers: noStore },
          )
        }
        fields.outcome = "requested"
        return HttpServerResponse.jsonUnsafe(
          { txid: requested.txid, id, attempt: requested.attempt, cloneId: requested.cloneId },
          { status: 202, headers: noStore },
        )
      }).pipe(
        // Postgres couldn't be reached: nothing was persisted, and the asker asks again.
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            fields.errorCode = codeOf(Cause.squash(cause))
            return refused(503, "unavailable")
          })
        ),
      )
      const outcome = String(fields.outcome)
      yield* Metric.update(Metric.withAttributes(RepoMetrics.cloneRequests, { outcome }), 1)
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        "repo.clone.request",
      ).pipe(
        Effect.annotateLogs({
          ...fields,
          outcome,
          status: response.status,
          durationMs: (yield* Clock.currentTimeMillis) - startedAt,
        }),
      )
      return response
    }).pipe(Effect.withSpan("repo.clone.request", { kind: "server" }))

    /**
     * `POST /api/repos/launch` `{ owner, name, cloneId }`: starts the durable remote `repo/Clone` for the attempt a
     * request persisted, the asker's `repo/clone`'s second step, which its engine retries until it lands. `202
     * { launched: true }` when the attempt is the row's and still `cloning`: started, or started already, since its
     * execution id is the attempt's own. `200 { launched: false, status }` for an attempt the row no longer holds or one
     * that settled. A start another payload holds (a bug: attempt ids never repeat) settles the attempt `failed`
     * `unavailable` and answers `200 { launched: false, status: "failed" }`; a Durable Object that can't be reached is
     * `503`, which the step tries again.
     */
    const launch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const startedAt = yield* Clock.currentTimeMillis
      const fields: Record<string, string | number> = {}
      const refused = (status: number, code: Refusal, outcome: string = code) => {
        fields.outcome = outcome
        return refuse(status, code)
      }
      const response = yield* Effect.gen(function* () {
        if (request.method !== "POST") {
          fields.outcome = "method"
          return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        }
        const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
        if (Option.isNone(actor)) return refused(503, "unavailable")
        if (Option.isNone(actor.value)) return refused(401, "authentication")
        if (!canClone(actor.value.value)) return refused(403, "forbidden")
        const text = yield* readBounded(request, MAX_REQUEST_BYTES).pipe(Effect.result)
        if (text._tag === "Failure") {
          return text.failure.reason === "too_large" ? refused(413, "too_large") : refused(400, "invalid")
        }
        const body = decodeLaunchBody(text.success)
        if (Option.isNone(body) || !isRepository(body.value.owner, body.value.name)) return refused(400, "invalid")
        const id = repoId(body.value.owner, body.value.name)
        fields.id = id
        fields.cloneId = body.value.cloneId
        const row = yield* Repos.current(id).pipe(Effect.provide(database))
        if (Option.isNone(row)) {
          return Option.isNone(options.codeStorage) ? refused(503, "not_configured") : refused(404, "not_found")
        }
        if (row.value.cloneId !== body.value.cloneId || row.value.status !== "cloning") {
          fields.outcome = "settled"
          fields.row = row.value.status
          return HttpServerResponse.jsonUnsafe({ launched: false, status: row.value.status }, { status: 200, headers: noStore })
        }
        fields.attempt = row.value.attempt
        // A persisted request must settle when launch is refused permanently. The browser's launch step
        // does not retry not_configured, so no execution will ever reach repo/Settle for this attempt.
        if (Option.isNone(options.codeStorage)) {
          yield* Repos.settle({ id, cloneId: row.value.cloneId }, { status: "failed", failure: "unavailable" }, budgets).pipe(
            Effect.provide(database),
          )
          return refused(503, "not_configured")
        }
        if (!(yield* start(id, row.value))) {
          fields.outcome = "conflict"
          fields.errorCode = "conflict"
          return HttpServerResponse.jsonUnsafe({ launched: false, status: "failed" }, { status: 200, headers: noStore })
        }
        fields.outcome = "launched"
        return HttpServerResponse.jsonUnsafe({ launched: true }, { status: 202, headers: noStore })
      }).pipe(
        // Postgres or the Durable Object couldn't be reached: the row still says `cloning`, and the step tries again.
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            fields.errorCode = codeOf(Cause.squash(cause))
            return refused(503, "unavailable")
          })
        ),
      )
      const outcome = String(fields.outcome)
      yield* Metric.update(Metric.withAttributes(RepoMetrics.cloneLaunches, { outcome }), 1)
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
      yield* Effect.logWithLevel(
        response.status >= 500 || outcome === "conflict" ? "Error" : response.status >= 400 ? "Warn" : "Info",
      )("repo.clone.launch").pipe(
        Effect.annotateLogs({ ...fields, outcome, status: response.status, durationMs: (yield* Clock.currentTimeMillis) - startedAt }),
      )
      return response
    }).pipe(Effect.withSpan("repo.clone.launch", { kind: "server" }))

    /**
     * A tree, file or refs read: validated, answered from the cache or Code Storage, and recorded. The refs answer
     * follows the row's head, so it is never kept by a browser; everything read at a SHA is kept forever.
     */
    const read = (path: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const target = parseRead(path)
        const kind = target?.kind ?? "tree"
        const fields: Record<string, string | number> = {}
        const response = yield* Effect.gen(function* () {
          if (target === undefined || !isRepository(target.owner, target.name) || target.extra > 0) {
            return refuse(404, "not_found")
          }
          if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
          if (target.kind !== "refs" && !SHA_PATTERN.test(target.sha)) return refuse(400, "invalid")
          if ((target.kind === "blob" || target.kind === "raw") && !isFilePath(target.file)) return refuse(400, "invalid")
          fields.repoId = repoId(target.owner, target.name)
          if (target.kind !== "refs") fields.sha = target.sha
          if (Option.isNone(reads)) return refuse(503, "not_configured")
          const answered = target.kind === "refs"
            ? Effect.gen(function* () {
              const names = yield* Effect.gen(function* () {
                const actor = yield* (yield* Sessions).resolve
                return yield* RefReads.visible(repoId(target.owner, target.name), actor).pipe(Effect.provide(database))
              }).pipe(Effect.mapError(() => new RepoReads.ReadRefused({ code: "unavailable" })))
              const refs = yield* reads.value.refs(target.owner, target.name, names)
              yield* MirrorRefresh.request(target.owner, target.name).pipe(Effect.catch(() => Effect.void))
              return refs
            }).pipe(
              Effect.map((refs) => {
                const bytes = encoder.encode(JSON.stringify(refs))
                fields.bytes = bytes.length
                return HttpServerResponse.uint8Array(bytes, {
                  headers: { "cache-control": "private, no-store" },
                  contentType: "application/json",
                })
              }),
            )
            : target.kind === "tree"
            ? reads.value.tree(target.owner, target.name, target.sha).pipe(
              Effect.map((bytes) => {
                fields.bytes = bytes.length
                return HttpServerResponse.uint8Array(bytes, { headers: immutable, contentType: "application/json" })
              }),
            )
            : reads.value.blob(target.owner, target.name, target.sha, target.file).pipe(
              Effect.catchTag("ReadRefused", (error) =>
                target.kind === "blob" && new URL(request.url, "http://localhost").searchParams.get("optional") === "true" && error.code === "not_found"
                  // A missing repository or unreadable commit remains an error. Only a file's absence is normal.
                  ? reads.value.tree(target.owner, target.name, target.sha).pipe(Effect.as(null))
                  : Effect.fail(error)),
              Effect.map((file) => {
                if (file === null) return HttpServerResponse.empty({ status: 204, headers: immutable })
                const { bytes, metadata } = file
                fields.bytes = bytes.length
                return HttpServerResponse.uint8Array(bytes, {
                  headers: {
                    ...immutable,
                    ...(target.kind === "raw" ? rawHeaders : {}),
                    ...(metadata.blobSha === undefined ? {} : { "x-blob-sha": metadata.blobSha }),
                  },
                  contentType: target.kind === "raw" ? rawType(bytes) : "application/octet-stream",
                })
              }),
            )
          return yield* answered.pipe(
            Effect.catchTag("ReadRefused", (refused) => {
              fields.errorCode = refused.code
              switch (refused.code) {
                case "not_synced":
                  return MirrorRefresh.request(target.owner, target.name).pipe(
                    Effect.as(refuse(503, "not_synced", {}, { "retry-after": "2" })),
                    Effect.catch(() => Effect.succeed(refuse(503, "not_synced", {}, { "retry-after": "2" }))),
                  )
                case "not_imported":
                  return Effect.succeed(HttpServerResponse.empty({
                    status: 204,
                    headers: { "cache-control": "private, no-store", "x-repo-state": "not_imported" },
                  }))
                case "not_found":
                  return Effect.succeed(refuse(404, "not_found"))
                case "too_large":
                  return Effect.succeed(refuse(413, "too_large", refused.size === undefined ? {} : { size: refused.size }))
                case "capacity":
                  return Effect.succeed(refuse(503, "capacity"))
                case "unavailable":
                  return Effect.succeed(
                    refuse(
                      503,
                      "unavailable",
                      {},
                      refused.retryAfterMillis === undefined
                        ? {}
                        : { "retry-after": String(Math.max(1, Math.ceil(refused.retryAfterMillis / 1000))) },
                    ),
                  )
              }
            }),
          )
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(defect)
              return refuse(503, "unavailable")
            })
          ),
        )
        const bytes = Number(fields.bytes ?? 0)
        yield* RepoReads.counted(kind, response.status, bytes)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, "smithers.repo.bytes": bytes })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          `repo.${kind}`,
        ).pipe(
          Effect.annotateLogs({
            ...fields,
            status: response.status,
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          }),
        )
        return response
      }).pipe(Effect.withSpan(`repo.${parseRead(path)?.kind ?? "tree"}`, { kind: "server" }))

    /**
     * `GET /api/repos/<owner>/<name>/about`: what GitHub says of a repository, cloned or not, through the about read
     * (worker/RepoAbout.ts): kept in Postgres for every data center, read from GitHub with the App's token where it is
     * installed, and answered stale while GitHub can't answer. Open to everyone, like the other reads; the browser keeps
     * a fresh answer until it goes stale. GitHub's refusals say what is true (GH-4): `404 not_found`, `503 rate_limited`
     * or `503 github_unavailable`, with `Retry-After` when there is a wait; `503 unavailable` with `Retry-After: 1` while
     * another data center reads it for the first time.
     */
    const about = (target: { readonly owner: string; readonly name: string }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Record<string, string | number> = {}
        const response = yield* Effect.gen(function* () {
          if (!isRepository(target.owner, target.name)) return refuse(404, "not_found")
          if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
          fields.repoId = repoId(target.owner, target.name)
          // Whether the asker is a Member or above: asked only when a read must choose the deployment's token.
          const sessions = yield* Effect.context<Sessions | HttpServerRequest.HttpServerRequest>()
          const member = Effect.gen(function* () {
            const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
            return Option.isSome(actor) && Option.isSome(actor.value) && canClone(actor.value.value)
          }).pipe(Effect.provideContext(sessions))
          const outcome = yield* aboutSource.answer(target.owner, target.name, member)
          Object.assign(fields, RepoAbout.fieldsOf(outcome))
          yield* Metric.update(Metric.withAttributes(RepoMetrics.aboutAnswers, { cache: outcome.cache }), 1)
          if (outcome._tag === "Answered") {
            const bytes = encoder.encode(outcome.text)
            fields.bytes = bytes.length
            return HttpServerResponse.uint8Array(bytes, {
              headers: { "cache-control": `public, max-age=${outcome.maxAgeSeconds}` },
              contentType: "application/json",
            })
          }
          fields.errorCode = outcome.code
          const wait: Record<string, string> = outcome.retryAfterMillis === undefined
            ? {}
            : { "retry-after": String(Math.max(1, Math.ceil(outcome.retryAfterMillis / 1000))) }
          return outcome.code === "not_found" ? refuse(404, "not_found") : refuse(503, outcome.code, {}, wait)
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(defect)
              return refuse(503, "unavailable")
            })
          ),
        )
        yield* RepoReads.counted("about", response.status, Number(fields.bytes ?? 0))
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          "repo.about",
        ).pipe(
          Effect.annotateLogs({ ...fields, status: response.status, durationMs: (yield* Clock.currentTimeMillis) - startedAt }),
        )
        return response
      }).pipe(Effect.withSpan("repo.about", { kind: "server" }))

    const fetch: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      | HttpServerRequest.HttpServerRequest
      | HttpClient.HttpClient
      | Sessions
      | FlowStarter
      | ImmutableCache.ImmutableCache
      | BranchRoles
      | R
    > = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = request.url.split("?")[0]!
      if (path === REPOSITORIES_SHAPE_ROUTE) return yield* shape
      if (path === REPOS_ROUTE) return yield* clone
      if (path === LAUNCH_ROUTE) return yield* launch
      const aboutTarget = parseAbout(path)
      if (aboutTarget !== undefined) return yield* about(aboutTarget)
      if (path.startsWith(`${REPOS_ROUTE}/`)) return yield* read(path)
      return HttpServerResponse.empty({ status: 404 })
    })

    return { fetch, reads, about: aboutSource }
  })
