// Which Hyperdrive config each part of ChatApi's Worker reaches Postgres through (decision 0150). The request path
// (`requests`: ChatApi's own handlers, which read sessions, roles, repositories and shape access before they answer)
// has `ChatDatabase` to itself. Everything the durable engine does or delegates is background work and reads through
// `EngineDatabase`: `FlowExecution`, and the sandbox objects it calls (`SandboxObject`, `GateObject`), whose every
// database read (box admission and release, a person's subscription, an overflow box's model, the box's egress) serves
// a box the engine woke. Socket authorization stays on the request path: ChatApi checks the session and the branch's
// sharing before it hands a socket to its object, and each socket host renews that socket's lease by the same rules
// (worker/SocketChecks.ts) through `ChatDatabase`: the transcript's `RunContent`, the rooms' `RoomObject`, and the
// sandbox objects' terminal sockets (`SocketChecks`).

/** The two configs: `request` is `ChatDatabase`, `engine` is `EngineDatabase`. */
export type Pool = "request" | "engine"

/** Each consumer of a Hyperdrive config in ChatApi's Worker, and the config it reads through. */
export const ROUTES = {
  requests: "request",
  FlowExecution: "engine",
  SandboxObject: "engine",
  GateObject: "engine",
  RoomObject: "request",
  RunContent: "request",
  SocketChecks: "request",
} as const satisfies Readonly<Record<string, Pool>>

/** A consumer named in `ROUTES`. */
export type Consumer = keyof typeof ROUTES

/** `consumer`'s config among `pools`. */
export const route = <A>(pools: Readonly<Record<Pool, A>>, consumer: Consumer): A => pools[ROUTES[consumer]]
