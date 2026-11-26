import * as Cloudflare from "@alchemy.run/cloudflare"
import { PresenceRoom } from "@smthrs/sync"
import { RuntimeContext } from "alchemy"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import * as BranchRooms from "./BranchRooms.vibe"
import { type Member, Rooms } from "./branch/Rooms.vibe"
import * as SocketAccess from "./SocketAccess.ts"
import { RoomUpgrade } from "./durable/SocketHost.ts"
import { memory } from "./test/box.ts"
import { connection, objectRegistration, objectRuntime, unusedDatabase } from "./test/durableObject.ts"

const request = HttpServerRequest.fromWeb(new Request("https://chat.test/branch", {
  headers: { "x-smithers-principal": "spoofed", "x-smithers-extra": "remove", "x-keep": "present" },
}))

const admissionOf = (principal: string): SocketAccess.Admission => ({
  session: null,
  alias: null,
  expiresAt: null,
  admittedAt: Date.now(),
  principal,
  role: "member",
  basis: { kind: "branch", branchId: "branch-1" },
  access: "edit",
})

test("the room namespace forwards only the admitted identity and maps unavailable RPCs", async () => {
  let unavailable = false
  const forwarded: Array<HttpServerRequest.HttpServerRequest> = []
  const enforced: Array<unknown> = []
  const objects = {
    getByName: (name: string) => {
      expect(name).toBe("branch-1")
      return {
        fetch: (req: HttpServerRequest.HttpServerRequest) => Effect.suspend(() => {
          forwarded.push(req)
          return unavailable ? Effect.fail("bad fetch") : Effect.succeed(HttpServerResponse.empty({ status: 204 }))
        }),
        enforce: (policy: unknown) => Effect.suspend(() => {
          enforced.push(policy)
          return unavailable ? Effect.fail("bad enforce") : Effect.void
        }),
      }
    },
  } as unknown as Parameters<typeof BranchRooms.roomsOver>[0]
  const policy = { createdBy: null, grants: {} }
  const member: Member = { principal: "pat", name: "Pat", role: null, access: "view", admission: admissionOf("pat") }
  await Effect.runPromise(Effect.gen(function* () {
    const rooms = yield* Rooms
    expect((yield* rooms.join("branch-1", member)).status).toBe(204)
    expect(forwarded[0]?.headers).toMatchObject({
      "x-smithers-principal": "pat",
      "x-smithers-name": "Pat",
      "x-smithers-role": "",
      "x-smithers-access": "view",
      "x-keep": "present",
    })
    expect(forwarded[0]?.headers).not.toHaveProperty("x-smithers-extra")
    expect(forwarded[0] && SocketAccess.admissionOf(forwarded[0])).toEqual(member.admission)
    yield* rooms.enforce("branch-1", policy)
    expect(enforced).toEqual([policy])
    unavailable = true
    expect((yield* rooms.join("branch-1", { ...member, role: "member" })).status).toBe(503)
    expect(yield* Effect.flip(rooms.enforce("branch-1", policy))).toMatchObject({
      _tag: "@smthrs/mvp/branch/RoomUnavailable",
    })
  }).pipe(
    Effect.provide(BranchRooms.roomsLayer(objects)),
    Effect.provideService(RuntimeContext, objectRuntime),
    Effect.provideService(HttpServerRequest.HttpServerRequest, request),
  ))
})

const memberSocket = () => {
  let kept: unknown = null
  const sent: Array<string> = []
  const closed: Array<number> = []
  const socket = {
    send: (frame: string) => Effect.sync(() => void sent.push(frame)),
    close: (code: number) => Effect.sync(() => void closed.push(code)),
    serializeAttachment: (value: unknown) => void (kept = value),
    deserializeAttachment: <T>() => kept as T | null,
  }
  return { socket, sent, closed }
}

type RoomHandlers = BranchRooms.RoomObjectShape & {
  readonly fetch: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest | Cloudflare.DurableObjectState>
  readonly alarm: () => Effect.Effect<void, unknown>
  readonly webSocketMessage: (socket: Cloudflare.WebSocket, message: string) => Effect.Effect<void>
  readonly webSocketClose: (socket: Cloudflare.WebSocket) => Effect.Effect<void>
  readonly webSocketError: (socket: Cloudflare.WebSocket) => Effect.Effect<void>
}

