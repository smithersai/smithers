// Presence in the browser (decision 0013 §4, docs/features/branch-workspace.md#presence): the presence layer on Node,
// dialing a real WebSocket server on loopback at the app's origin that speaks `PresenceProtocol` from `@smthrs/sync`
// as a branch's room does: JSON text frames, the roster from the room and the person's state from the page, and close
// codes that say whether to come back (1000 left, 1008 no access, 1012 changed). The room's own logic is
// `PresenceRoom`'s, tested in `@smthrs/sync`; this tests what the page does with it.
import * as NodeWS from "@effect/platform-node/NodeWS"
import { PresenceProtocol } from "@smthrs/sync"
import { Effect, Layer, ManagedRuntime, Metric } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { MAX_WHERE_PATH } from "./contract"
import { roomUrl } from "./actions"
import { closes, joins } from "./metrics"
import { Presence } from "./presence"
import type { Participant } from "./schema"
import { avatarsOf, followOf, placeOf, selfAccessOf } from "./view"
import { decodeWhere, encodeWhere } from "./where"

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

const until = (assertion: () => void | Promise<void>, timeout = 15_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** One socket the page opened to a room: the path it dialed, the states it sent, and the room's side. */
interface Peer {
  readonly path: string
  readonly states: Array<string | null>
  readonly closed: Promise<number>
  readonly roster: (self: string, participants: ReadonlyArray<PresenceProtocol.Participant>) => void
  readonly close: (code: number) => void
}

/** A room host on loopback: every socket the page opens arrives on `peers`. */
const roomHost = async () => {
  const server = new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const peers: Array<Peer> = []
  server.on("connection", (socket, request) => {
    const states: Array<string | null> = []
    socket.on("message", (data) => {
      const frame = PresenceProtocol.decodeClientFrame(Buffer.from(data as Buffer).toString("utf8"))
      if (frame !== undefined) states.push(frame.state)
    })
    peers.push({
      path: request.url ?? "",
      states,
      closed: new Promise((resolve) => socket.once("close", (code) => resolve(code))),
      roster: (self, participants) => socket.send(PresenceProtocol.encodeServerFrame({ type: "roster", self, participants })),
      close: (code) => socket.close(code),
    })
  })
  closers.push(() =>
    new Promise<void>((resolve) => {
      for (const client of server.clients) client.terminate()
      server.close(() => resolve())
    })
  )
  const { port } = server.address() as { readonly port: number }
  return { origin: `http://127.0.0.1:${port}`, peers }
}

/** The presence layer of one tab on `origin`, with its own metrics. */
const tab = async (origin: string) => {
  const registry: Metric.MetricRegistry = new Map()
  const runtime = ManagedRuntime.make(
    Presence.layer({ origin }).pipe(Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, registry))),
  )
  closers.push(() => runtime.dispose())
  const presence = await runtime.runPromise(Effect.service(Presence))
  presence.queries.participants.startSyncImmediate()
  presence.queries.room.startSyncImmediate()
  const count = (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
    runtime.runSync(Metric.value(Metric.withAttributes(metric, attributes)).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
    )).count
  return {
    actions: presence.actions,
    room: () => {
      const row = presence.queries.room.toArray[0]
      return row === undefined ? undefined : { id: row.id, branchId: row.branchId, status: row.status }
    },
    participants: (): Array<Participant> =>
      presence.queries.participants.toArray.map(({ id, principal, name, access, where, self, order }) => ({
        id,
        principal,
        name,
        access,
        where,
        self,
        order,
      })),
    count,
  }
}

const participant = (
  id: string,
  principal: string,
  fields: Partial<PresenceProtocol.Participant> = {},
): PresenceProtocol.Participant => ({ id, principal, name: principal, access: "write", state: null, ...fields })

const BRANCH = "0b5d7d1c-6f1d-4a65-9d7e-2c1a9c2f4b11"
const OTHER = "6a3c2d0e-8a8b-4c1f-9e0a-1d2b3c4d5e6f"

