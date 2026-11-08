// Who may read a repository's content (devpriv FINAL §1.1, steps 0 and 5): one predicate for every reader of a
// repository's content (its issues' and pulls' shapes, the issue list, the actions shape, a comparison, and the role
// route's `readable`), evaluated per request and never cached across requests. It answers a proof, never a boolean: who read (the
// viewer the request resolved to) and by what (a role, the repository being public, or a runner's token), or why not
// and at which stage.
//
// The stages, in the order every reader checked them before this module (worker/github/Readers.test.ts pins it):
//   1. deployment: the deployment acts on the repository (`mayAct`), else `404 not_found`; for another repository than
//      its own, an About read that found the App absent, `404 app_not_installed`;
//   2. request: the reader's own validation (a list query, an item number), else `400 invalid`;
//   3. viewer: a signed-in person with a role there; else anyone while GitHub's metadata, less than 60 seconds old,
//      says the repository is public. Where the App can't act (`RepoRoles.CANT_ACT`) nobody has a role there, so the
//      public check decides. Sessions, roles, Postgres or GitHub's metadata not answering: `503 unavailable`. Else
//      `401 authentication` signed out, `403 forbidden` with no role. With `session_or_runner`, a runner registered on
//      the repository reads with its token wherever the viewer stage refuses; stages 1 and 2 still apply to it.
import { Effect, Fiber, type Layer, Option } from "effect"
import { HttpServerRequest } from "effect/http"
import type { SqlClient } from "effect/sql"
import type { Role } from "../../src/features/auth/contract.ts"
import { type Actor, Sessions, type SessionsUnavailable } from "#vibelang/emitted/worker/Actor"
import type { Repository } from "./Config.vibe"
import * as RepoRoles from "./RepoRoles.ts"
import * as Store from "./Store.ts"
import * as WorkLinks from "./WorkLinks.ts"

/** Who a read is for: nobody signed in, a person, or a runner registered on the repository. */
export type Viewer =
  | { readonly kind: "anonymous" }
  | { readonly kind: "person"; readonly actor: Actor }
  | { readonly kind: "runner"; readonly runner: string }

/**
 * Where the viewer comes from:
 * - `session`: `Sessions.resolve`, as every repository read resolves (a run's credential first, else the cookie, bound
 *   by `x-smithers-device-person`);
 * - `session_or_runner`: the same, and where the viewer stage refuses, a runner registered on the repository, by its
 *   token (the issue list route);
 * - `cookie`: the session cookie's person alone, never a credential (`Sessions.resolveCookie`). For the first-paint
 *   route; no reader uses it yet. Sessions without a cookie resolver answer it `503 unavailable`.
 */
export type ViewerSource = "session" | "session_or_runner" | "cookie"

/** Why a read is refused, as the readers answer it. */
export type Refusal = "not_found" | "app_not_installed" | "invalid" | "authentication" | "forbidden" | "unavailable"

/** Who may read, and how; or why not, at which stage, and who was refused once the viewer stage resolved one. */
export type Proof =
  | {
    readonly _tag: "Readable"
    readonly target: Repository
    readonly viewer: Viewer
    /** The viewer's role there; `null` for a public read or a runner's. */
    readonly role: Role | null
    readonly via: "role" | "public" | "runner"
  }
  | {
    readonly _tag: "Refused"
    readonly target: Repository
    readonly stage: "deployment" | "request" | "viewer"
    readonly refusal: Refusal
    readonly status: 400 | 401 | 403 | 404 | 503
    readonly retryAfterSeconds?: number
    readonly viewer?: Viewer
  }

export interface Options<E, R> {
  /** The deployment's own repository: never asked whether the App is absent. */
  readonly repository: Repository
  /** Whether the deployment acts on repository `id` (decision 0079 §4). */
  readonly mayAct: (id: string) => boolean
  readonly roles: RepoRoles.RepoRoles<R>
  /** What GitHub's metadata, read less than 60 seconds ago, says: public, or not; none when it can't say. */
  readonly visibility: (target: Repository) => Effect.Effect<Option.Option<boolean>>
  readonly database: Layer.Layer<SqlClient.SqlClient, E, R>
}

/** What a reader asks of `repositoryReadable` besides the repository and where its viewer comes from. */
export interface Ask<A, R2> {
  /** The reader's own validation, after the deployment's checks and before the viewer's: false is `400 invalid`. */
  readonly validate?: Effect.Effect<boolean>
  /**
   * Work that runs beside the viewer stage and the reader's read, from when the viewer stage starts: a stale read's
   * Reconcile admission. It never starts for a refusal at stages 1 or 2. `settled` waits for it.
   */
  readonly alongside?: Effect.Effect<A, never, R2>
}

const refusedAt = (
  target: Repository,
  stage: "deployment" | "request" | "viewer",
  refusal: Refusal,
  status: 400 | 401 | 403 | 404 | 503,
  extra: { readonly retryAfterSeconds?: number | undefined; readonly viewer?: Viewer } = {},
): Proof => ({
  _tag: "Refused",
  target,
  stage,
  refusal,
  status,
  ...(extra.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: extra.retryAfterSeconds }),
  ...(extra.viewer === undefined ? {} : { viewer: extra.viewer }),
})

