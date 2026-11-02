import { PresenceProtocol, PresenceRoom } from "@smthrs/sync"
import { RuntimeContext } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { ACCESSES } from "../src/features/branch/contract.ts"
import { ROLES } from "../src/features/auth/contract.ts"
import { canEdit, canView, type Policy, underPolicy } from "./branch/Access.ts"
import { type Member, RoomUnavailable, Rooms } from "./branch/Rooms.ts"
import { codeOf } from "./ErrorCode.ts"
import * as SocketAccess from "./SocketAccess.ts"
import * as SocketChecks from "./SocketChecks.ts"

// Branch rooms on Cloudflare (decision 0013 §4 and §10, docs/features/branch-workspace.md#presence): `RoomObject`, one
// Durable Object per branch, named by the branch's id, holds the sockets of everyone on the branch and tells each of
// them who else is there and where (`@smthrs/sync`'s `PresenceRoom`). It hibernates: an idle room bills no duration,
// keeps every connection in its socket's attachment, and stores nothing, so it never pins the branch's machine. ChatApi
// hosts it, joins each socket it admitted (worker/branch/Presence.ts), and reaches it through `Rooms`, which this file
// provides from its namespace. Each member keeps who ChatApi admitted under a lease (worker/SocketAccess.ts): only
// members under a live lease hear or are heard, the alarm renews leases before they lapse, and a session that ended or
// access that went (a lower role, a branch removed) ends the lease and closes the socket, as a change of sharing does
// at once (`enforce`).

/** The headers only ChatApi sets on a socket it hands the object; it strips any a browser sent. */
const PRINCIPAL_HEADER = "x-smithers-principal"
const NAME_HEADER = "x-smithers-name"
const ROLE_HEADER = "x-smithers-role"
const ACCESS_HEADER = "x-smithers-access"

/**
 * What the room keeps of a member for itself, never sent to anyone: their role and access when they joined, who
 * ChatApi admitted, and their lease (worker/SocketAccess.ts).
 */
const Kept = Schema.fromJsonString(Schema.Struct({
  role: Schema.NullOr(Schema.Literals(ROLES)),
  access: Schema.Literals(ACCESSES),
  admission: Schema.optionalKey(SocketAccess.Admission),
  leaseUntil: Schema.optionalKey(Schema.Number),
}))
type Kept = typeof Kept.Type
const encodeKept = Schema.encodeSync(Kept)
const decodeKept = Schema.decodeUnknownOption(Kept)

/** A room socket's presence attachment, as `PresenceRoom` keeps it: its `data` is ours. */
type Presence = { readonly presence?: unknown; readonly data?: unknown }

/** What the room keeps of `socket`, or `undefined` for one not joined. */
const keptOf = (socket: PresenceRoom.RoomSocket<any>): Kept | undefined => {
  const presence = socket.deserializeAttachment<Presence>()
  if (presence?.presence !== 1 || typeof presence.data !== "string") return undefined
  return Option.getOrUndefined(decodeKept(presence.data))
}

/** Keeps `kept` as `socket`'s data, beside the rest of its presence attachment. */
const keep = (socket: PresenceRoom.RoomSocket<any>, kept: Kept) => {
  const presence = socket.deserializeAttachment<Presence>()
  if (presence !== null) socket.serializeAttachment({ ...presence, data: encodeKept(kept) })
}

/** One joined member, leased. */
interface Leased<S> {
  readonly socket: S
  readonly kept: Kept
  readonly admission: SocketAccess.Admission
  readonly leaseUntil: number
}

/** What a member's socket is joined with: who they are, as ChatApi admitted them, leased until `leaseUntil`. */
export const identityOf = (member: Member, leaseUntil: number) => ({
  principal: member.principal,
  name: member.name,
  access: canEdit(member.access) ? "write" as const : "read" as const,
  data: encodeKept({ role: member.role, access: member.access, admission: member.admission, leaseUntil }),
})

