/**
 * Hiring, lifecycle, and durable storage of hired principals.
 *
 * A principal whose grants include `hiring` may propose a `specialist`
 * (persistent) or a `helper` (scoped to one task). {@link propose} is pure: it
 * builds the proposed profile and refuses it with every roster invariant the
 * hire would break. A hire's grants stay inside its parent's, it never holds
 * personal accounts or direct owner contact, its depth below every ancestor,
 * its parent's children and persistent counts, and its parent's daily token
 * (and USD) allocation stay within their limits, and its parent and every
 * principal above it must be active.
 *
 * {@link transition} is the lifecycle state machine: `proposed` activates,
 * `active` pauses and resumes, and anything retires. Retirement is terminal:
 * it revokes every grant, records `retiredAt`, and keeps the memory
 * namespace so the principal's history remains attributable.
 * {@link retireWithHires} retires a principal and everything it hired, and
 * {@link settleTask} retires the helpers scoped to a finished task.
 *
 * {@link RosterStore} persists hired profiles as rendered profile files in
 * `<dir>/Specialists/<id>.md`, with compare-and-set on the file digest.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import { randomUUID } from "node:crypto"
import { sha256Hex } from "./internal/digest.ts"
import * as Issues from "./internal/issues.ts"
import * as Profile from "./Profile.ts"
import * as Roster from "./Roster.ts"

/**
 * A hire slug: one lowercase principal-id segment.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/, { expected: "a lowercase slug" }))

/**
 * The id a hire of `slug` by `parent` receives: `<parent>.<slug>`. Refused
 * when the slug is malformed or the id would exceed the principal id grammar
 * (at most three hire levels below a core role).
 *
 * @category constructors
 * @since 1.0.0
 */
export const specialistId = (parent: Profile.PrincipalId, slug: string): Result.Result<Profile.PrincipalId, string> => {
  if (!Schema.is(Slug)(slug)) return Result.fail("a hire slug is one lowercase id segment")
  const id = `${parent}.${slug}`
  return Schema.is(Profile.PrincipalId)(id)
    ? Result.succeed(id)
    : Result.fail("the hire would exceed the principal id grammar or depth")
}

/**
 * What a hiring principal asks for. `seat` defaults to the parent's seat;
 * `at` is the hire time recorded as `hiredAt`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const HireRequest = Schema.Struct({
  parent: Profile.PrincipalId,
  slug: Slug,
  name: Profile.Line,
  kind: Schema.Literals(["specialist", "helper"]),
  charter: Profile.Charter,
  grants: Profile.Grants,
  budget: Profile.BudgetPolicy,
  skills: Schema.Array(Profile.SkillName),
  taskScope: Schema.optionalKey(Profile.TaskId),
  seat: Schema.optionalKey(Profile.Seat),
  effort: Schema.optionalKey(Schema.Literals(["low", "medium", "high"])),
  at: Profile.Instant
})

/**
 * What a hiring principal asks for.
 *
 * @category models
 * @since 1.0.0
 */
export type HireRequest = typeof HireRequest.Type

const decodeProfile = Schema.decodeUnknownResult(Profile.Profile, { onExcessProperty: "error" })

const key = (violation: Roster.Violation) => `${violation.code}\u0000${violation.principal}\u0000${violation.message}`

/**
 * Builds the `proposed` profile for a hire, or every invariant it breaks.
 *
 * The check is incremental: the roster is validated with and without the
 * hire and only violations the hire introduces refuse it, so an unrelated
 * pre-existing problem does not block hiring and a hire cannot hide behind
 * one. A hire whose parent or any principal above it is not active is
 * refused with `parent-inactive`, and a reused id (even a retired one) with
 * `duplicate-id`.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const propose = (
  request: HireRequest,
  roster: Pick<Roster.Roster, "profiles">,
  policy: Roster.Policy
): Result.Result<Profile.Profile, ReadonlyArray<Roster.Violation>> => {
  const refuse = (code: Roster.ViolationCode, principal: string, message: string) =>
    Result.fail([{ code, principal, message }])
  const id = specialistId(request.parent, request.slug)
  if (Result.isFailure(id)) return refuse("specialist-prefix", request.parent, id.failure)
  const parent = roster.profiles.get(request.parent)
  if (parent === undefined) return refuse("unknown-hirer", id.success, `hirer ${request.parent} is not on the roster`)
  const active = Roster.resolveActive(roster, request.parent)
  if (Result.isFailure(active)) return refuse("parent-inactive", id.success, active.failure.message)
  const decoded = decodeProfile({
    id: id.success,
    name: request.name,
    kind: request.kind,
    status: "proposed",
    version: "1.0.0",
    reportsTo: parent.id,
    seat: request.seat ?? parent.seat,
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    charter: request.charter,
    grants: request.grants,
    budget: request.budget,
    memory: { namespace: Profile.defaultMemoryNamespace(id.success) },
    skills: request.skills,
    cases: [],
    identities: {},
    hiredBy: parent.id,
    hiredAt: request.at,
    ...(request.taskScope === undefined ? {} : { taskScope: request.taskScope })
  })
  if (Result.isFailure(decoded)) {
    return refuse("invalid-profile", id.success, Issues.summary(Issues.problems(decoded.failure)))
  }
  const existing = [...roster.profiles.values()]
  const before = new Set(Roster.validate(existing, policy).map(key))
  const introduced = Roster.validate([...existing, decoded.success], policy).filter((violation) =>
    !before.has(key(violation))
  )
  return introduced.length === 0 ? Result.succeed(decoded.success) : Result.fail(introduced)
}

/**
 * A lifecycle action.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Action = Schema.Literals(["activate", "pause", "resume", "retire"])

/**
 * A lifecycle action.
 *
 * @category models
 * @since 1.0.0
 */
