// Which Hyperdrive config each part of ChatApi's Worker reaches Postgres through (decision 0150). The request path
// (`requests`: ChatApi's own handlers, which read sessions, roles, repositories and shape access before they answer)
// has `ChatDatabase` to itself. Everything the durable engine does or delegates is background work and reads through
// `EngineDatabase`: `FlowExecution`, and the sandbox objects it calls (`SandboxObject`, `GateObject`), whose every
// database read (box admission and release, a person's subscription, an overflow box's model, the box's egress) serves
// a box the engine woke. The terminal's own authorization stays on the request path: ChatApi checks the session and
// the branch's sharing before it hands the socket to the object, which reads no table to attach it.

/** The two configs: `request` is `ChatDatabase`, `engine` is `EngineDatabase`. */
export type Pool = "request" | "engine"

/** Each consumer of a Hyperdrive config in ChatApi's Worker, and the config it reads through. */
export const ROUTES = {
  requests: "request",
  FlowExecution: "engine",
  SandboxObject: "engine",
  GateObject: "engine",
} as const satisfies Readonly<Record<string, Pool>>

/** A consumer named in `ROUTES`. */
export type Consumer = keyof typeof ROUTES

/** `consumer`'s config among `pools`. */
export const route = <A>(pools: Readonly<Record<Pool, A>>, consumer: Consumer): A => pools[ROUTES[consumer]]
