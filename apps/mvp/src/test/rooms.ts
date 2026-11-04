import * as NodeWS from "@effect/platform-node/NodeWS"
import { PresenceRoom } from "@smthrs/sync"
import { Effect } from "effect"
import type * as Socket from "effect/socket/Socket"

// Presence rooms on loopback for the browser's tests: `@smthrs/sync`'s real `PresenceRoom`, one room per path, over a
// WebSocket server, as the `RoomObject` Durable Object hosts them in production (worker/BranchRooms.ts). ChatApi's room
// routes decide who joins and stamp who they are (worker/branch/Texts.ts, tested with the routes); here a tab's
// WebSocket (`dialing`) names its person in the query instead.

/** Who a tab is in a room: their id, their name and what they may do. */
export interface RoomPerson {
  readonly id: string
  readonly name: string
  readonly access?: "read" | "write"
}

/** A room host on loopback: its origin and, once you are done, `close`. */
export const roomHost = async () => {
  const server = new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const rooms = new Map<string, Set<PresenceRoom.RoomSocket>>()
  server.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://rooms.test")
    const sockets = rooms.get(url.pathname) ?? new Set()
    rooms.set(url.pathname, sockets)
    const host = { sockets: Effect.sync(() => [...sockets]) }
    let attachment: unknown = null
    const room: PresenceRoom.RoomSocket = {
      send: (text) => Effect.sync(() => socket.send(text)),
      close: (code) => Effect.sync(() => socket.close(code)),
      serializeAttachment: (value) => {
        attachment = structuredClone(value)
      },
      deserializeAttachment: <T>() => structuredClone(attachment) as T | null,
    }
    sockets.add(room)
    socket.on("message", (data, binary) =>
      Effect.runSync(PresenceRoom.receive(host, room, binary ? new Uint8Array(data as Buffer) : String(data)))
    )
    socket.on("close", () => {
      Effect.runSync(PresenceRoom.leave(host, room))
      sockets.delete(room)
    })
    Effect.runSync(PresenceRoom.join(host, room, {
      principal: url.searchParams.get("principal") ?? "",
      name: url.searchParams.get("name") ?? "",
      access: url.searchParams.get("access") === "read" ? "read" : "write",
    }))
  })
  const { port } = server.address() as { readonly port: number }
  return {
    origin: `ws://127.0.0.1:${port}`,
    /** How many sockets are in the room at `path`. */
    occupants: (path: string) => rooms.get(path)?.size ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate()
        server.close(() => resolve())
      }),
  }
}

/** A tab's WebSocket for `person`: it dials `origin` in ChatApi's place, naming who it is as ChatApi's room route does. */
export const dialing = (origin: string, person: RoomPerson): Socket.WebSocketConstructor["Service"] => (url) => {
  const asked = new URL(url)
  const target = new URL(`${origin}${asked.pathname}${asked.search}`)
  target.searchParams.set("principal", person.id)
  target.searchParams.set("name", person.name)
  target.searchParams.set("access", person.access ?? "write")
  return new globalThis.WebSocket(target) as unknown as Socket.WebSocketLike
}
