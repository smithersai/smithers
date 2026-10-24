// What the git loop's worker tests share (docs/features/issues.md#tests): this file's schema of the compose Postgres
// emptied of the loop's rows, people with live sessions holding a sealed GitHub user token (as sign-in stores them),
// writes admitted as the route admits them, and the GitHub flows' services over the scripted GitHub.
import { Model, type ModelRequest } from "@smthrs/model"
import { HostModel } from "@smthrs/model-host"
import { ConfigProvider, Effect, Option, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import * as TestDatabase from "../../../db/TestDatabase.ts"
import { digestSync } from "@smthrs/crypto"
import * as SessionKeys from "../../SessionKeys.ts"
import * as SessionStore from "../../SessionStore.ts"
import type { Role } from "../../Actor.ts"
import type { testFile } from "../../test/harness.ts"
import { SECRET } from "../../test/signIn.ts"
import type * as Apply from "../Apply.ts"
import * as ModelEndpoint from "../../ModelEndpoint.ts"
import { PersonalModels } from "../../personal/Models.ts"
import type { Repository } from "../Config.ts"
import type * as RepoRoles from "../RepoRoles.ts"
import * as Store from "../Store.ts"
import * as Tokens from "../Tokens.ts"
import type * as Triage from "../Triage.ts"
import { appKey, SCRIPTED_API, type ScriptedGitHub, scriptedApp } from "./scriptedGitHub.ts"

type Runtime = ReturnType<typeof testFile>

/** The repository the tests sync: `acme/widgets`, as `GITHUB_REPOSITORY` names it. */
export const REPOSITORY = { owner: "acme", name: "widgets", id: "github/acme/widgets" } as const

/** Empties the loop's tables and sign-in's, before each test. */
export const reset = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`TRUNCATE github_projection_fences, items, comments, github_writes, github_sync, github_deliveries, github_repositories, sessions,
          sign_in_attempts, people, triage_settings, triage_decisions, model_usage, model_budget_days, model_roles,
          github_repo_roles CASCADE`,
    ),
  )

/** Runs one statement on the file's schema. */
export const sql = (runtime: Runtime, statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe(statement))))

/** The file's schema as a database layer, as a host hands the flows. */
export const database = (runtime: Runtime) =>
  runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))

/** Sign-in's keys for `SECRET`. */
export const keys = () => Effect.runPromise(SessionKeys.make(Redacted.make(SECRET)))

/** A person signed in with a live session whose sealed GitHub token is `token`, expiring `expiresInMs` from now. */
export const signedIn = async (
  runtime: Runtime,
  options: { readonly login: string; readonly token: Redacted.Redacted<string>; readonly expiresInMs?: number | null },
) => {
  const sessionKeys = await keys()
  const sessionId = crypto.randomUUID()
  const access = await Effect.runPromise(
    sessionKeys.seal(options.token, { id: sessionId, name: "github_access", version: 1 }),
  )
  const personId = await runtime.runPromise(Effect.gen(function* () {
    const personId = yield* SessionStore.upsertPerson({
      id: crypto.randomUUID(),
      githubId: options.login.length * 1000,
      login: options.login,
    })
    yield* SessionStore.createSession({
      id: sessionId,
      tokenDigest: digestSync(sessionId),
      personId,
      role: "member",
      access,
      accessExpiresAt: options.expiresInMs === null
        ? null
        : Date.now() + (options.expiresInMs ?? 8 * 60 * 60 * 1000),
      refresh: null,
      refreshDigest: null,
      maxAgeSeconds: 3600,
    })
    return personId
  }))
  return { personId, sessionId }
}

/** Admits a write as the route does, and returns its id. */
export const admit = (
  runtime: Runtime,
  write: {
    readonly actorId: string
    readonly sessionId: string | null
    readonly via: "person" | "agent"
    readonly payload: Store.WritePayload
    readonly id?: string
  },
) =>
  runtime.runPromise(Effect.gen(function* () {
    const id = write.id ?? crypto.randomUUID()
    yield* Store.insertWrite({
      id,
      repoId: REPOSITORY.id,
      actorId: write.actorId,
      sessionId: write.sessionId,
      via: write.via,
      payload: write.payload,
      payloadHash: digestSync(JSON.stringify(write.payload)),
    })
    return id
  }))

/** The row of write `id`. */
export const writeRow = async (runtime: Runtime, id: string) =>
  ((await sql(
    runtime,
    `SELECT status, failure, attempts, item_number AS "itemNumber" FROM github_writes WHERE id = '${id}'`,
  )) as unknown as Array<{ status: string; failure: string | null; attempts: number; itemNumber: number | null }>)[0]

