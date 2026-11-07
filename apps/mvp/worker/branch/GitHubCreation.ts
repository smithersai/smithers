import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Core, GitHub } from "@smthrs/integrations"
import { Context, Effect, Layer, Metric, Option, Schema, type Redacted } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import type { Actor } from "../Actor.vibe"
import { classify, statusOf, withToken } from "#vibelang/emitted/worker/github/Calls"
import * as Config from "#vibelang/emitted/worker/github/Config"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as Conversations from "./Conversations.ts"
import * as Repos from "../Repos.ts"
import { CreateRefused } from "#vibelang/emitted/worker/branch/CreateRefused"

/** Explicit, repository-selected GitHub creation; never used by the default branch flow. */
export interface Input {
  readonly actor: Actor
  readonly repository: Config.Repository
  readonly ref: string
  readonly from: string
  /** Caller-owned durable receipt identity; GitHub does not accept an idempotency key for creating refs. */
  readonly request: string
}
export const creations = Metric.counter("smithers_branch_github_creations", { incremental: true })
const refused = (error: Core.IntegrationError.IntegrationError | CreateRefused): CreateRefused => {
  if (error instanceof CreateRefused) return error
  const status = statusOf(error)
  const classification = classify(error)
  return new CreateRefused({
    code: status === 422 || status === 409 ? "exists" : status === 404 ? "not_found" : status === 401 || status === 403 ? "forbidden" : "unavailable",
    errorTag: "GitHubCreation",
    errorCode: classification.kind === "unknown" || (error.reason === "decode-failed" && error.details?.["method"] === "POST") ? "outcome_unknown" : error.reason,
    ...(status === undefined ? {} : { errorStatus: status }),
  })
}

/** The SDK client performs one write. A conflict never adopts a pre-existing ref; recovery finds the marker before another write. */
export const make = <R, H, P>(services: {
  readonly app: Pick<GitHub.AppAuth.AppAuth, "installation" | "installationToken">
  readonly roles: RepoRoles.RepoRoles<R>
  readonly hold: (held: RepoRoles.Held) => Effect.Effect<boolean, CreateRefused, H>
  readonly authorize: (input: Input, token: Redacted.Redacted<string>) => Effect.Effect<boolean, CreateRefused, P>
  readonly http: HttpClient.HttpClient
  readonly apiBaseUrl: string
}) => (input: Input) => Effect.gen(function* () {
  const resolved = yield* services.roles.resolve(input.actor, input.repository).pipe(Effect.mapError((error) =>
    new CreateRefused({ code: error.code === "not_found" || error.code === "app_not_installed" ? "not_found" : error.code === "not_configured" ? "not_configured" : "unavailable" })))
  if (resolved.role === null || !["member", "maintainer", "admin"].includes(resolved.role)) {
    return yield* new CreateRefused({ code: "forbidden" })
  }
  if (Option.isSome(resolved.held) && !(yield* services.hold(resolved.held.value))) {
    return yield* new CreateRefused({ code: "forbidden" })
  }
  const installation = yield* services.app.installation(input.repository.owner, input.repository.name).pipe(Effect.mapError(refused))
  const minted = yield* services.app.installationToken({
    installationId: installation.id, repositories: [input.repository.name], permissions: { contents: "write" },
  }).pipe(Effect.mapError(refused))
  const keyed = GitHub.Once.branch(input.repository.owner, input.repository.name, {
    prefix: "smithers/", label: input.ref.replaceAll("/", "-").slice(0, 160), at: Effect.succeed(input.from),
  })
  const authorized = Action.keyed({
    find: (key) => keyed.find(key).pipe(withToken(minted.token, services.apiBaseUrl)),
    perform: (key) => Effect.gen(function* () {
      if (!(yield* services.authorize(input, minted.token))) return yield* new CreateRefused({ code: "forbidden" })
      return yield* keyed.perform(key).pipe(withToken(minted.token, services.apiBaseUrl))
    }),
  })
  const branch = yield* Action.once("branch", authorized).pipe(
    withToken(minted.token, services.apiBaseUrl),
    Effect.provideService(HttpClient.HttpClient, services.http),
    Effect.mapError(refused),
  )
  return { name: branch.name, sha: branch.sha, namespace: "default" as const, forge: "github" as const }
}).pipe(
  Effect.tap(() => Effect.andThen(Metric.update(Metric.withAttributes(creations, { outcome: "created" }), 1), Effect.logInfo("branch.github.create"))),
  Effect.tapError((error) => Effect.andThen(Metric.update(Metric.withAttributes(creations, { outcome: error.code }), 1), Effect.logWarning("branch.github.create").pipe(Effect.annotateLogs({ outcome: error.code, errorCode: error.errorCode ?? error.code })))),
  Effect.withSpan("branch.github.create"),
)

const unavailable = (error: unknown): CreateRefused => error instanceof CreateRefused ? error : new CreateRefused({ code: "unavailable" })

/** Deployment choices captured before constructing handlers or durable step implementations. */
export const settings = Effect.gen(function* () {
  return { app: yield* Config.configured, allowed: yield* RepoRoles.allowed }
})
export class Settings extends Context.Service<Settings, {
  readonly app: Option.Option<Config.GitHubApp>
  readonly allowed: Option.Option<ReadonlySet<string>>
}>()("smithers/branch/GitHubCreation/Settings") {}

