/**
 * Ephemeral presence and cursors for one shared branch.
 *
 * Presence is deliberately NOT journalled. A roster is a lease table: every
 * announcement extends a lease, and a participant that stops announcing —
 * because the tab closed, the network dropped, or the process died — ages out
 * without anyone reporting the disconnect. Writing presence to the journal
 * would make "who was looking at this" part of the durable, replayable history
 * of a run, which is both unbounded and wrong: replaying a branch must not
 * resurrect a stranger's caret.
 *
 * Every operation authorizes through {@link BranchShare}, so a capability for
 * one branch can neither read nor write another branch's roster.
 *
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { BranchId, Cursor, Participant, ParticipantId, ShareCapability } from "./BranchProtocol.ts"
import * as BranchShare from "./BranchShare.ts"
import { positiveInt } from "./internal/options.ts"
import { SyncError } from "./SyncError.ts"

/**
 * One participant's announcement of itself on a branch.
 *
 * The same shape serves join, heartbeat, and cursor movement: an announcement
 * is idempotent, so a client that reconnects simply announces again.
 *
 * @category models
 * @since 0.1.0
 */
export const Announcement = Schema.Struct({
  capability: ShareCapability,
  branchId: BranchId,
  participantId: ParticipantId,
  displayName: Schema.NonEmptyString,
  cursor: Schema.NullOr(Cursor)
})
/**
 * The value form of {@link Announcement}.
 *
 * @category models
 * @since 0.1.0
 */
export type Announcement = typeof Announcement.Type

/**
 * A capability-bearing request for one branch's roster.
 *
 * @category models
 * @since 0.1.0
 */
export const RosterRequest = Schema.Struct({ capability: ShareCapability, branchId: BranchId })
/**
 * The value form of {@link RosterRequest}.
 *
 * @category models
 * @since 0.1.0
 */
export type RosterRequest = typeof RosterRequest.Type

/**
 * A capability-bearing request to drop one participant.
 *
 * @category models
 * @since 0.1.0
 */
export const LeaveRequest = Schema.Struct({ ...RosterRequest.fields, participantId: ParticipantId })
/**
 * The value form of {@link LeaveRequest}.
 *
 * @category models
 * @since 0.1.0
 */
export type LeaveRequest = typeof LeaveRequest.Type

/**
 * Ephemeral branch presence operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly announce: (announcement: Announcement) => Effect.Effect<Participant, SyncError>
  readonly leave: (request: LeaveRequest) => Effect.Effect<void, SyncError>
  /**
   * One branch's live roster, as a fresh array of detached participants and
   * cursors. Reading drops expired leases and advances a cross-branch sweep.
   */
  readonly list: (request: RosterRequest) => Effect.Effect<ReadonlyArray<Participant>, SyncError>
  readonly changes: Stream.Stream<BranchId>
  /**
   * How long one announcement keeps a participant on the roster, in
   * milliseconds.
   *
   * A lease lapses without anyone reporting it, and nothing publishes on
   * `changes` when it does, so a watcher cannot learn of the last
   * participant's departure from the change feed alone. It re-lists on this
   * cadence instead, which is the longest a lapsed lease can stay visible.
   */
  readonly leaseMs: number
}

/**
 * The branch presence registry.
 *
 * @category services
 * @since 0.1.0
 */
export class BranchPresence extends Context.Service<BranchPresence, Service>()("@smthrs/sync/BranchPresence") {}

/**
 * Constructs a presence registry from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => BranchPresence.of(implementation)

const unavailable = new SyncError({ code: "closed", message: "Branch presence is unavailable" })

/**
 * The lease {@link makeNoop} reports. It holds no one, so the value only has
 * to be a positive number a watcher can build a re-list cadence from.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultLeaseMs = 30_000

/**
 * Constructs a presence registry that holds no one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    announce: () => Effect.fail(unavailable),
    leave: () => Effect.fail(unavailable),
    list: () => Effect.succeed([]),
    changes: Stream.empty,
    leaseMs: defaultLeaseMs,
    ...overrides
  })

/**
 * Provides a presence registry that holds no one.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<BranchPresence> = Layer.succeed(BranchPresence, makeNoop())

/**
 * How long an announcement keeps a participant on the roster.
 *
 * @category models
 * @since 0.1.0
 */