describe("joining a branch's room", () => {
  test("dials the branch's room, sends where the person is, and fills the participants from the roster", async () => {
    const host = await roomHost()
    const page = await tab(host.origin)
    await page.actions.at({ view: "code", path: "src" })
    await page.actions.join(BRANCH)
    expect(page.room()).toMatchObject({ branchId: BRANCH, status: "connecting" })
    await until(() => expect(host.peers).toHaveLength(1))
    const peer = host.peers[0]!
    expect(peer.path).toBe(`/api/branches/${BRANCH}/room`)

    peer.roster("c-1", [
      participant("c-1", "maya", { state: encodeWhere({ view: "code", path: "src" }) }),
      participant("c-2", "ben", { access: "read", state: encodeWhere({ view: "terminal", terminalId: "t-1" }) }),
    ])
    await until(() => expect(page.room()?.status).toBe("open"))
    await until(() =>
      expect(page.participants()).toEqual([
        { id: "c-1", principal: "maya", name: "maya", access: "write", where: { view: "code", path: "src" }, self: true, order: 0 },
        {
          id: "c-2",
          principal: "ben",
          name: "ben",
          access: "read",
          where: { view: "terminal", terminalId: "t-1" },
          self: false,
          order: 1,
        },
      ])
    )
    await until(() => expect(peer.states).toEqual([encodeWhere({ view: "code", path: "src" })]))
    expect(page.count(joins, { outcome: "joined" })).toBe(1)

    // Moving on the page says so at once; a roster without someone drops them, and a changed one updates in place.
    await page.actions.at({ view: "terminal", terminalId: null })
    await until(() => expect(peer.states.at(-1)).toBe(encodeWhere({ view: "terminal", terminalId: null })))
    peer.roster("c-1", [participant("c-1", "maya", { name: "Maya" })])
    await until(() => expect(page.participants()).toEqual([expect.objectContaining({ id: "c-1", name: "Maya", where: null })]))
  })

  test("joining the room it is in asks nothing more; joining another branch's lets go of the first", async () => {
    const host = await roomHost()
    const page = await tab(host.origin)
    await page.actions.join(BRANCH)
    await page.actions.join(BRANCH)
    await until(() => expect(host.peers).toHaveLength(1))
    await page.actions.join(OTHER)
    await until(() => expect(host.peers).toHaveLength(2))
    expect(await host.peers[0]!.closed).toBe(1000)
    expect(host.peers[1]!.path).toBe(`/api/branches/${OTHER}/room`)
    expect(page.room()).toMatchObject({ branchId: OTHER })
  })

  test("a change of access reconnects and sends the person's place again; leaving lets go and shows nobody", async () => {
    const host = await roomHost()
    const page = await tab(host.origin)
    await page.actions.join(BRANCH)
    await page.actions.at({ view: "code", path: "" })
    await until(() => expect(host.peers).toHaveLength(1))
    host.peers[0]!.roster("c-1", [participant("c-1", "ben", { access: "read" })])
    await until(() => expect(selfAccessOf(page.participants())).toBe("read"))

    host.peers[0]!.close(PresenceProtocol.CloseCode.changed)
    await until(() => expect(page.room()?.status).toBe("offline"))
    await until(() => expect(host.peers).toHaveLength(2))
    host.peers[1]!.roster("c-9", [participant("c-9", "ben", { access: "write" })])
    await until(() => expect(selfAccessOf(page.participants())).toBe("write"))
    expect(page.room()?.status).toBe("open")
    await until(() => expect(host.peers[1]!.states).toEqual([encodeWhere({ view: "code", path: "" })]))

    await page.actions.leave()
    expect(await host.peers[1]!.closed).toBe(1000)
    expect(page.room()).toEqual({ id: "room", branchId: null, status: "idle" })
    expect(page.participants()).toEqual([])
  })

  test("a room that closes with no access is revoked; any other close for good is closed; both show nobody", async () => {
    const host = await roomHost()
    const page = await tab(host.origin)
    await page.actions.join(BRANCH)
    await until(() => expect(host.peers).toHaveLength(1))
    host.peers[0]!.roster("c-1", [participant("c-1", "ben"), participant("c-2", "maya")])
    await until(() => expect(page.participants()).toHaveLength(2))
    host.peers[0]!.close(PresenceProtocol.CloseCode.noAccess)
    await until(() => expect(page.room()).toMatchObject({ branchId: BRANCH, status: "revoked" }))
    expect(page.participants()).toEqual([])
    expect(page.count(closes, { code: "1008" })).toBe(1)

    // A revoked room may be joined again, as a page loaded once access returns does.
    await page.actions.join(BRANCH)
    await until(() => expect(host.peers).toHaveLength(2))
    host.peers[1]!.close(PresenceProtocol.CloseCode.left)
    await until(() => expect(page.room()?.status).toBe("closed"))
    expect(page.count(closes, { code: "1000" })).toBe(1)
  })
})