test("the registered room rejects invalid, expired and excess joins and enforces current sharing", async () => {
  const { exports, services } = objectRegistration("RoomObject")
  const attached: Array<Cloudflare.WebSocket> = []
  let alarm: number | null = null
  let listFailure = false
  const sockets = Effect.suspend(() => {
    if (!listFailure) return Effect.succeed(attached)
    listFailure = false
    return Effect.die("socket list unavailable")
  })
  const { store } = memory()
  const storage = {
    get: store.get,
    put: store.put,
    getAlarm: () => Effect.succeed(alarm),
    setAlarm: (at: number) => Effect.sync(() => void (alarm = at)),
    deleteAlarm: () => Effect.sync(() => void (alarm = null)),
  }
  const state = {
    getWebSockets: () => sockets,
    storage,
  } as unknown as Cloudflare.DurableObjectState["Service"]
  const seed = (principal: string) => Effect.gen(function* () {
    const member = memberSocket()
    const admission = admissionOf(principal)
    yield* PresenceRoom.join({ sockets: Effect.succeed([]) }, member.socket, BranchRooms.identityOf({
      principal, name: principal, role: "member", access: "edit", admission,
    }, SocketAccess.leaseFrom(admission, admission.admittedAt)))
    attached.push(member.socket as unknown as Cloudflare.WebSocket)
    return member
  })
  const joinRequest = (admission: SocketAccess.Admission, extra: Record<string, string> = {}) =>
    SocketAccess.forward(request, admission, {
      "x-smithers-principal": admission.principal,
      "x-smithers-name": "Person",
      "x-smithers-role": "member",
      "x-smithers-access": "edit",
      ...extra,
    })

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* Layer.build(BranchRooms.live(connection)).pipe(Effect.provideContext(services))
    const value = exports.get("RoomObject") as {
      kind: string
      constructor: Effect.Effect<Effect.Effect<RoomHandlers, never, RuntimeContext>, never, Cloudflare.DurableObjectState>
    }
    expect(value.kind).toBe("durableObject")
    const initialize = yield* value.constructor
    const handlers = yield* initialize
    const fetch = (req: HttpServerRequest.HttpServerRequest) =>
      handlers.fetch.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))

    expect((yield* fetch(HttpServerRequest.fromWeb(new Request("https://chat.test/branch")))).status).toBe(400)
    expect((yield* fetch(request)).status).toBe(400)
    const visitor = admissionOf("visitor")
    const noAdmission = HttpServerRequest.fromWeb(new Request("https://chat.test/branch", {
      headers: { "x-smithers-principal": "visitor", "x-smithers-name": "Person", "x-smithers-access": "edit" },
    }))
    expect((yield* fetch(noAdmission)).status).toBe(400)
    expect((yield* fetch(joinRequest(visitor, { "x-smithers-principal": "" }))).status).toBe(400)
    expect((yield* fetch(joinRequest(visitor, { "x-smithers-name": "" }))).status).toBe(400)
    expect((yield* fetch(joinRequest(visitor, { "x-smithers-access": "invalid" }))).status).toBe(400)
    expect((yield* fetch(joinRequest({ ...visitor, session: "ended", expiresAt: 1 }))).status).toBe(401)

    const original = yield* seed("visitor")
    for (let count = 1; count < SocketAccess.MAX_SOCKETS_PER_PERSON; count++) yield* seed("visitor")
    expect((yield* fetch(joinRequest(visitor))).status).toBe(429)
    expect((yield* fetch(joinRequest(visitor, { "x-smithers-role": "" }))).status).toBe(429)
    const changed = yield* seed("viewer")
    const steady = memberSocket()
    const steadyAdmission = admissionOf("editor")
    const steadySocket = steady.socket as unknown as Cloudflare.WebSocket
    const upgrade = Effect.sync(() => {
      attached.push(steadySocket)
      return [HttpServerResponse.empty({ status: 101 }), steadySocket] as const
    })
    const joined = yield* fetch(joinRequest(steadyAdmission)).pipe(Effect.provideService(RoomUpgrade, upgrade))
    expect(joined.status).toBe(101)
    expect(steady.socket.deserializeAttachment()).toMatchObject({
      presence: 1,
      data: BranchRooms.identityOf({
        principal: "editor", name: "Person", role: "member", access: "edit", admission: steadyAdmission,
      }, SocketAccess.leaseFrom(steadyAdmission, steadyAdmission.admittedAt)).data,
    })
    yield* handlers.alarm()
    expect(alarm).toBeGreaterThan(Date.now())
    yield* handlers.webSocketMessage(steadySocket, '{"type":"state","state":"here"}')
    expect(steady.sent.length).toBeGreaterThan(0)
    yield* handlers.enforce({ createdBy: null, grants: { viewer: "view", editor: "edit" } })
    expect(original.closed).toEqual([SocketAccess.CLOSES.revoked.code])
    expect(changed.closed).toEqual([SocketAccess.CLOSES.changed.code])
    expect(steady.closed).toEqual([])
    listFailure = true
    yield* handlers.enforce({ createdBy: null, grants: {} })
    expect(steady.closed).toEqual([])
    listFailure = true
    yield* handlers.alarm()
    expect(alarm).toBeGreaterThan(Date.now())
    yield* handlers.webSocketClose(steadySocket)
    yield* handlers.webSocketError(steadySocket)

    const peer = yield* seed("peer")
    const rooms = BranchRooms.room({
      sockets: Effect.succeed([peer.socket]),
      storage,
      check: () => Effect.die("no lease to check"),
      within: (program) => program,
    })
    expect(yield* rooms.renew([])).toEqual(new Set())
    const [leased] = yield* rooms.host.sockets
    expect(leased?.deserializeAttachment()).toEqual(peer.socket.deserializeAttachment())
    leased?.serializeAttachment(null)
    const previousFrames = peer.sent.length
    expect(leased).toBeDefined()
    yield* leased!.send("too late")
    yield* leased!.close(1000, "left")
    expect(peer.closed).toEqual([1000])
    yield* rooms.receive(peer.socket, '{"type":"state","state":"after leave"}')
    expect(peer.socket.deserializeAttachment()).toBeNull()
    expect(peer.sent).toHaveLength(previousFrames)
  })).pipe(
    Effect.provideContext(services),
    Effect.provideService(RuntimeContext, objectRuntime),
    Effect.provideService(Cloudflare.DurableObjectState, state),
    Effect.provideService(Cloudflare.Hyperdrive.Connect, unusedDatabase),
  ))
})