/** What a room runs on: every socket it holds, its storage and alarm, and the checks of who it admitted. */
export interface Ports<S, R, RS, RC> {
  readonly sockets: Effect.Effect<ReadonlyArray<S>, never, R>
  readonly storage: SocketAccess.Storage<RS>
  readonly check: (admission: SocketAccess.Admission) => Effect.Effect<SocketAccess.Checked, never, RC>
  readonly within: <A>(renewal: Effect.Effect<A, never, R | RS | RC>) => Effect.Effect<A, unknown, R | RS>
}

/**
 * A room over `ports` (worker/SocketAccess.ts): `host` is the room `PresenceRoom` sees, only the members under a live
 * lease, so a roster reaches nobody else and lists nobody else. A message from a member whose lease lapsed waits for
 * its renewal; one that can't be renewed is dropped. A socket from before leases is closed `1012` first.
 */
export const room = <S extends PresenceRoom.RoomSocket<R>, R, RS, RC>(ports: Ports<S, R, RS, RC>) => {
  /** Whether `socket`'s own attachment holds a live lease before its session's end at `now`. */
  const leasedAt = (socket: PresenceRoom.RoomSocket<any>, now: number): boolean => {
    const kept = keptOf(socket)
    return kept?.admission !== undefined && (kept.leaseUntil ?? 0) > now && !SocketAccess.ended(kept.admission, now)
  }

  /**
   * The room `PresenceRoom` sees: the members whose lease holds when it reads them, each behind a send that checks its
   * own attachment again right before the frame goes, so one whose lease or session ends mid-roster gets nothing.
   */
  const host: PresenceRoom.RoomHost<PresenceRoom.RoomSocket<R>, R> = {
    sockets: Effect.flatMap(ports.sockets, (all) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        all.filter((socket) => leasedAt(socket, now)).map((socket): PresenceRoom.RoomSocket<R> => ({
          send: (text) =>
            Effect.flatMap(Clock.currentTimeMillis, (at) => leasedAt(socket, at) ? socket.send(text) : Effect.void),
          close: (code, reason) => socket.close(code, reason),
          serializeAttachment: (value) => socket.serializeAttachment(value),
          deserializeAttachment: <T>() => socket.deserializeAttachment<T>(),
        })))),
  }

  /** Every joined member with a lease; a member from before leases is closed `1012` first. */
  const members = Effect.gen(function* () {
    const found: Array<Leased<S>> = []
    const legacy: Array<S> = []
    for (const socket of yield* ports.sockets) {
      const kept = keptOf(socket)
      if (kept === undefined) continue
      if (kept.admission === undefined || kept.leaseUntil === undefined) legacy.push(socket)
      else found.push({ socket, kept, admission: kept.admission, leaseUntil: kept.leaseUntil })
    }
    yield* end(legacy.map((socket) => [socket, "legacy"] as const))
    yield* SocketAccess.countLegacy("room", legacy.length)
    return found
  })

  /** Takes every one of `ending` out of the room before any closes; each close then tells only who is left. */
  const end = (ending: ReadonlyArray<readonly [S, SocketAccess.Closing]>) =>
    Effect.gen(function* () {
      for (const [socket] of ending) {
        const kept = keptOf(socket)
        if (kept !== undefined) keep(socket, { ...kept, leaseUntil: 0 })
      }
      for (const [socket, closing] of ending) yield* PresenceRoom.close(host, socket, SocketAccess.CLOSES[closing].code)
    })

  /** Renews `due`'s leases; the rest leave the room. Answers those renewed. */
  const renew = (due: ReadonlyArray<Leased<S>>) =>
    Effect.gen(function* () {
      if (due.length === 0) return new Set<S>()
      const verdicts = yield* SocketAccess.renew("room", due.map((member) => member.admission), ports.check, ports.within)
      const now = yield* Clock.currentTimeMillis
      const renewed = new Set<S>()
      const ending: Array<readonly [S, SocketAccess.Closing]> = []
      due.forEach((member, index) => {
        const { verdict, until } = verdicts[index]!
        // A member who left, or was ended, while the check ran stays out.
        const current = keptOf(member.socket)
        if (current === undefined || (current.leaseUntil ?? 0) === 0) return
        if (verdict !== "keep") return void ending.push([member.socket, verdict])
        // The window its check measured, from when that check started (decision 0151 rule 9).
        keep(member.socket, { ...current, leaseUntil: until ?? SocketAccess.leaseFrom(member.admission, now) })
        renewed.add(member.socket)
      })
      yield* end(ending)
      return renewed
    })

  /** Arms the alarm for the next renewal while anyone is in the room; never later than one already set. */
  const arm = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* SocketAccess.armAt(ports.storage, SocketAccess.nextRenewal(yield* members, now))
  })

  /** One renewal at a time: a message or alarm that finds one running waits for it. */
  const flight = SocketAccess.singleFlight()

  /** Renews every lease due now (`SocketAccess.due`), one renewal at a time; a failure is logged. */
  const renewDue = flight(Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* renew((yield* members).filter((member) => SocketAccess.due(member.admission, member.leaseUntil, now)))
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("room.renew").pipe(Effect.annotateLogs({ errorCode: codeOf(cause) }))
    ),
  ))

  /**
   * The alarm: every lease due renewed, then the next one armed, after a failed renewal too. A failure to arm fails
   * the alarm, which Cloudflare retries.
   */
  const alarm = Effect.andThen(renewDue, arm)

  /**
   * A member's message: handled under a live lease. One that lapsed waits for the room's renewal (one at a time, so a
   * burst of messages costs one) and is dropped unless its lease holds after it.
   */
  const receive = (socket: S, message: string | ArrayBuffer) =>
    Effect.gen(function* () {
      // The socket's own attachment decides: the object hands each event its own wrapper of the socket.
      const live = Effect.map(Clock.currentTimeMillis, (now) => leasedAt(socket, now))
      if (!(yield* live)) {
        if (keptOf(socket)?.admission === undefined) return
        yield* renewDue
        if (!(yield* live)) return
      }
      yield* PresenceRoom.receive(host, socket, message)
    })

  /** Whether `principal` already holds `SocketAccess.MAX_SOCKETS_PER_PERSON` sockets in the room. */
  const crowded = (principal: string) =>
    Effect.map(members, (found) => SocketAccess.crowded(found.map((member) => member.admission), principal))

  /** Closes a member from before leases and arms the alarm for the rest: what a waking room does first. */
  const restore = arm

  return { host, members, end, renew, arm, alarm, receive, crowded, restore }
}

