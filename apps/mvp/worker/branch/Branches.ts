import { FlowStarter } from "../Flows.ts"
import * as GitHubConfig from "../github/Config.ts"
import * as GitHubCreation from "./GitHubCreation.ts"
import { Cause, Clock, Effect, type Layer, Metric, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { HttpClient } from "effect/http"
import type { SqlClient } from "effect/sql"
import { isBranchName, MAX_TRACK_BODY_BYTES } from "../../src/features/branch/contract.ts"
import { isRepository, repoId } from "../../src/features/repo/contract.ts"
import { Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import { branchAccess, canView, isMemberOn } from "./Access.ts"
import * as Repos from "../Repos.ts"
import * as Conversations from "./Conversations.ts"
import * as ConversationPeople from "./ConversationPeople.ts"
import { branchHead, createBranch, defaultBranch, failureFields, Forge } from "./Forge.ts"

// `POST /api/branches` (decision 0013 §2, docs/features/branch-workspace.md#tracking-a-branch): the write path of the
// client flows `branch/track`, which a person opening a branch's page and the agent run alike, and `branch/create`,
// which first makes a new branch on the forge from the default branch's head (`create: true`; a repository's home's New
// branch, `/branch.new` and the agent; docs/features/branch-workspace.md#new-branch). Creation targets the mirror's
// ephemeral namespace (decision 0095); tracking existing refs targets the default namespace. It records the branch
// with its conversation, and answers both ids, what the person may do on it and whether its owner
// shared it (`shared`: its prompt is then typed together, docs/features/coedit.md#the-prompt). A branch the app
// tracks already answers at once, to those it is shared with (worker/branch/Access.ts), and 403 to anyone else; a new
// one is read from its forge and namespace first (`Forge`), with the read credential the server holds, so a missing ref
// is never recorded, and becomes the Member's who tracked it, private until they share it. The repository's default
// branch is recorded `locked` (decision 0007 §5), and is the team's. A new branch whose name the forge already has is
// refused 409 `exists`: it is someone else's branch, not one this request made. A new branch may name no repository:
// it is then the deployment's own (`GITHUB_REPOSITORY`), as `/new` makes from the home conversation. Every branch it
// answers is opened by the person: its conversation joins their list, and comes back if they archived it
// (docs/features/conversations.md).

/** `POST /api/branches` requests, by `outcome`: `tracked`, `existing`, or the refusal's code. */
export const tracks = Metric.counter("smithers_branch_tracks", {
  description: "POST /api/branches requests, by outcome",
  incremental: true,
})

const TrackRequest = Schema.Struct({
  /** The repository; both absent, with `create`, the deployment's own. */
  owner: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  ref: Schema.String,
  /** `branch/create`'s: make the branch on the forge, from the default branch's head, before tracking it. */
  create: Schema.optional(Schema.Literal(true)),
  provider: Schema.optional(Schema.Literal("github")),
  /**
   * With `create`, `conversation/new`'s: the request asking for a fresh branch. A branch the app tracks answers only to
   * the request that made it; to any other, it is someone's branch already, refused `exists`.
   */
  request: Schema.optional(Schema.String.check(Schema.isUUID())),
  /**
   * When the person opened the branch, in milliseconds since the epoch, the same each time its step tries again; without
   * one, now. At most a day ahead of the server's clock.
   */
  openedAt: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
}).check(
  Schema.makeFilter((request) =>
    ((request.owner === undefined && request.name === undefined && request.create === true) ||
      (request.owner !== undefined && request.name !== undefined && isRepository(request.owner, request.name))) &&
    isBranchName(request.ref) && (request.request === undefined || request.create === true) && (request.provider === undefined || (request.create === true && request.request !== undefined))
  ),
)
const decodeTrack = Schema.decodeUnknownEffect(Schema.fromJsonString(TrackRequest))

const noStore = { "cache-control": "no-store" }
const refusal = (status: number, code: string) => HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })

type Fields = Record<string, string | number | boolean>

