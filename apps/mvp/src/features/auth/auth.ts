import { Context, Deferred, Effect, Layer, Queue, Stream } from "effect"
import { runners } from "../../boundary"
import { check, load, pressSignIn, refresh, restore, signOut } from "./actions"
import type { AuthClient } from "./api"
import type { DeviceWipe } from "./device"
import { AuthStore } from "./store"

// Sign-in as a frontend sees it: a live query to read and plain functions to act, with no Effect in sight. React
// renders the query with `useLiveQuery` and calls the actions from event handlers.

type Store = AuthStore["Service"]

/**
 * What a frontend reads: who is signed in, as one live row, and the last session ChatApi confirmed on this device, so
 * a page reloaded offline still knows who asks (`composerAccess` in contract.ts reads both).
 */
export interface AuthQueries {
  readonly session: Store["sessionState"]["tanstack"]
  readonly confirmed: Store["confirmedState"]["tanstack"]
}

/** What a person does, as plain functions. Each returns at once. */
export interface AuthActions {
  /** "Sign in with GitHub" pressed: the link goes to GitHub; this records it. */
  readonly pressSignIn: () => void
  readonly signOut: () => void
  /** Asks ChatApi again who is signed in. */
  readonly reload: () => void
}

export class Auth extends Context.Service<Auth, { readonly queries: AuthQueries; readonly actions: AuthActions }>()(
  "@smthrs/mvp/auth/Auth",
) {
  /**
   * Binds the store's queries and actions for frontends and restores the device's confirmed session. The scoped
   * session lifecycle subscribes before its initial server read. Each action runs with this layer's services
   * (`runners`, src/boundary.ts). A sign-out ChatApi takes wipes the device through `DeviceWipe`.
   */
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const store = yield* AuthStore
      const { runSync: run } = runners(yield* Effect.context<AuthStore | AuthClient | DeviceWipe>(), "auth")
      const reload = Effect.asVoid(Effect.forkIn(load, store.scope, { startImmediately: true }))
      yield* Effect.forkIn(restore, store.scope, { startImmediately: true })
      return Auth.of({
        queries: { session: store.sessionState.tanstack, confirmed: store.confirmedState.tanstack },
        actions: {
          pressSignIn: () => run(pressSignIn),
          signOut: () => run(signOut),
          reload: () => run(reload),
        },
      })
    }),
  )
}

/** The sign-in layer's value: what frontends get. */
export type AuthView = Auth["Service"]

/**
 * Checks the session as the app opens and whenever `target` (the window) comes back online, one check at a time, within
 * the application's scope. A check ChatApi couldn't answer starts `auth/refresh`, which asks again until it does, so a
 * failed first check recovers with no event, click or reload (`refresh`). The host can reauthorize an unverified boot.
 */
export const bindSessionConnectivity = (target: EventTarget) => Effect.gen(function* () {
  const listening = yield* Deferred.make<void>()
  const source = Stream.callback<"startup" | "online">((queue) => Effect.gen(function* () {
    const online = () => { Queue.offerUnsafe(queue, "online") }
    yield* Effect.acquireRelease(
      Effect.sync(() => target.addEventListener("online", online)),
      () => Effect.sync(() => target.removeEventListener("online", online)),
    )
    // Subscribe before admitting the initial read, so an earlier network transition needs no second event.
    yield* Queue.offer(queue, "startup")
    yield* Deferred.succeed(listening, undefined)
  }))
  yield* source.pipe(Stream.runForEach((via) => check(via).pipe(
    Effect.flatMap((outcome) => outcome === "unreachable" ? refresh : Effect.void),
  )), Effect.ensuring(Effect.logInfo("auth.session_subscription").pipe(Effect.annotateLogs({ stage: "stopped" }))), Effect.forkScoped({ startImmediately: true }))
  yield* Deferred.await(listening)
  yield* Effect.logInfo("auth.session_subscription").pipe(Effect.annotateLogs({ stage: "listening" }))
})