export type Action = typeof Action.Type

/**
 * A lifecycle action the profile's status does not allow, or an invalid time.
 *
 * @category errors
 * @since 1.0.0
 */
export class TransitionRefused extends Schema.TaggedError<TransitionRefused>()(
  "@smthrs/organization/Hiring/TransitionRefused",
  { principal: Schema.String, from: Profile.Status, action: Action, message: Schema.String }
) {}

const moves: Record<Action, { readonly from: ReadonlyArray<Profile.Status>; readonly to: Profile.Status }> = {
  activate: { from: ["proposed"], to: "active" },
  pause: { from: ["active"], to: "paused" },
  resume: { from: ["paused"], to: "active" },
  retire: { from: ["proposed", "active", "paused"], to: "retired" }
}

/**
 * The grants a retired principal keeps: none.
 *
 * @category constants
 * @since 1.0.0
 */
export const revokedGrants: Profile.Grants = {
  tools: [],
  connections: [],
  knowledge: [],
  repositories: [],
  personalAccounts: false,
  contact: "via-parent"
}

/**
 * Applies one lifecycle action at `at` (a UTC instant).
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const transition = (
  profile: Profile.Profile,
  action: Action,
  at: string
): Result.Result<Profile.Profile, TransitionRefused> => {
  const refused = (message: string) =>
    Result.fail(new TransitionRefused({ principal: profile.id, from: profile.status, action, message }))
  const move = moves[action]
  if (!move.from.includes(profile.status)) return refused(`a ${profile.status} principal cannot ${action}`)
  if (action !== "retire") return Result.succeed({ ...profile, status: move.to })
  if (!Schema.is(Profile.Instant)(at)) return refused("retirement needs a UTC instant")
  return Result.succeed({ ...profile, status: "retired", grants: revokedGrants, retiredAt: at })
}

/**
 * Retires `id` and every unretired principal it hired, directly or
 * transitively, returning the changed profiles with the root first.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const retireWithHires = (
  roster: Pick<Roster.Roster, "profiles">,
  id: Profile.PrincipalId,
  at: string
): Result.Result<ReadonlyArray<Profile.Profile>, TransitionRefused> =>
  Result.gen(function*() {
    const root = roster.profiles.get(id)
    if (root === undefined) {
      return yield* Result.fail(
        new TransitionRefused({ principal: id, from: "proposed", action: "retire", message: "not on the roster" })
      )
    }
    const retired: Array<Profile.Profile> = []
    const queue = [root]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (next.status !== "retired") retired.push(yield* transition(next, "retire", at))
      queue.push(...Roster.childrenOf(roster.profiles.values(), next.id))
    }
    return retired
  })

/**
 * Retires every unretired helper scoped to `taskId`, and everything those
 * helpers hired, when the task settles.
 *
 * @category lifecycle
 * @since 1.0.0
 */
export const settleTask = (
  roster: Pick<Roster.Roster, "profiles">,
  taskId: string,
  at: string
): Result.Result<ReadonlyArray<Profile.Profile>, TransitionRefused> =>
  Result.gen(function*() {
    const retired: Array<Profile.Profile> = []
    for (const profile of roster.profiles.values()) {
      if (profile.kind === "helper" && profile.taskScope === taskId && profile.status !== "retired") {
        retired.push(...(yield* retireWithHires(roster, profile.id, at)))
      }
    }
    return retired
  })

/**
 * A stored hired profile and the SHA-256 of its file text.
 *
 * @category models
 * @since 1.0.0
 */
export interface Stored {
  readonly profile: Profile.Profile
  readonly digest: string
}

/**
 * Stable roster store failure codes: `conflict` (the compare-and-set
 * expectation did not hold), `confinement` (a path resolved outside the
 * roster directory), `placement` (a core profile, which people author), `io`,
 * and `parse`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RosterStoreErrorCode = Schema.Literals(["conflict", "confinement", "placement", "io", "parse"])

/**
 * A roster store failure code.
 *
 * @category models
 * @since 1.0.0
 */