/**
 * The route over `database`, which opens a Postgres client for each request's scope. It reads who is asking from
 * `Sessions` and the branch's forge from `Forge`. Each request is one span `branch.track`, one log line `branch.track`
 * with the repository, the outcome, the status and the duration, and one count; never the branch's name.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, app: Option.Option<GitHubConfig.GitHubApp>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const startedAt = yield* Clock.currentTimeMillis
    const fields: Fields = {}
    let browsing = false
    const answerRefusal = (status: number, code: string) => {
      if (browsing && (status === 403 || status === 404)) {
        fields.outcome = code
        return HttpServerResponse.empty({ status: 204, headers: { ...noStore, "x-branch-state": code } })
      }
      return refusal(status, code)
    }
    const madeBy = (branchId: string) => Conversations.createRequestOf(branchId).pipe(Effect.provide(database))
    const response = yield* Effect.gen(function* () {
      if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
      const actor = yield* (yield* Sessions).resolve
      if (Option.isNone(actor)) return answerRefusal(401, "authentication")
      const body = yield* readBounded(request, MAX_TRACK_BODY_BYTES, (bytes) => (fields.bytes = bytes)).pipe(
        Effect.result,
      )
      if (body._tag === "Failure") return answerRefusal(body.failure.reason === "too_large" ? 413 : 400, "invalid")
      const decoded = yield* decodeTrack(body.success).pipe(Effect.option)
      if (Option.isNone(decoded) || (decoded.value.openedAt ?? 0) > startedAt + 24 * 60 * 60 * 1000) {
        return answerRefusal(400, "invalid")
      }
      browsing = decoded.value.create !== true && new URL(request.url, "http://localhost").searchParams.get("optional") === "true"
      const { ref, request: createRequest, openedAt } = decoded.value
      const home = yield* Conversations.homeRepositoryNames
      const owner = decoded.value.owner ?? home.owner
      const name = decoded.value.name ?? home.name
      const repo = repoId(owner, name)
      fields.repoId = repo
      if (decoded.value.provider === "github") {
        fields.forge = "github"
        const reject = (status: number, code: string) => {
          fields.outcome = code
          return answerRefusal(status, code)
        }
        // A Member or above on the repository itself (decision 0079); GitHub creation checks it again on GitHub.
        if (!(yield* isMemberOn(actor, repo).pipe(Effect.provide(database)))) return reject(403, "forbidden")
        const existing = yield* GitHubCreation.read(createRequest!, actor.value.subject.id).pipe(Effect.provide(database))
        if (existing !== undefined && (existing.repo !== repo || existing.ref !== ref)) return reject(409, "exists")
        const completed = yield* Conversations.createdFor(repo, actor.value.subject.id, createRequest!).pipe(Effect.provide(database))
        if (completed !== undefined) {
          const found = yield* branchAccess(actor, completed.branchId).pipe(Effect.provide(database))
          if (found === undefined || !canView(found.access)) return reject(404, "not_found")
          yield* ConversationPeople.opened(completed.conversationId, actor.value.subject.id, owner, name, completed.name, openedAt).pipe(Effect.provide(database))
          fields.outcome = "tracked"
          return HttpServerResponse.jsonUnsafe({ ...completed, access: found.access, shared: found.shared }, { status: 201, headers: noStore })
        }
        if (existing?.branchId !== undefined && existing.branchId !== null) return reject(404, "not_found")
        if (existing?.failure !== undefined && existing.failure !== null) {
          const code = existing.failure
          fields.outcome = code
          return reject(code === "forbidden" ? 403 : code === "not_found" ? 404 : code === "exists" ? 409 : 503, code)
        }
        if (Option.isNone(app)) return reject(503, "not_configured")
        if (existing === undefined) {
          const from = yield* defaultBranch({ owner, name }).pipe(Effect.result)
          if (from._tag === "Failure" || from.success.branch === undefined) return from._tag === "Failure" && !["not_found", "empty"].includes(from.failure.code)
            ? reject(503, "unavailable") : reject(404, "not_found")
          const admitted = yield* GitHubCreation.admit({ actor: actor.value, repository: { id: repo, owner, name }, ref,
            from: from.success.sha, request: createRequest! }).pipe(Effect.provide(database))
          if (admitted === undefined) return reject(409, "exists")
        }
        const started = yield* (yield* FlowStarter).start(GitHubCreation.Create, {
          executionId: createRequest!, payload: { request: createRequest! },
        }).pipe(Effect.result)
        if (started._tag === "Failure" && started.failure._tag === "@smthrs/mvp/flows/StartConflict") return reject(409, "exists")
        fields.outcome = started._tag === "Failure" ? "unavailable" : "requested"
        return started._tag === "Failure" ? reject(503, "unavailable") : reject(202, "requested")
      }
      const known = yield* Conversations.find(repo, ref).pipe(Effect.provide(database))
      if (known !== undefined) {
        const found = yield* branchAccess(actor, known.branchId).pipe(Effect.provide(database))
        if (found === undefined) return answerRefusal(404, "not_found")
        if (!canView(found.access)) return answerRefusal(403, "forbidden")
        if (createRequest !== undefined && (yield* madeBy(known.branchId)) !== createRequest) {
          fields.outcome = "exists"
          return answerRefusal(409, "exists")
        }
        yield* ConversationPeople.opened(known.conversationId, actor.value.subject.id, owner, name, ref, openedAt).pipe(
          Effect.provide(database),
        )
        fields.outcome = "existing"
        fields.access = found.access
        return HttpServerResponse.jsonUnsafe({ ...known, access: found.access, shared: found.shared }, { headers: noStore })
      }
      // Tracking a branch makes it the tracker's: only a Member or above may (`repo:branch-create`, decision 0007), by
      // their role on the repository itself (decision 0079).
      if (!(yield* isMemberOn(actor, repo).pipe(Effect.provide(database)))) return answerRefusal(403, "forbidden")
      let resolvedDefault: string | undefined
      if (decoded.value.create === true) {
        // A new branch: made on the forge at the default branch's head, then tracked as any other. A name the forge
        // already has is someone's branch, not this request's: 409 `exists`, and nothing is tracked. A branch name
        // carries no mark of who made it, so its existence is never read as our own create
        // (docs/proposals/durable-external-effects.md). A retry after a lost answer finds the branch tracked above.
        const from = yield* defaultBranch({ owner, name }).pipe(Effect.result)
        if (from._tag === "Failure" || from.success.branch === undefined) {
          if (from._tag === "Failure") Object.assign(fields, failureFields("default_branch", from.failure))
          fields.forge = from._tag === "Failure" ? from.failure.code : "no_default_branch"
          return from._tag === "Failure" && from.failure.code !== "not_found" && from.failure.code !== "empty"
            ? answerRefusal(503, "unavailable")
            : answerRefusal(404, "not_found")
        }
        resolvedDefault = from.success.branch
        if (ref === resolvedDefault) {
          fields.created = "exists"
          fields.outcome = "exists"
          return answerRefusal(409, "exists")
        }
        // App identity is repository + name, so a private ephemeral ref cannot claim an ordinary ref's URL.
        const ordinary = yield* branchHead({ owner, name }, ref).pipe(Effect.result)
        if (ordinary._tag === "Success") {
          fields.created = "exists"
          fields.outcome = "exists"
          return answerRefusal(409, "exists")
        }
        if (ordinary.failure.code !== "ref_not_found") {
          Object.assign(fields, failureFields("refs_read", ordinary.failure))
          fields.outcome = "unavailable"
          return answerRefusal(503, "unavailable")
        }
        const made = yield* createBranch({ owner, name }, ref, from.success.branch).pipe(Effect.result)
        fields.created = made._tag === "Success" ? "created" : made.failure.code
        if (made._tag === "Failure") {
          Object.assign(fields, failureFields("create_ref", made.failure))
          if (made.failure.code === "exists") {
            fields.outcome = "exists"
            return answerRefusal(409, "exists")
          }
          return made.failure.code === "forbidden"
            ? answerRefusal(403, "forbidden")
            : made.failure.code === "not_found"
            ? answerRefusal(404, "not_found")
            : made.failure.code === "not_configured"
            ? answerRefusal(503, "not_configured")
            : answerRefusal(503, "unavailable")
        }
      }
      const namespace = decoded.value.create === true ? "ephemeral" : "default"
      const readHead = branchHead({ owner, name }, ref, namespace)
      const head = yield* readHead.pipe(Effect.result)
      if (head._tag === "Failure") {
        Object.assign(fields, failureFields("refs_read", head.failure))
        const code = head.failure.code
        fields.forge = code
        return code === "not_found" || code === "ref_not_found" || code === "empty"
          ? answerRefusal(404, "not_found")
          : answerRefusal(503, "unavailable")
      }
      if (resolvedDefault === undefined) {
        const remoteDefault = yield* defaultBranch({ owner, name }).pipe(Effect.result)
        if (remoteDefault._tag === "Failure" || remoteDefault.success.branch === undefined) {
          if (remoteDefault._tag === "Failure") Object.assign(fields, failureFields("default_branch", remoteDefault.failure))
          fields.forge = remoteDefault._tag === "Failure" ? remoteDefault.failure.code : "no_default_branch"
          return answerRefusal(503, "unavailable")
        }
        resolvedDefault = remoteDefault.success.branch
      }
      const mode = decoded.value.create !== true && resolvedDefault === ref ? "locked" : "open"
      const tracked = yield* Conversations.track(repo, ref, mode, head.success, actor.value.subject.id, createRequest, namespace, "deployment")
        .pipe(Effect.provide(database))
      // Devices may discover private refs only after their branch and conversation have been persisted.
      if (decoded.value.create === true && tracked.created) yield* Repos.refsChanged(repo).pipe(Effect.provide(database))
      // Two people tracking one new branch at once: the one whose insert won owns it; the other may not see it.
      const found = yield* branchAccess(actor, tracked.branch.branchId).pipe(Effect.provide(database))
      if (found === undefined) return answerRefusal(404, "not_found")
      if (!canView(found.access)) return answerRefusal(403, "forbidden")
      yield* ConversationPeople.opened(tracked.branch.conversationId, actor.value.subject.id, owner, name, ref, openedAt)
        .pipe(Effect.provide(database))
      fields.outcome = tracked.created ? "tracked" : "existing"
      fields.mode = mode
      fields.access = found.access
      return HttpServerResponse.jsonUnsafe(
        { ...tracked.branch, access: found.access, shared: found.shared },
        { status: tracked.created ? 201 : 200, headers: noStore },
      )
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          fields.errorCode = codeOf(Cause.squash(cause))
          return answerRefusal(503, "unavailable")
        })
      ),
    )
    fields.status = response.status
    fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
    const outcome = String(fields.outcome ?? (response.status === 405 ? "method" : codeFor(response.status)))
    yield* Metric.update(Metric.withAttributes(tracks, { outcome }), 1)
    yield* Effect.annotateCurrentSpan({ ...fields, "http.response.status_code": response.status, outcome })
    yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
      "branch.track",
    ).pipe(Effect.annotateLogs({ ...fields, outcome }))
    return response
  }).pipe(Effect.withSpan("branch.track", { kind: "server" }))

/** A refusal's outcome by its status. */
const codeFor = (status: number) =>
  status === 401
    ? "authentication"
    : status === 403
    ? "forbidden"
    : status === 404
    ? "not_found"
    : status === 400 || status === 413
    ? "invalid"
    : "unavailable"

/** What the route needs from its host beyond Postgres: who is asking, the forge, and an HTTP client to reach it. */
export type Requirements = Sessions | FlowStarter | Forge | HttpClient.HttpClient | HttpServerRequest.HttpServerRequest