/** The object's methods, as ChatApi calls them. */
export interface RoomObjectShape {
  readonly enforce: (policy: Policy) => Effect.Effect<void, never, RuntimeContext>
}

/** The `RoomObject` Durable Object namespace: a branch's room is `getByName(branchId)`. */
export class RoomObject extends Cloudflare.DurableObject<RoomObject, RoomObjectShape>()("RoomObject") {}

/** The object's implementation: the room of one branch. */
export const live = <E, R>(
  connection: Effect.Effect<Cloudflare.Hyperdrive.Connection, E, R>,
  options: SocketChecks.Options = {},
) => RoomObject.make(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    const checks = yield* SocketChecks.checker(connection, options)
    return Effect.gen(function* () {
      // The socket handlers run outside a request, with this incarnation's runtime.
      const runtime = yield* RuntimeContext
      const rooms = room({
        sockets: state.getWebSockets().pipe(Effect.provideService(RuntimeContext, runtime)),
        storage: state.storage,
        check: checks.check,
        within: checks.within,
      })
      const host = rooms.host
      // Before this incarnation handles anything: a member from before leases is closed, and the alarm armed.
      yield* rooms.restore

      /** A socket ChatApi admitted: joined to the room as the member its headers name. */
      const join = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const principal = request.headers[PRINCIPAL_HEADER] ?? ""
        const name = request.headers[NAME_HEADER] ?? ""
        const admission = SocketAccess.admissionOf(request)
        const kept = decodeKept(JSON.stringify({
          role: request.headers[ROLE_HEADER] === "" ? null : request.headers[ROLE_HEADER],
          access: request.headers[ACCESS_HEADER],
          admission,
        }))
        if (principal === "" || name === "" || admission === undefined || kept._tag === "None") {
          return HttpServerResponse.empty({ status: 400 })
        }
        // A session that ended on the way here gets nothing; nor does a person over the cap.
        if (SocketAccess.ended(admission, Date.now())) return HttpServerResponse.empty({ status: 401 })
        if (yield* rooms.crowded(principal)) return HttpServerResponse.empty({ status: 429 })
        const [response, socket] = yield* Cloudflare.upgrade()
        yield* PresenceRoom.join(host, socket, identityOf({
          principal,
          name,
          role: kept.value.role,
          access: kept.value.access,
          admission,
        }, SocketAccess.leaseFrom(admission, admission.admittedAt)))
        yield* rooms.arm
        return response
      })

      /**
       * Holds everyone in the room to the branch's permission list as it now stands: a member who lost the branch
       * leaves for good, and one whose access changed reconnects to get the new one.
       */
      const enforce = (policy: Policy) =>
        Effect.gen(function* () {
          // Everyone who lost the branch or whose access changed leaves before any roster goes out.
          const ending: Array<readonly [Cloudflare.WebSocket, SocketAccess.Closing]> = []
          for (const member of yield* rooms.members) {
            const now = underPolicy(policy, member.admission.principal, member.kept.role)
            if (!canView(now)) ending.push([member.socket, "revoked"])
            else if (now !== member.kept.access) ending.push([member.socket, "changed"])
          }
          yield* rooms.end(ending)
          yield* Effect.logInfo("room.enforce").pipe(Effect.annotateLogs({ closed: ending.length }))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("room.enforce").pipe(Effect.annotateLogs({ errorCode: codeOf(cause) }))
          ),
          Effect.withSpan("room.object.enforce"),
        )

      return {
        enforce,
        fetch: join,
        alarm: () => rooms.alarm,
        webSocketMessage: (socket: Cloudflare.WebSocket, message: string | ArrayBuffer) => rooms.receive(socket, message),
        webSocketClose: (socket: Cloudflare.WebSocket) => PresenceRoom.leave(host, socket),
        webSocketError: (socket: Cloudflare.WebSocket) => PresenceRoom.leave(host, socket),
      }
    })
  }),
)

/** The namespace as ChatApi holds it once it has bound it (`yield* RoomObject`). */
type Objects = Cloudflare.DurableObject<RoomObjectShape>

/** ChatApi's `Rooms` over the bound namespace, for the request that calls it. */
export const roomsOver = (objects: Objects) =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeContext
    return Rooms.of({
      join: (branchId: string, member: Member) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          // Only these headers say who joins; any `x-smithers-*` the browser sent is dropped first.
          const forwarded = SocketAccess.forward(request, member.admission, {
            [PRINCIPAL_HEADER]: member.principal,
            [NAME_HEADER]: member.name,
            [ROLE_HEADER]: member.role ?? "",
            [ACCESS_HEADER]: member.access,
          })
          return yield* objects.getByName(branchId).fetch(forwarded).pipe(Effect.provideService(RuntimeContext, runtime))
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 }))),
      enforce: (branchId, policy) =>
        objects.getByName(branchId).enforce(policy).pipe(
          Effect.provideService(RuntimeContext, runtime),
          Effect.mapError(() => new RoomUnavailable()),
        ),
    })
  })

/** `Rooms` as a layer, for the runtime that calls it. */
export const roomsLayer = (objects: Objects) => Layer.effect(Rooms, roomsOver(objects))
