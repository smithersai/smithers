import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type * as ManagedRuntime from "effect/ManagedRuntime"

/*
 * Where an Effect meets a Web callback. Exactly three callers exist: the
 * Worker's native `fetch(request, env)` adapter (src/index.ts), the native
 * Durable Object classes' `fetch(request)`, and test helpers. Alchemy's
 * Effect-native bridge (src/Worker.ts) runs Effects itself and never comes
 * here.
 *
 * The request's AbortSignal interrupts the fiber: a client that disconnects
 * mid-turn interrupts the upstream fetch and runs every finalizer (the cancel
 * registry settles, the provider stream is released) instead of leaving
 * the work running. An interruption that reaches this boundary is answered
 * with 499, never restated as a 500. A defect (a bug, never a typed failure)
 * is logged and answered with a generic 500, so a route can never leak a
 * stack trace or hang the request (docs/worker-errors.md).
 */

/** The answer to a request whose caller went away before the response settled. */
export const CLIENT_DISCONNECTED_STATUS = 499

/** What a caller reads when a route failed in a way no contract names. */
export const UNEXPECTED_FAILURE_MESSAGE = "Smithers could not complete this request. Try again in a moment."

/*
 * The boundary's own answers carry the isolation headers every JSON answer of
 * this Worker carries (src/Responses.ts): the app document that made the
 * request is cross-origin isolated, and a 499 or 500 must not read as a
 * different origin's page.
 */
const answer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  })

const clientDisconnected = (): Response => answer(CLIENT_DISCONNECTED_STATUS, { status: "error", message: "The client disconnected." })

/**
 * One request handler's outcome as the Response the caller gets. Success is
 * the route's own answer; an interruption is 499 and never restated as a 500;
 * anything else is a defect, logged once and answered generically.
 *
 * This is the boundary's whole policy, kept pure and exported because there
 * are two entrypoints — the native adapter below (src/index.ts) and Alchemy's
 * Effect-native bridge (src/Worker.ts), which runs the fiber itself and so
 * cannot call `runRequest`. One implementation, so the deployed path and the
 * tested path cannot drift.
 */
export const responseFromExit = (exit: Exit.Exit<Response, never>): Response => {
  if (Exit.isSuccess(exit)) return exit.value
  if (Cause.hasInterruptsOnly(exit.cause)) return clientDisconnected()
  console.error("worker fetch failed:", Cause.squash(exit.cause))
  return answer(500, { status: "error", message: UNEXPECTED_FAILURE_MESSAGE })
}

/** The 499 a caller reads when it went away before the response settled. */
export const clientDisconnectedResponse = (): Response => clientDisconnected()

/**
 * Run a request handler to a `Response`. Typed failures must already be
 * mapped to responses (the handler's error channel is `never`). With a
 * `runtime` the handler runs against that runtime's services, which is how
 * per-isolate state (caches, single-flight) survives across requests.
 */
export const runRequest = <R = never>(
  effect: Effect.Effect<Response, never, R>,
  signal?: AbortSignal,
  runtime?: ManagedRuntime.ManagedRuntime<R, never>
): Promise<Response> => {
  if (signal?.aborted === true) return Promise.resolve(clientDisconnected())
  const fiber = runtime === undefined
    ? Effect.runFork(effect as Effect.Effect<Response, never>)
    : runtime.runFork(effect)
  const onAbort = () => {
    fiber.interruptUnsafe()
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  return Effect.runPromise(Fiber.await(fiber)).then((exit) => {
    signal?.removeEventListener("abort", onAbort)
    return responseFromExit(exit)
  })
}

/**
 * A fiber's completion as the promise the platform's `waitUntil` takes. It
 * never rejects: the exit carries the outcome, and workerd only needs to
 * know when the work is over.
 */
export const fiberPromise = <A, E>(fiber: Fiber.Fiber<A, E>): Promise<Exit.Exit<A, E>> => Effect.runPromise(Fiber.await(fiber))

/** Run an Effect with no failure channel to a Promise, for a Durable Object's own `fetch`. */
export const runDurable = <A>(effect: Effect.Effect<A, never>): Promise<A> => Effect.runPromise(effect)