/** Build provider services from injected deployment choices on the remote action host. */
export const configured = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, http: HttpClient.HttpClient) => Effect.gen(function* () {
  const { app, allowed } = yield* Settings
  if (Option.isNone(app)) return yield* new CreateRefused({ code: "not_configured" })
  const auth = yield* GitHub.AppAuth.make(app.value).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.mapError(refused))
  const roles = yield* RepoRoles.make(database, {
    repository: app.value.repository, app, allowed, http,
  })
  const apiBaseUrl = app.value.apiBaseUrl
  const authorize = (input: Input, token: Redacted.Redacted<string>) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [person] = yield* sql<{ readonly login: string; readonly accountId: string }>`
      SELECT github_login AS login, github_id::text AS "accountId" FROM people WHERE id = ${input.actor.subject.id}`
    if (person === undefined) return false
    const permission = yield* GitHub.Collaborators.permission(input.repository.owner, input.repository.name, person.login).pipe(
      withToken(token, apiBaseUrl), Effect.provideService(HttpClient.HttpClient, http), Effect.mapError(refused),
    )
    return Option.isSome(permission) && permission.value.userId !== undefined && String(permission.value.userId) === person.accountId &&
      ["write", "maintain", "admin"].includes(RepoRoles.permissionOf(permission.value))
  }).pipe(Effect.mapError(unavailable))
  return { app: auth, http, apiBaseUrl, roles, authorize, hold: (held: RepoRoles.Held) => RepoRoles.holds(held).pipe(Effect.mapError(unavailable)) }
})

export class CreationUnavailable extends Schema.TaggedError<CreationUnavailable>()("GitHubCreationUnavailable", {}) {}
export const Outcome = Schema.Struct({ status: Schema.Literals(["done", "failed"]) })
export const Send = Action.make("branch/GitHubCreate/send", {
  payload: { request: Schema.String.check(Schema.isUUID()) }, success: Outcome, error: CreationUnavailable,
  implementationVersion: "branch/github-create/v1",
  tier: "irreversible", idempotencyKey: ({ request }) => ({ request }),
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 }),
})
export const Create = Flow.make("branch/GitHubCreate", {
  description: "Create one explicitly requested GitHub branch and persist its conversation.",
  capabilities: ["repo:branch-create"], modelInvocable: false,
  payload: { request: Schema.String.check(Schema.isUUID()) }, success: Outcome, error: CreationUnavailable,
  body: Node.capture({ send: Send.name }, (payload) => Send.call(payload)),
})

export interface RequestRow {
  readonly id: string
  readonly actor: Actor
  readonly repo: string
  readonly owner: string
  readonly name: string
  readonly ref: string
  readonly sha: string
  readonly failure: "exists" | "not_found" | "not_configured" | "forbidden" | null
  readonly branchId: string | null
}

export const read = (request: string, person: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<RequestRow>`SELECT id, actor, repo_id AS repo, owner, name, ref, sha, failure, branch_id AS "branchId"
    FROM github_branch_requests WHERE id = ${request} AND person_id = ${person}`
  return row
})

export const admit = (input: Input) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO github_branch_requests (id, person_id, actor, repo_id, owner, name, ref, sha)
    VALUES (${input.request}, ${input.actor.subject.id}, ${JSON.stringify(input.actor)}::jsonb, ${input.repository.id},
      ${input.repository.owner}, ${input.repository.name}, ${input.ref}, ${input.from}) ON CONFLICT (id) DO NOTHING`
  const row = yield* read(input.request, input.actor.subject.id)
  return row !== undefined && row.repo === input.repository.id && row.ref === input.ref ? row : undefined
})

/** One durable step owns the provider receipt and the branch's persisted forge. */
export const send = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, http: HttpClient.HttpClient) => (payload: { readonly request: string }) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<RequestRow>`SELECT id, actor, repo_id AS repo, owner, name, ref, sha, failure, branch_id AS "branchId"
    FROM github_branch_requests WHERE id = ${payload.request}`
  if (row === undefined || row.failure !== null) return { status: "failed" as const }
  if (row.branchId !== null) return { status: "done" as const }
  const result = yield* Effect.gen(function* () {
    const services = yield* configured(database, http)
    const made = yield* sql.withTransaction(make(services)({
      actor: row.actor, repository: { id: row.repo, owner: row.owner, name: row.name }, ref: row.ref, from: row.sha, request: row.id,
    }))
    yield* sql.withTransaction(Effect.gen(function* () {
      const tracked = yield* Conversations.track(row.repo, made.name, "open", made.sha, row.actor.subject.id, row.id, "default", "github")
      yield* sql`UPDATE github_branch_requests SET branch_id = ${tracked.branch.branchId} WHERE id = ${row.id}`
      yield* Repos.refsChanged(row.repo)
    }))
  }).pipe(Effect.result)
  if (result._tag === "Failure") {
    // A database failure after the provider wrote must replay its keyed receipt, never become a terminal orphan.
    if (!(result.failure instanceof CreateRefused) || result.failure.code === "unavailable") return yield* new CreationUnavailable()
    const failure = result.failure.code
    yield* sql`UPDATE github_branch_requests SET failure = ${failure} WHERE id = ${row.id}`
    return { status: "failed" as const }
  }
  return { status: "done" as const }
}).pipe(Effect.provide(database), Effect.mapError(() => new CreationUnavailable()))

export const registration = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, http: HttpClient.HttpClient) =>
  Interpreter.layerWithImplementations(Create, Send.toLayer(send(database, http),
    { implementationVersion: "branch/github-create/v1" },
  )).pipe(Layer.provideMerge(Action.layerImplementations))