/** Every `items` row of the repository, by number. */
export const items = async (runtime: Runtime) =>
  (await sql(
    runtime,
    `SELECT number, kind, title, body, state, author_login AS "author", comments, write_id AS "writeId",
      deleted_at IS NOT NULL AS deleted
    FROM items WHERE repo_id = '${REPOSITORY.id}' ORDER BY number`,
  )) as unknown as Array<{
    number: number
    kind: string
    title: string
    body: string
    state: string
    author: string | null
    comments: number
    writeId: string | null
    deleted: boolean
  }>

/** Every `comments` row of the repository, oldest first. */
export const comments = async (runtime: Runtime) =>
  (await sql(
    runtime,
    `SELECT item_id AS "itemId", github_id::int AS "githubId", body, author_login AS "author", write_id AS "writeId",
      deleted_at IS NOT NULL AS deleted
    FROM comments WHERE repo_id = '${REPOSITORY.id}' ORDER BY created_at, github_id`,
  )) as unknown as Array<{
    itemId: string
    githubId: number
    body: string
    author: string | null
    writeId: string | null
    deleted: boolean
  }>

/** The sessions whose role check a person's write started, with the check each replaces. */
export type Refreshes = Array<{ readonly sessionId: string; readonly generation: number }>

/** What a scripted judge answers one judgment: each question's raw answer, as the seat's JSON. */
export type JudgeAnswer = (request: ModelRequest.ModelRequest) => Stream.Stream<import("@smthrs/model").ModelEvent.ModelEvent, Model.ModelFailure>

/** A judge that answers `decision` and `reason` sure of both, reporting 40 tokens in and 2 out. */
export const judging = (decision: "accept" | "reject" | "abstain", reason = "other"): JudgeAnswer => () =>
  Stream.make(
    {
      type: "text-delta" as const,
      id: "t",
      text: JSON.stringify({
        answers: { decision: { type: "choice", choice: decision }, reason: { type: "choice", choice: reason } },
      }),
    },
    { type: "usage" as const, inputTokens: 40, outputTokens: 2 },
    { type: "settle" as const, stopReason: "stop" as const },
  )

/**
 * The `judge` seat a host gives triage: `ModelEndpoint.local` on the file's schema, metered against `config`'s budget,
 * over a scripted model that answers with `answer` and records each request in `requests`. The model is the only
 * scripted seam; admission and metering are the endpoint's own.
 */
export const judgeSeat = async (
  runtime: Runtime,
  answer: JudgeAnswer,
  options: { readonly config?: Record<string, string>; readonly database?: Apply.Services["database"] } = {},
) => {
  const requests: Array<ModelRequest.ModelRequest> = []
  const model = Model.make({
    stream: (request) => {
      requests.push(request)
      return answer(request)
    },
  })
  const local = await Effect.runPromise(
    ModelEndpoint.local(options.database ?? (await database(runtime))).pipe(
      Effect.provide(PersonalModels.none),
      Effect.provideService(
        HostModel,
        HostModel.of({ modelId: "judge-model", model, route: { prepare: () => Effect.die(new Error("unused")) } }),
      ),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(options.config ?? {}))),
    ),
  )
  return { seat: local("judge"), requests }
}

/**
 * The GitHub flows' services over the scripted GitHub and the file's schema: the App with a fresh key, sign-in's keys
 * (none when `signIn` is false), a `refresh` that records each role check started, and triage's judge (`judge`, or one
 * that abstains).
 */
export const services = async (
  runtime: Runtime,
  github: ScriptedGitHub,
  options: {
    readonly signIn?: boolean
    readonly database?: Apply.Services["database"]
    readonly judge?: Triage.Services["judge"]
  } = {},
) => {
  const refreshes: Refreshes = []
  const app = await Effect.runPromise(scriptedApp(github, await appKey()))
  const value: Triage.Services = {
    database: options.database ?? (await database(runtime)),
    http: github.http,
    apiBaseUrl: SCRIPTED_API,
    tokens: Tokens.make({
      app,
      keys: options.signIn === false ? Option.none() : Option.some(await keys()),
      refresh: (sessionId, generation) => Effect.sync(() => void refreshes.push({ sessionId, generation })),
    }),
    judge: options.judge ?? (await judgeSeat(runtime, judging("abstain"), options)).seat,
  }
  return { services: value, refreshes }
}

/**
 * `RepoRoles` that read `role` for everyone on every repository: what a route sees when the role changed on GitHub after
 * its read, before the write's transaction, which then finds the row as it stands (decision 0079 §6).
 */
export const rolesThatRead = (repository: Repository, role: Role): RepoRoles.RepoRoles<never> => ({
  repository,
  resolve: (actor, target) =>
    Effect.succeed({ role, held: Option.some({ repoId: target.id, personId: actor.subject.id, role }) }),
})
