---
title: "Presence rooms"
description: "Show who is on a page, and where, live: a room that keeps every connection in its socket's attachment so it survives hibernation, and a page socket that reconnects and resends its latest state."
---

A presence room tells everyone on one page, such as a branch, who else is
there and where they are. It is three modules:

- `PresenceProtocol`: the wire. Pure, so the host and the page share it.
- `PresenceRoom`: the host side, over a structural socket host.
- `PresenceSocket`: the page side, a reconnecting WebSocket.

Presence is not durable. Nothing is journalled or stored; a room that loses
every socket is empty, and that is correct.

## The wire

Every frame is JSON text over one WebSocket per page.

| From | Frame                                                         | Meaning                                                      |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| page | `{ "type": "state", "state": string \| null }`                | This participant's latest state. The room relays it unread.  |
| room | `{ "type": "roster", "self": string, "participants": [...] }` | Everyone in join order, `self` included, after every change. |

A participant is `{ id, principal, name, access, state }`. `id` is a UUID the
room makes for each connection, so one person on two devices appears twice
with one `principal`. `access` is `read` or `write`, as the host decides; the
room reports it and enforces nothing with it.

| Limit                              | Value | Measured in |
| ---------------------------------- | ----- | ----------- |
| `PresenceProtocol.maxStateBytes`   | 1024  | UTF-8 bytes |
| `PresenceProtocol.maxFrameBytes`   | 2048  | UTF-8 bytes |
| `PresenceProtocol.maxParticipants` | 256   | connections |
| `PresenceProtocol.maxDataBytes`    | 512   | UTF-8 bytes |

## Close codes

| `CloseCode`   | Code | Sent when                                                     | Page reconnects |
| ------------- | ---- | ------------------------------------------------------------- | --------------- |
| `left`        | 1000 | The page left, or the host closed the room normally.          | No              |
| `unsupported` | 1003 | A binary or malformed frame, or a state over `maxStateBytes`. | No              |
| `noAccess`    | 1008 | The participant may not join, or lost access.                 | No              |
| `tooBig`      | 1009 | A frame over `maxFrameBytes`.                                 | No              |
| `changed`     | 1012 | The host changed this connection's identity or access.        | Yes             |
| `full`        | 1013 | The room already holds `maxParticipants` connections.         | Yes             |

`PresenceProtocol.isFinal(code)` is the "No" column. Any other close, including
1006 for a connection that dropped, reconnects after
`PresenceProtocol.reconnectDelay(attempt)`: 1 s, doubling to 30 s, at most 10
attempts in a row. A connection that receives a roster resets the count.

## The room keeps no state

`PresenceRoom` stores everything about a connection in its socket's
attachment: the connection id, the identity, the state, the host's data and a
join sequence. Every operation reads the room from the host's sockets.
A Cloudflare Durable Object that hibernates with its sockets open therefore
wakes with the room intact, and an idle watcher's tab costs no duration.

The host is structural. A `RoomSocket` has `send`, `close`,
`serializeAttachment` and `deserializeAttachment`, the shape of Alchemy's
`Cloudflare.WebSocket`. A `RoomHost` has `sockets`, every socket the host holds
open, such as `state.getWebSockets()`. A socket with no attachment, or an
attachment of another kind, is not part of the room.

The room authenticates no one. The host decides who a socket is before it
calls `join`, and calls `evict` when someone loses access.

| Function                         | What it does                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `join(host, socket, identity)`   | Joins an accepted socket and sends everyone the roster. Answers `full`, after closing the socket, at the cap. |
| `receive(host, socket, message)` | A valid state goes to everyone. A bad frame closes the socket, and the others hear without it.                |
| `leave(host, socket)`            | After the socket closed or failed: forgets it and tells the others. Idempotent.                               |
| `close(host, socket, code)`      | Closes one connection with `code` and tells the others.                                                       |
| `evict(host, principal, code?)`  | Closes every connection of `principal`, `noAccess` by default, tells the others once, answers the count.      |
| `connections(host)`              | Every joined connection in join order, with the host-only `data`.                                             |

`Identity.data` is the host's own note on a connection, at most
`maxDataBytes`, such as the session it authenticated. It never reaches a page.
Data over the cap, or joining one socket twice, is the host's bug and dies
with a `PlatformError` whose reason is `BadArgument`.

A send to a socket that already closed never fails the room. Workerd throws on
a send after close; the room drops that socket from the roster and tells the
rest again.

## Serve a room from a Durable Object

This sketch uses Alchemy's Durable Object handlers. The Worker in front of the
object authenticates the request and passes the identity in.

```ts
import * as PresenceRoom from "@smthrs/sync/PresenceRoom"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

export const room = Effect.gen(function*() {
  const state = yield* Cloudflare.DurableObjectState
  return Effect.gen(function*() {
    const host = { sockets: state.getWebSockets() }
    return {
      fetch: Effect.gen(function*() {
        const identity = yield* identityFromRequest // your authentication
        const [response, socket] = yield* Cloudflare.upgrade()
        yield* PresenceRoom.join(host, socket, identity)
        return response
      }),
      webSocketMessage: (socket, message) => PresenceRoom.receive(host, socket, message),
      webSocketClose: (socket) => PresenceRoom.leave(host, socket),
      webSocketError: (socket) => PresenceRoom.leave(host, socket),
      // Called by a revocation step.
      evict: (principal: string) => PresenceRoom.evict(host, principal)
    }
  })
})
```

## Follow a room from a page

`PresenceSocket.connect(url)` dials the room and keeps dialing it until its
scope closes. The page sets its state; the socket sends it when it can.

```ts
import * as PresenceSocket from "@smthrs/sync/PresenceSocket"
import * as Effect from "effect/Effect"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"

export const follow = Effect.gen(function*() {
  const room = yield* PresenceSocket.connect("wss://app.example/branches/42/presence")
  yield* room.set(JSON.stringify({ path: "src/main.ts", line: 12 }))
  yield* room.roster.pipe(
    Stream.runForEach((participants) => Effect.logInfo(`${participants.length} here`))
  )
}).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal))
```

- **Status.** `status` is `Connecting`, then `Open` with this connection's
  `self` id on the first roster, `Offline` with the attempt and code while it
  waits to redial, and `Closed` on a final code or after the last attempt.
- **Roster.** `roster` is the current participants, then every change. It is
  empty while the connection is not open.
- **State.** Only the latest state is kept. It goes out once the connection
  opens and again after every reconnect, because a fresh connection joins with
  a `null` state. A state the room already holds is not sent again. A state
  over `maxStateBytes` is the caller's bug and dies with a `PlatformError`
  whose reason is `BadArgument`.
- **Scope.** Closing the scope closes the socket with 1000 and stops
  redialing.

The socket comes from Effect's `Socket.WebSocketConstructor`. In a browser,
`Socket.layerWebSocketConstructorGlobal` provides the page's own `WebSocket`.

## Observability

Spans, metrics and logs carry connection ids and counts only, never a state, a
name or host data.

| Name                          | Kind                | Attributes                                   |
| ----------------------------- | ------------------- | -------------------------------------------- |
| `presence.join`               | span                | outcome, connection id, participant count    |
| `presence.evict`              | span                | close code, evicted count                    |
| `smithers_presence_joins`     | counter             | `outcome`: `joined`, `full`                  |
| `smithers_presence_frames`    | counter             | `outcome`: `state`, `unsupported`, `too_big` |
| `smithers_presence_evictions` | counter             | none                                         |
| `smithers_presence_open`      | up and down counter | none                                         |