test("lease renewal extends a live member and leaves a socket that loses its attachment out", async () => {
  const now = Date.now()
  const survivor = memberSocket()
  const left = memberSocket()
  const older = memberSocket()
  const newcomer = memberSocket()
  const sockets = [survivor, left, older].map(({ socket }) => socket)
  const room = BranchRooms.room({
    sockets: Effect.succeed(sockets),
    storage: {
      get: () => Effect.undefined,
      put: () => Effect.void,
      getAlarm: () => Effect.succeed(null),
      setAlarm: () => Effect.void,
    },
    check: ({ principal }) => Effect.sync(() => {
      if (principal === "left") left.socket.serializeAttachment(null)
      if (principal === "older") {
        const attachment = older.socket.deserializeAttachment<{ data: string }>()
        expect(attachment).not.toBeNull()
        const { leaseUntil, ...legacy } = JSON.parse(attachment!.data) as Record<string, unknown>
        expect(leaseUntil).toBeDefined()
        older.socket.serializeAttachment({ ...attachment, data: JSON.stringify(legacy) })
      }
      return "keep" as const
    }),
    within: (program) => program,
  })

  await Effect.runPromise(Effect.gen(function* () {
    for (const [index, principal] of ["survivor", "left", "older"].entries()) {
      yield* PresenceRoom.join({ sockets: Effect.succeed([]) }, sockets[index]!, BranchRooms.identityOf({
        principal, name: principal, role: "member", access: "edit", admission: admissionOf(principal),
      }, now + 100))
    }
    const due = yield* room.members
    expect(yield* room.renew(due)).toEqual(new Set([survivor.socket]))
    expect(left.socket.deserializeAttachment()).toBeNull()
    const lease = survivor.socket.deserializeAttachment<{ data: string }>()
    expect(JSON.parse(lease!.data).leaseUntil).toBeGreaterThan(now + 100)
    expect(yield* room.host.sockets).toHaveLength(1)
    yield* room.end([[newcomer.socket, "revoked"]])
    expect(newcomer.closed).toEqual([SocketAccess.CLOSES.revoked.code])

    const departed = memberSocket()
    const admission = admissionOf("departed")
    yield* PresenceRoom.join({ sockets: Effect.succeed([]) }, departed.socket, BranchRooms.identityOf({
      principal: "departed", name: "Departed", role: "member", access: "edit", admission,
    }, now + 100))
    const snapshot = departed.socket.deserializeAttachment()
    const disappearing = {
      ...departed.socket,
      deserializeAttachment: <T>() => {
        const previous = departed.socket.deserializeAttachment<T>()
        departed.socket.serializeAttachment(null)
        return previous
      },
    }
    expect(snapshot).not.toBeNull()
    yield* room.end([[disappearing, "revoked"]])
    expect(departed.closed).toEqual([SocketAccess.CLOSES.revoked.code])
    expect(departed.socket.deserializeAttachment()).toBeNull()
  }))
})
