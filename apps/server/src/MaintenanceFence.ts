import { Effect } from "effect"
import { runDurable } from "./Boundary"
import { ALARM_MARKER_TABLE, EXPORT_PATH, maintenanceExport, sqlOf, withSealedExport, type EXPORT_BINDINGS, type MaintenanceEnv, type MarkerSql } from "./MaintenanceExport"
export { ALARM_MARKER_TABLE } from "./MaintenanceExport"

/** One-time cutover identity, embedded in the reviewed temporary module. */
export interface FenceIdentity {
  readonly executionID: string
  readonly smithersRevision: string
  readonly plueRevision: string
  readonly endpoint: string
  readonly worker: string
  readonly sourceVersion: string
  readonly sourceArtifactSHA256: string
}
export const fenceRefusal = (identity: FenceIdentity): Response => Response.json({ code: "cutover_maintenance", ...identity }, {
  status: 503, headers: { "cache-control": "no-store", "retry-after": "60" }
})

export interface InterruptedAlarmMarker {
  readonly schema: "smithers-cutover-alarm/v1"
  readonly state: "interrupted-unresolved"
  readonly executionID: string
  readonly worker: string
  readonly binding: string
  readonly objectId: string
  readonly sourceVersion: string
  readonly sourceArtifactSHA256: string
  /** getAlarm() is null inside alarm(), so only an upper bound on the scheduled time is observable. */
  readonly scheduledNoLaterThan: string
  readonly firstObservedAt: string
  readonly lastObservedAt: string
  readonly observations: number
  readonly lastRetryCount: number
}
export interface FencedContext {
  readonly id?: { readonly toString: () => string }
  readonly storage?: { readonly sql?: MarkerSql; readonly sync?: () => Promise<void> }
}
/**
 * Records one fenced alarm delivery. Statements run without an intervening
 * await, so the platform commits them as one implicit write. Rows of earlier
 * executions are never overwritten.
 */
export const recordInterruptedAlarm = (ctx: FencedContext, identity: FenceIdentity, binding: string, retryCount: number, now: Date): InterruptedAlarmMarker | null => {
  const sql = sqlOf(ctx.storage)
  if (!sql || !ctx.id) return null
  sql.exec(`CREATE TABLE IF NOT EXISTS ${ALARM_MARKER_TABLE} (execution_id TEXT PRIMARY KEY, marker TEXT NOT NULL)`)
  const prior = sql.exec(`SELECT marker FROM ${ALARM_MARKER_TABLE} WHERE execution_id = ?`, identity.executionID).toArray()[0]
  const previous = prior ? JSON.parse(String(prior.marker)) as InterruptedAlarmMarker : null
  const at = now.toISOString()
  const marker: InterruptedAlarmMarker = previous
    ? { ...previous, lastObservedAt: at, observations: previous.observations + 1, lastRetryCount: retryCount }
    : { schema: "smithers-cutover-alarm/v1", state: "interrupted-unresolved", executionID: identity.executionID, worker: identity.worker, binding, objectId: ctx.id.toString(),
      sourceVersion: identity.sourceVersion, sourceArtifactSHA256: identity.sourceArtifactSHA256, scheduledNoLaterThan: at, firstObservedAt: at, lastObservedAt: at, observations: 1, lastRetryCount: retryCount }
  sql.exec(`INSERT INTO ${ALARM_MARKER_TABLE} (execution_id, marker) VALUES (?, ?) ON CONFLICT(execution_id) DO UPDATE SET marker = excluded.marker`, identity.executionID, JSON.stringify(marker))
  return marker
}

/** Final fence only: the operator must prove admitted work drained BEFORE installing it. */
export const fencedDurable = (identity: FenceIdentity, binding: typeof EXPORT_BINDINGS[number]) => {
  // Deliberately no inheritance/import of the old class. RPC methods, constructors,
  // WebSocket callbacks and alarms must not retain the previous writer authority.
  class StoppedObject {
    constructor(private readonly fencedContext: FencedContext) {}
    fetch(_request: Request): Promise<Response> { // effect-policy: boundary
      return runDurable(Effect.succeed(fenceRefusal(identity)))
    }
    /**
     * Never runs the legacy callback and never acknowledges: the platform retries
     * a throwing alarm a bounded number of times, then drops it. The marker is
     * flushed first so the interrupted alarm outlives that drop and any restore.
     */
    alarm(info?: { readonly retryCount?: number }): Promise<never> { // effect-policy: boundary
      const ctx = this.fencedContext
      return runDurable(Effect.gen(function* () {
        const marker = yield* Effect.sync(() => recordInterruptedAlarm(ctx, identity, binding, info?.retryCount ?? 0, new Date()))
        if (marker && ctx.storage?.sync) yield* Effect.tryPromise({ try: () => ctx.storage!.sync!(), catch: () => new Error("cutover_alarm_marker_unsynced") }).pipe(Effect.orDie)
        return yield* Effect.die(new Error("cutover_maintenance"))
      }))
    }
    webSocketMessage(socket: { close(code: number, reason: string): void }): Promise<void> { // effect-policy: boundary
      return runDurable(Effect.sync(() => socket.close(1012, "cutover_maintenance")))
    }
    webSocketClose(): void {}
    webSocketError(): void {}
  }
  return withSealedExport(StoppedObject, binding)
}

export const fencedWorker = (identity: FenceIdentity) => ({
  fetch(request: Request, env: MaintenanceEnv): Response | Promise<Response> { // effect-policy: boundary
    return new URL(request.url).pathname === EXPORT_PATH ? maintenanceExport(request, env) : fenceRefusal(identity)
  },
  scheduled(): never { throw new Error("cutover_maintenance") },
  queue(batch: { retryAll(): void }): never {
    // Never acknowledge metering or DLQ messages just to obtain an empty queue.
    batch.retryAll()
    throw new Error("cutover_maintenance")
  }
})

interface LegacyWorker {
  fetch(request: Request, env: MaintenanceEnv, ctx: unknown): Response | Promise<Response>
  queue?(batch: unknown, env: MaintenanceEnv, ctx: unknown): unknown
}
/** Keep only the exact settlement doors needed by already admitted work. */
export const admissionDrainRoute = (worker: string, request: Request): boolean => {
  const path = new URL(request.url).pathname
  if (request.method !== "POST") return false
  return worker === "smithers-cloud-billing" && ["/api/billing/charges", "/webhooks/stripe"].includes(path) ||
    worker === "smithers-cloud-identity" && path === "/api/identity/cloud-token" ||
    worker === "smithers-mvp-web" && path === "/api/chat/cancel"
}
/** Admission phase preserves original alarms/RPC and the existing queue consumer. */
export const admissionWorker = (identity: FenceIdentity, legacy: LegacyWorker) => ({
  fetch(request: Request, env: MaintenanceEnv, ctx: unknown): Response | Promise<Response> { // effect-policy: boundary
    if (new URL(request.url).pathname === EXPORT_PATH) return maintenanceExport(request, env)
    if (admissionDrainRoute(identity.worker, request)) return legacy.fetch(request, env, ctx)
    return Response.json({ code: "cutover_admission_closed", ...identity }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } })
  },
  scheduled(): never { throw new Error("cutover_admission_closed") },
  queue(batch: unknown, env: MaintenanceEnv, ctx: unknown): unknown {
    if (identity.worker !== "smithers-cloud-chat-canary" || !legacy.queue) throw new Error("cutover_queue_consumer_unknown")
    return legacy.queue(batch, env, ctx)
  }
})