export type RosterStoreErrorCode = typeof RosterStoreErrorCode.Type

/**
 * A failed roster store operation.
 *
 * @category errors
 * @since 1.0.0
 */
export class RosterStoreError extends Schema.TaggedError<RosterStoreError>()(
  "@smthrs/organization/Hiring/RosterStoreError",
  { code: RosterStoreErrorCode, principal: Schema.String, message: Schema.String }
) {}

/**
 * Durable storage for hired profiles.
 *
 * `write` stores the rendered profile atomically. With `expectedDigest`
 * omitted it only creates, refusing an existing file; with it, the current
 * file must have exactly that digest. `read` returns the stored profile, or
 * none.
 *
 * @category services
 * @since 1.0.0
 */
export interface Service {
  readonly write: (profile: Profile.Profile, expectedDigest?: string) => Effect.Effect<Stored, RosterStoreError>
  readonly read: (id: Profile.PrincipalId) => Effect.Effect<Option.Option<Stored>, RosterStoreError>
}

/**
 * The roster store service.
 *
 * @category services
 * @since 1.0.0
 */
export class RosterStore extends Context.Service<RosterStore, Service>()("@smthrs/organization/Hiring/RosterStore") {}

/**
 * Stores hired profiles under `<dir>/Specialists/<id>.md`.
 *
 * Writes go to a temporary file in the same directory and are renamed over
 * the target, so a reader sees the old or the new file, never a partial one.
 * The directory and any existing target must resolve inside the real path of
 * `dir`. One in-process lock serializes compare-and-set; the store assumes it
 * is the only writer of `Specialists/`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerFileSystem = (options: { readonly dir: string }): Layer.Layer<
  RosterStore,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    RosterStore,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const lock = yield* Semaphore.make(1)
      const root = path.resolve(options.dir)
      const failure = (code: RosterStoreErrorCode, principal: string, message: string) =>
        new RosterStoreError({ code, principal, message })
      const io = (principal: string, message: string) => () => failure("io", principal, message)
      const confine = Effect.fnUntraced(function*(principal: string, location: string) {
        const realRoot = yield* fs.realPath(root).pipe(
          Effect.mapError(io(principal, "the roster directory is missing"))
        )
        const real = yield* fs.realPath(location).pipe(Effect.mapError(io(principal, "a path could not be resolved")))
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          return yield* failure("confinement", principal, "the path resolves outside the roster directory")
        }
        return real
      })
      const specialists = path.join(root, "Specialists")
      const current = Effect.fnUntraced(function*(id: string) {
        const target = path.join(specialists, `${id}.md`)
        const exists = yield* fs.exists(specialists).pipe(Effect.mapError(io(id, "the store could not be checked")))
        if (!exists) return { target, text: undefined }
        yield* confine(id, specialists)
        const present = yield* fs.exists(target).pipe(Effect.mapError(io(id, "the profile could not be checked")))
        if (!present) return { target, text: undefined }
        const real = yield* confine(id, target)
        const text = yield* fs.readFileString(real).pipe(Effect.mapError(io(id, "the profile could not be read")))
        return { target, text }
      })
      return RosterStore.of({
        read: (id) =>
          current(id).pipe(
            Effect.flatMap(({ text }) =>
              text === undefined ? Effect.succeedNone : Roster.parseProfile(`Specialists/${id}.md`, text).pipe(
                Effect.mapError((error) => failure("parse", id, error.message)),
                Effect.map((profile) => Option.some({ profile, digest: sha256Hex(text) }))
              )
            )
          ),
        write: (profile, expectedDigest) =>
          lock.withPermits(1)(Effect.gen(function*() {
            if (profile.kind === "core") {
              return yield* failure("placement", profile.id, "core profiles are authored in Roles, not hired")
            }
            yield* fs.makeDirectory(specialists, { recursive: true }).pipe(
              Effect.mapError(io(profile.id, "the store could not be created"))
            )
            const { target, text } = yield* current(profile.id)
            const found = text === undefined ? undefined : sha256Hex(text)
            if (found !== expectedDigest) {
              return yield* failure(
                "conflict",
                profile.id,
                expectedDigest === undefined ? "the profile already exists" : "the stored profile changed"
              )
            }
            const rendered = Roster.renderProfile(profile)
            const temporary = path.join(specialists, `.${profile.id}.${randomUUID()}.tmp`)
            yield* fs.writeFileString(temporary, rendered, { flag: "wx" }).pipe(
              Effect.mapError(io(profile.id, "the profile could not be written"))
            )
            yield* fs.rename(temporary, target).pipe(
              Effect.catch(() =>
                fs.remove(temporary).pipe(
                  Effect.ignore,
                  Effect.andThen(Effect.fail(failure("io", profile.id, "the profile could not be replaced")))
                )
              )
            )
            return { profile, digest: sha256Hex(rendered) }
          }))
      })
    })
  )