export const make = <E, R>(options: Options<E, R>) => {
  const { repository, mayAct, roles, visibility, database } = options

  /** The viewer's person from `source`: `None` signed out; a failure when sessions can't be read. */
  const actorOf = (source: ViewerSource) =>
    Effect.flatMap(Sessions, (sessions): Effect.Effect<Option.Option<Actor>, SessionsUnavailable, HttpServerRequest.HttpServerRequest> =>
      source !== "cookie"
        ? sessions.resolve
        : sessions.resolveCookie === undefined
        ? Effect.die("unreachable: cookie resolution without a cookie resolver is refused before it")
        : sessions.resolveCookie)

  /** Stage 3: who may read `target`'s rows, the viewer alone; `repositoryReadable` runs it after the deployment's checks. */
  const viewerAccess = (target: Repository, source: ViewerSource) =>
    Effect.gen(function* () {
      const decided = yield* personAccess(target, source)
      if (decided._tag === "Readable" || source !== "session_or_runner") return decided
      // A runner registered on the repository reads its issues with its own token, as it reads its jobs, only while it
      // is current as a claim requires (decision 0148); any other reads as nobody.
      const request = yield* HttpServerRequest.HttpServerRequest
      const runner = yield* WorkLinks.runnerOf(request, target.id).pipe(
        Effect.provide(database),
        Effect.orElseSucceed(() => Option.none<WorkLinks.RunnerAccess>()),
      )
      return Option.isSome(runner) && runner.value._tag === "Runner"
        ? { _tag: "Readable", target, viewer: { kind: "runner", runner: runner.value.name }, role: null, via: "runner" } satisfies Proof
        : decided
    })

  const personAccess = (target: Repository, source: ViewerSource) =>
    Effect.gen(function* () {
      if (source === "cookie" && (yield* Sessions).resolveCookie === undefined) return refusedAt(target, "viewer", "unavailable", 503)
      const actor = yield* actorOf(source).pipe(Effect.option)
      if (Option.isNone(actor)) return refusedAt(target, "viewer", "unavailable", 503, { retryAfterSeconds: 5 })
      return yield* accessAs(target, actor.value)
    })

  /** Stage 3 for `actor`, whom the caller already resolved. */
  const accessAs = (target: Repository, actor: Option.Option<Actor>) =>
    Effect.gen(function* () {
      const viewer: Viewer = Option.isSome(actor) ? { kind: "person", actor: actor.value } : { kind: "anonymous" }
      if (Option.isSome(actor)) {
        const resolved = yield* roles.resolve(actor.value, target).pipe(Effect.result)
        if (resolved._tag === "Failure") {
          // Where the App can't act, nobody has a role there: the public check below decides, as for anyone. Every
          // other refusal is GitHub or Postgres not answering now.
          if (!RepoRoles.CANT_ACT.has(resolved.failure.code)) {
            return refusedAt(target, "viewer", "unavailable", 503, { retryAfterSeconds: resolved.failure.retryAfterSeconds, viewer })
          }
        } else if (resolved.success.role !== null) {
          return { _tag: "Readable", target, viewer, role: resolved.success.role, via: "role" } satisfies Proof
        }
      }
      const isPublic = yield* Store.isPublic(target.id).pipe(Effect.provide(database), Effect.option)
      if (Option.isNone(isPublic)) return refusedAt(target, "viewer", "unavailable", 503, { viewer })
      if (Option.getOrElse(isPublic.value, () => false)) {
        const current = yield* visibility(target)
        if (Option.isNone(current)) return refusedAt(target, "viewer", "unavailable", 503, { viewer })
        if (current.value) return { _tag: "Readable", target, viewer, role: null, via: "public" } satisfies Proof
      }
      return Option.isNone(actor)
        ? refusedAt(target, "viewer", "authentication", 401, { viewer })
        : refusedAt(target, "viewer", "forbidden", 403, { viewer })
    })

  /** Stages 1 and 2: the deployment's checks, then the reader's validation; `None` when both pass. */
  const deploymentAccess = (target: Repository, validate?: Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      if (!mayAct(target.id)) return Option.some(refusedAt(target, "deployment", "not_found", 404))
      if (target.id !== repository.id) {
        // Postgres not answering leaves it to the viewer stage, which says unavailable.
        const absent = yield* Store.appAbsent(target.id).pipe(Effect.provide(database), Effect.orElseSucceed(() => false))
        if (absent) return Option.some(refusedAt(target, "deployment", "app_not_installed", 404))
      }
      if (validate !== undefined && !(yield* validate)) return Option.some(refusedAt(target, "request", "invalid", 400))
      return Option.none<Proof>()
    })

  /**
   * Whether the request may read `target`'s content, and who it reads as: stages 1 to 3 in order. `settled` waits for
   * `ask.alongside`; a reader awaits it before it answers, so the work never outlives the request.
   */
  const repositoryReadable = <A = never, R2 = never>(target: Repository, source: ViewerSource, ask: Ask<A, R2> = {}) =>
    Effect.gen(function* () {
      const early = yield* deploymentAccess(target, ask.validate)
      if (Option.isSome(early)) return { proof: early.value, settled: Effect.void }
      const beside = ask.alongside === undefined ? undefined : yield* Effect.forkChild(ask.alongside)
      const proof = yield* viewerAccess(target, source)
      return { proof, settled: beside === undefined ? Effect.void : Effect.asVoid(Fiber.join(beside)) }
    })

  /**
   * Each of `targets` as `repositoryReadable` answers it, one proof each in their order, for one reader: who asks is
   * resolved once, so a read across repositories costs one session read and one role read per repository. Sessions not
   * answering refuses every one.
   */
  const readableAmong = (targets: ReadonlyArray<Repository>) =>
    Effect.gen(function* () {
      const actor = yield* actorOf("session").pipe(Effect.option)
      return yield* Effect.forEach(targets, (target) =>
        Effect.gen(function* () {
          const early = yield* deploymentAccess(target)
          if (Option.isSome(early)) return early.value
          return Option.isNone(actor) ? refusedAt(target, "viewer", "unavailable", 503) : yield* accessAs(target, actor.value)
        }), { concurrency: 8 })
    })

  return { repositoryReadable, readableAmong, viewerAccess }
}

export type Access = ReturnType<typeof make>
