import { IndexedDBAdapter } from "@tanstack/offline-transactions"
import SqliteFactory from "@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"
import { Effect, Stream } from "effect"
import { boundFetch, IDENTITY_MESSAGE, type Binding, type Receipt, sessionNow } from "../device/identity.vibe"
import { SESSION_ROUTE } from "../features/auth/contract"
import { OUTBOX_DATABASE } from "./contract"
import type { Endpoint } from "./tabPort.vibe"

/** Browser capabilities at the engine worker boundary. */
export interface EngineWorkerHost {
  readonly scope: Endpoint
  readonly origin: string
  readonly name: string
  readonly unbound: typeof fetch
  readonly sessionAddress: string
  readonly requests: Stream.Stream<MessageEvent>
  readonly broadcast: (receipt: Receipt) => Effect.Effect<void>
  readonly report: (receipt: Receipt) => void
  readonly sessionNow: Effect.Effect<Awaited<ReturnType<typeof sessionNow>>>
  readonly bindFetch: (binding: Pick<Binding, "principal" | "sessionTag">) => void
}

type WorkerScope = Endpoint & {
  readonly location: { readonly origin: string }
  readonly name: string
  fetch: typeof fetch
}

export const workerHost = (scope: WorkerScope = self): EngineWorkerHost => {
  const identity = new BroadcastChannel(IDENTITY_MESSAGE)
  // In Node's worker harness the native channel must not keep the process alive.
  ;(identity as { unref?: () => void }).unref?.()
  const unbound = scope.fetch.bind(scope)
  const origin = scope.location.origin
  return {
    scope,
    origin,
    name: scope.name,
    unbound,
    sessionAddress: origin + SESSION_ROUTE,
    requests: Stream.fromEventListener<MessageEvent>(identity, "message"),
    broadcast: (receipt: Receipt) => Effect.sync(() => identity.postMessage(receipt)),
    report: (receipt: Receipt) => {
      scope.postMessage(receipt)
      identity.postMessage(receipt)
    },
    sessionNow: Effect.promise(() =>
      unbound(origin + SESSION_ROUTE, { cache: "no-store", signal: AbortSignal.timeout(10_000) })
        .then(sessionNow, () => "unreachable" as const),
    ),
    bindFetch: (binding: Pick<Binding, "principal" | "sessionTag">) => {
      const credentialStorage = new IndexedDBAdapter(OUTBOX_DATABASE, "transactions")
      scope.fetch = boundFetch(unbound, {
        origin,
        ...binding,
        credentialStorage,
        withCredential: (action, signal) => navigator.locks.request("smithers-credential-state", signal === undefined ? {} : { signal }, action),
      })
    },
  }
}

/** SQLite loads only for the worker that leads. @throws {never} */
export const sqliteModule = async () => ({ default: SqliteFactory })

// The production worker never loads the end-to-end session fault switch.
export const loadSessionFaults = import.meta.env.DEV ? () => import("../test/authFaults") : undefined