describe("places", () => {
  test("a place round-trips as a room state; a long path is cut; anything else is no place", () => {
    expect(decodeWhere(encodeWhere({ view: "code", path: "src/app.ts" }))).toEqual({ view: "code", path: "src/app.ts" })
    expect(decodeWhere(encodeWhere({ view: "terminal", terminalId: "t-1" }))).toEqual({ view: "terminal", terminalId: "t-1" })
    const long = decodeWhere(encodeWhere({ view: "code", path: "a".repeat(MAX_WHERE_PATH + 50) }))
    expect(long).toEqual({ view: "code", path: "a".repeat(MAX_WHERE_PATH) })
    expect(encodeWhere({ view: "code", path: "a".repeat(10_000) }).length).toBeLessThanOrEqual(PresenceProtocol.maxStateBytes)
    // A path of wide characters is cut further, to the room's limit in bytes.
    const wide = encodeWhere({ view: "code", path: "路".repeat(MAX_WHERE_PATH) })
    expect(new TextEncoder().encode(wide).byteLength).toBeLessThanOrEqual(PresenceProtocol.maxStateBytes)
    expect((decodeWhere(wide) as { readonly path: string }).path.length).toBeGreaterThan(200)
    for (const state of [null, "not json", JSON.stringify({ view: "elsewhere" })]) expect(decodeWhere(state)).toBeNull()
  })

  test("the room's URL is the app's origin, ws: for http: and wss: for https:", () => {
    expect(roomUrl("http://localhost:1337", BRANCH)).toBe(`ws://localhost:1337/api/branches/${BRANCH}/room`)
    expect(roomUrl("https://smithers.sh", BRANCH)).toBe(`wss://smithers.sh/api/branches/${BRANCH}/room`)
  })
})

describe("the header's avatars", () => {
  const row = (fields: Partial<Participant> & Pick<Participant, "id" | "principal">): Participant => ({
    name: fields.principal,
    access: "write",
    where: null,
    self: false,
    order: 0,
    ...fields,
  })

  test("this person first, by this tab, then everyone else once, by their latest tab, titled with where they are", () => {
    const participants = [
      row({ id: "c-2", principal: "maya", where: { view: "terminal", terminalId: null } }),
      row({ id: "c-1", principal: "maya", self: true }),
      row({ id: "c-3", principal: "ben", where: { view: "code", path: "src" } }),
      row({ id: "c-4", principal: "ben", where: { view: "terminal", terminalId: "t-1" } }),
      row({ id: "c-5", principal: "gus", name: "gus" }),
      row({ id: "c-6", principal: "ann", where: { view: "code", path: "" } }),
    ]
    expect(avatarsOf(participants)).toEqual([
      { id: "c-1", name: "maya", title: "maya (you)" },
      { id: "c-4", name: "ben", title: "ben · Terminal" },
      { id: "c-5", name: "gus", title: "gus" },
      { id: "c-6", name: "ann", title: "ann · Code" },
    ])
    // Alone on the branch, the header still shows who is there: this person. Before the room answers, nobody.
    expect(avatarsOf([row({ id: "c-1", principal: "maya", self: true })])).toEqual([{ id: "c-1", name: "maya", title: "maya (you)" }])
    expect(avatarsOf([])).toEqual([])
    // A roster without this tab (it hasn't joined yet) shows everyone in it.
    expect(avatarsOf([row({ id: "c-3", principal: "ben" })])).toEqual([{ id: "c-3", name: "ben", title: "ben" }])
    expect(placeOf({ view: "code", path: "src/app.ts" })).toBe("src/app.ts")
    expect(placeOf(null)).toBeUndefined()
  })

  test("following goes to their path, or their terminal, `me` for their own; nobody and nowhere go nowhere", () => {
    const participants = [
      row({ id: "c-1", principal: "ben", where: { view: "code", path: "src" } }),
      row({ id: "c-2", principal: "gus", where: { view: "terminal", terminalId: "t-1" } }),
      row({ id: "c-3", principal: "ann", where: { view: "terminal", terminalId: null } }),
      row({ id: "c-4", principal: "zed" }),
    ]
    expect(followOf(participants, "c-1")).toEqual({ path: "src" })
    expect(followOf(participants, "c-2")).toEqual({ path: "", terminal: "t-1" })
    expect(followOf(participants, "c-3")).toEqual({ path: "", terminal: "me" })
    expect(followOf(participants, "c-4")).toBeUndefined()
    expect(followOf(participants, "gone")).toBeUndefined()
    expect(followOf([{ ...participants[0]!, where: { view: "edit", path: "docs/guide.md" } }], participants[0]!.id))
      .toEqual({ path: "docs", edit: "docs/guide.md" })

    expect(selfAccessOf(participants)).toBeUndefined()
  })
})