export const PresenceOptions = Schema.Struct({
  leaseMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /**
   * Roster changes a stalled {@link Service.changes} subscriber may fall
   * behind by. Defaults to {@link defaultChangesCapacity}.
   */
  changesCapacity: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /**
   * Participants one branch may hold at once. Defaults to
   * {@link defaultMaxParticipants}.
   */
  maxParticipants: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
})
/**
 * The value form of {@link PresenceOptions}.
 *
 * @category models
 * @since 0.1.0
 */
export type PresenceOptions = typeof PresenceOptions.Type

/**
 * Roster changes a stalled {@link Service.changes} subscriber may fall behind
 * by before the oldest are dropped.
 *
 * Presence is a lease table, and `changes` only says that some branch's roster
 * moved: a follower answers it with `list`. Holding an unbounded backlog for a
 * subscriber that has stopped pulling would let one abandoned watcher retain
 * every announcement the process has seen since. A subscriber that falls
 * further behind than this bound loses the oldest notifications and re-lists;
 * because every notification is answered by a fresh `list`, dropping one never
 * loses roster state.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultChangesCapacity = 256

/**
 * Participants one branch may hold at once.
 *
 * A roster is unbounded fan-out in two directions: it is walked on every
 * `list`, and `Branch.Roster` returns it whole, which no frame ceiling covers.
 * Nothing caps how many distinct `participantId`s one write capability may
 * announce, so without this a single share link could pin an arbitrary number
 * of `Participant` objects until their leases expired. Two hundred and fifty
 * six is far above any real collaborative session; a further announce is
 * refused with `backpressure`.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxParticipants = 256

/**
 * Constructs the in-memory, lease-expiring presence registry.
 *
 * Announcing requires write access: a read-only share link may watch the
 * roster but never appears on it, so a shared read link cannot be used to
 * impersonate a collaborator.
 *
 * The roster is keyed by branch and then by participant, so listing one branch
 * costs that branch plus a bounded sweep of other branches, and no two
 * branches can share a slot. One flat key built by concatenation collided
 * for valid branded ids, which let one announcement overwrite another branch's
 * participant.
 *
 * The change feed slides at {@link defaultChangesCapacity}: announcing never
 * waits on a stalled watcher, and never grows the process on its behalf.
 *
 * Fails with `invalid_request` when an option is not a positive safe integer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeMemory = (
  options: PresenceOptions
): Effect.Effect<Service, SyncError, BranchShare.BranchShare> =>
  Effect.gen(function*() {
    const leaseMs = yield* positiveInt("BranchPresence.PresenceOptions.leaseMs", options.leaseMs, defaultLeaseMs)
    const changesCapacity = yield* positiveInt(
      "BranchPresence.PresenceOptions.changesCapacity",
      options.changesCapacity,
      defaultChangesCapacity
    )
    const maxParticipants = yield* positiveInt(
      "BranchPresence.PresenceOptions.maxParticipants",
      options.maxParticipants,
      defaultMaxParticipants
    )
    const share = yield* BranchShare.BranchShare
    const roster = new Map<BranchId, Map<ParticipantId, Participant>>()
    const changes = yield* PubSub.sliding<BranchId>(changesCapacity)

    const expire = (branchId: BranchId, nowMs: number) => {
      const branch = roster.get(branchId)
      if (branch === undefined) return undefined
      for (const [participantId, participant] of branch) {
        if (participant.leaseExpiresAtMs <= nowMs) branch.delete(participantId)
      }
      if (branch.size === 0) {
        roster.delete(branchId)
        return undefined
      }
      return branch
    }

    // Each announce/list advances through at most 16 branch maps. Their
    // participant counts are capped, so unrelated activity reclaims abandoned
    // rosters without scanning the entire registry in a single request.
    let sweepCursor = roster.keys()
    const sweep = (nowMs: number) => {
      for (let index = 0; index < 16; index++) {
        const next = sweepCursor.next()
        if (next.done) {
          sweepCursor = roster.keys()
          break
        }
        expire(next.value, nowMs)
      }
    }

    const detach = (participant: Participant): Participant =>
      new Participant({
        ...participant,
        cursor: participant.cursor === null ? null : new Cursor(participant.cursor)
      })

    /**
     * Drop this branch's expired leases and advance cleanup of other branches.
     * Abandoned maps are reclaimed as announce/list calls advance the sweep;
     * an idle registry keeps them until activity resumes. Results are detached
     * from storage, including each participant's cursor.
     */
    const live = (branchId: BranchId, nowMs: number): Array<Participant> => {
      sweep(nowMs)
      const branch = expire(branchId, nowMs)
      if (branch === undefined) return []
      return Array.from(branch.values(), detach).sort((left, right) =>
        left.participantId < right.participantId ? -1 : 1
      )
    }

    /**
     * Copy a request out of the caller's object before the first await.
     *
     * `share.verify` awaits Web Crypto between authorizing `branchId` and the
     * roster access that follows. The request objects are plain structs the
     * in-process caller still holds, so reading them again after the await let
     * a caller move `branchId` (or the participant identity) onto a branch the
     * capability never authorized. Matches the claim snapshot in `BranchShare`.
     */
    const detachRoster = (request: RosterRequest): RosterRequest => ({
      capability: request.capability,
      branchId: request.branchId
    })
    const detachLeave = (request: LeaveRequest): LeaveRequest => ({
      ...detachRoster(request),
      participantId: request.participantId
    })
    const detachAnnouncement = (request: Announcement): Announcement => ({
      ...detachLeave(request),
      displayName: request.displayName,
      cursor: request.cursor === null
        ? null
        : new Cursor({ cardId: request.cursor.cardId, offset: request.cursor.offset })
    })

    const announce = Effect.fn("BranchPresence.announce")(function*(supplied: Announcement) {
      const announcement = detachAnnouncement(supplied)
      yield* Effect.annotateCurrentSpan({
        branchId: announcement.branchId,
        participantId: announcement.participantId
      })
      yield* share.verify(announcement.capability, { branchId: announcement.branchId, access: "write" })
      // The wire schema IS `Announcement`, so a remote caller cannot reach
      // here with an empty name. An in-process caller can, and `Participant`
      // requires a `NonEmptyString`: without this the constructor threw a
      // defect out of an operation whose type promises a `SyncError`.
      if (announcement.displayName.length === 0) {
        return yield* Effect.fail(
          new SyncError({ code: "invalid_request", message: "A participant's display name must not be empty" })
        )
      }
      const nowMs = yield* Clock.currentTimeMillis
      // Run-out leases are dropped before the cap is judged, so a branch that
      // has simply been busy over time is never refused for a stale roster.
      live(announcement.branchId, nowMs)
      const branch = roster.get(announcement.branchId) ?? new Map<ParticipantId, Participant>()
      if (!branch.has(announcement.participantId) && branch.size >= maxParticipants) {
        return yield* Effect.fail(
          new SyncError({
            code: "backpressure",
            message: `Branch ${announcement.branchId} already holds ${maxParticipants} participants`
          })
        )
      }
      const participant = new Participant({
        branchId: announcement.branchId,
        participantId: announcement.participantId,
        displayName: announcement.displayName,
        cursor: announcement.cursor,
        leaseExpiresAtMs: nowMs + leaseMs
      })
      branch.set(announcement.participantId, participant)
      roster.set(announcement.branchId, branch)
      yield* PubSub.publish(changes, announcement.branchId)
      return detach(participant)
    })

    const leave = Effect.fn("BranchPresence.leave")(function*(supplied: LeaveRequest) {
      const request = detachLeave(supplied)
      yield* Effect.annotateCurrentSpan({ branchId: request.branchId, participantId: request.participantId })
      yield* share.verify(request.capability, { branchId: request.branchId, access: "write" })
      const branch = roster.get(request.branchId)
      if (branch !== undefined) {
        branch.delete(request.participantId)
        if (branch.size === 0) roster.delete(request.branchId)
      }
      yield* PubSub.publish(changes, request.branchId)
    })

    const list = Effect.fn("BranchPresence.list")(function*(supplied: RosterRequest) {
      const request = detachRoster(supplied)
      yield* Effect.annotateCurrentSpan({ branchId: request.branchId })
      yield* share.verify(request.capability, { branchId: request.branchId, access: "read" })
      return live(request.branchId, yield* Clock.currentTimeMillis)
    })

    return make({ announce, leave, list, changes: Stream.fromPubSub(changes), leaseMs })
  })

/**
 * Provides the in-memory, lease-expiring presence registry. Fails with
 * `invalid_request` when an option is not a positive safe integer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: PresenceOptions
): Layer.Layer<BranchPresence, SyncError, BranchShare.BranchShare> => Layer.effect(BranchPresence, makeMemory(options))
