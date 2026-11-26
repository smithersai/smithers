import { Context, Effect, Layer, Ref } from "effect"
import { AuthClient, AuthUnreachable } from "../features/auth/api.vibe"

// The session read behind a switch, for the end-to-end tests of a ChatApi that can't say who is signed in
// (docs/rules.md, test.faults-by-injection). The page's switch (`AuthFaults`, on `window.faults.session`) and its
// engine worker's (`faultySession`) answer every session read with a gateway's 503 while down; healing the page's heals
// the worker's, over a BroadcastChannel, since the worker reads the session for the device's owner itself. Nothing
// intercepts a request: while healed, the real client asks the real ChatApi. Production never loads this file.

/** The channel a page's switch tells its engine workers' switches on. */
export const AUTH_FAULTS_CHANNEL = "smithers-test/auth-faults"

/** The switch of the faulty sign-in client: `down` makes every session read answer 503 until `heal`. */
export class AuthFaults extends Context.Service<
  AuthFaults,
  { readonly down: Effect.Effect<void>; readonly heal: Effect.Effect<void> }
>()("@smthrs/mvp/test/AuthFaults") {}

/** A gateway's answer while the switch is down: ChatApi can't say who is signed in. */
const refused = new AuthUnreachable({ status: 503 })

/**
 * Sign-in's client as the layer below gives it, behind `AuthFaults`: down from the start when `down`. Throwing the
 * switch throws the engine workers' too.
 */
export const faultyAuth = (down: boolean) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const real = yield* AuthClient
      const failing = yield* Ref.make(down)
      const workers = yield* Effect.acquireRelease(
        Effect.sync(() => new BroadcastChannel(AUTH_FAULTS_CHANNEL)),
        (channel) => Effect.sync(() => channel.close()),
      )
      const set = (value: boolean) =>
        Ref.set(failing, value).pipe(Effect.andThen(Effect.sync(() => workers.postMessage(value ? "down" : "heal"))))
      return Context.make(
        AuthClient,
        AuthClient.of({ ...real, session: Effect.flatMap(Ref.get(failing), (on) => (on ? Effect.fail(refused) : real.session)) }),
      ).pipe(Context.add(AuthFaults, AuthFaults.of({ down: set(true), heal: set(false) })))
    }),
  )

/**
 * The engine worker's session read, `real`, behind the page's switch: down from the start when `down`, and thrown
 * whenever the page's is. The worker keeps it for as long as it runs.
 */
export const faultySession = <A>(real: Effect.Effect<A, AuthUnreachable>, down: boolean) => {
  let failing = down
  const page = new BroadcastChannel(AUTH_FAULTS_CHANNEL)
  page.onmessage = (event) => {
    failing = event.data === "down"
  }
  // Node's channel would keep a test's process open; a browser's has no `unref`.
  ;(page as { unref?: () => void }).unref?.()
  return Effect.suspend(() => (failing ? Effect.fail(refused) : real))
}
