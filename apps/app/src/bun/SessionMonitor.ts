import * as Health from "@smthrs/control/Health"
import { Cause, Effect, Fiber } from "effect"
import type { PtySession } from "@smthrs/rpc/LocalApp"
import type { PtyManager } from "./Pty"
import { openLocalHealthJournal, type LocalHealthJournal } from "./LocalHealthJournal"

/** Trusted host callbacks; renderer requests can never register executable code. */
export interface SessionMonitorOptions {
  readonly manager: Pick<PtyManager, "list" | "get" | "replay" | "read">
  readonly configuration?: Health.HealthConfig
  readonly stateDir?: string
  readonly publish: (topic: string, message: unknown) => void
  readonly log?: (message: string) => void
}

interface ObservedSession {
  readonly incarnation: string
  state: "running" | "exited"
  updatedAt: number
  nextCheck: number
  failures: number
  sinceCursor: number
  latest?: Health.RecordedObservation
  published?: string
}

/**
 * A daemon-owned observational service. It cannot type into, resize, kill, or
 * restart a session. Evidence is committed before any status is published.
 */
export const createSessionMonitor = async (options: SessionMonitorOptions) => {
  const registry = Health.makeRegistry(options.configuration, "session")
  const monitorId = `local:${crypto.randomUUID()}`
  const sessions = new Map<string, ObservedSession>()
  let journal: Promise<LocalHealthJournal> | undefined
  let closed = false
  let stopping: Promise<void> | undefined
  const getJournal = () => journal ??= openLocalHealthJournal(options.stateDir).catch((error) => {
    journal = undefined
    throw error
  })
  const stateOf = (session: PtySession) => session.alive ? "running" as const : "exited" as const
  const observed = (session: PtySession): ObservedSession => {
    let state = sessions.get(session.sessionId)
    if (state === undefined) {
      state = {
        incarnation: `${monitorId}:${session.sessionId}`,
        state: stateOf(session),
        updatedAt: Date.now(),
        nextCheck: 0,
        failures: 0,
        sinceCursor: 0
      }
      sessions.set(session.sessionId, state)
    } else if (state.state !== stateOf(session)) {
      state.state = stateOf(session)
      state.updatedAt = Date.now()
      state.nextCheck = 0
    }
    return state
  }
  const status = (sessionId: string): Health.StatusRollup | undefined => {
    const session = options.manager.get(sessionId)
    if (session === undefined) return undefined
    const state = observed(session)
    return Health.rollup({
      subjectId: `session:${sessionId}`,
      state: stateOf(session),
      incarnation: state.incarnation,
      exitCode: session.exitCode ?? null,
      latest: state.latest,
      now: Date.now(),
      updatedAt: state.updatedAt,
      // PTY output can be a spinner. Cursor movement does not invalidate a
      // semantic report, just as it cannot establish semantic progress.
    })
  }
  const publish = (sessionId: string) => {
    if (closed) return
    const value = status(sessionId)
    const state = sessions.get(sessionId)
    if (value === undefined || state === undefined) return
    const encoded = JSON.stringify(value)
    if (encoded === state.published) return
    state.published = encoded
    options.publish(`pty:${sessionId}`, { type: "pty.status", sessionId, status: value })
  }

  const inspect = (session: PtySession) => Effect.gen(function*() {
    const state = observed(session)
    publish(session.sessionId)
    if (state.nextCheck > Date.now()) return
    const check = registry.resolve(session.roleId ?? session.harnessId ?? "terminal")
    const replay = options.manager.replay(session.sessionId)
    const evidenceSeq = replay?.cursor ?? 0
    const context: Health.ProbeContext = {
      subjectId: `session:${session.sessionId}`,
      state: stateOf(session),
      events: [],
      sinceCursor: state.sinceCursor,
      session: {
        alive: session.alive,
        exitCode: session.exitCode ?? null,
        outputCursor: evidenceSeq,
        ...(check.exposeOutput ? { outputTail: options.manager.read(session.sessionId, 4096)?.output ?? "" } : {})
      }
    }
    let observation = yield* Health.evaluate(check, context, {
      monitorId,
      incarnation: state.incarnation,
      evidenceSeq
    })
    const current = options.manager.get(session.sessionId)
    // Removal or lifecycle change during an effect invalidates its report. The
    // durable discarded record remains diagnostic evidence, never active state.
    if (current === undefined || stateOf(current) !== context.state || closed) {
      observation = { ...observation, outcome: "discarded", report: undefined, reason: "owner-changed" }
    }
    const previous = state.latest?.observation
    const changed = previous === undefined || previous.incarnation !== observation.incarnation ||
      previous.state !== observation.state || previous.checkerId !== observation.checkerId ||
      previous.outcome !== observation.outcome || previous.reason !== observation.reason ||
      JSON.stringify(previous.report) !== JSON.stringify(observation.report)
    // Keep the last committed stamp while an unchanged reading is coalesced.
    // Probe metrics still count every attempt; renewal occurs before expiry.
    const shouldRecord = changed || observation.outcome === "discarded" ||
      observation.observedAt >= previous!.observedAt + check.policy.ttlMs / 2
    const recorded = shouldRecord ? yield* Effect.tryPromise(async () => {
      const ledger = await getJournal()
      // Existing alert detectors consume these bounded projection fields.
      // The temporary sequence participates only in this pure fold; no
      // uncommitted provenance or version is persisted/published as fact.
      const projection = Health.rollup({
        subjectId: context.subjectId,
        state: stateOf(current ?? session),
        incarnation: state.incarnation,
        exitCode: current?.exitCode ?? session.exitCode ?? null,
        latest: { observation, sequence: 0 },
        now: observation.observedAt,
        updatedAt: state.updatedAt
      })
      return ledger.append(context.subjectId, monitorId, Health.statusObservedEventType, {
        ...observation,
        status: projection.state,
        activity: projection.activity,
        health: projection.health,
        attention: projection.attention,
        freshness: projection.freshness
      })
    }).pipe(Effect.catch(() => {
      options.log?.("health observation persistence failed")
      return Effect.succeed(undefined)
    })) : undefined
    if (recorded !== undefined && current !== undefined && !closed) {
      state.latest = { observation, sequence: recorded }
      state.updatedAt = observation.observedAt
    }
    state.sinceCursor = evidenceSeq
    const accepted = !shouldRecord || recorded !== undefined
    state.failures = observation.outcome === "ok" && accepted ? 0 : state.failures + 1
    const delay = Health.nextDelay(check.policy, state.failures)
    state.nextCheck = current?.alive === false && accepted ? Number.POSITIVE_INFINITY : Date.now() + delay
    publish(session.sessionId)
  })

  const probeLoop = Effect.gen(function*() {
    while (!closed) {
      const inventory = options.manager.list()
      // Rotate admission so a large inventory cannot starve later sessions.
      const admitted = inventory
        .sort((a, b) => (sessions.get(a.sessionId)?.nextCheck ?? 0) - (sessions.get(b.sessionId)?.nextCheck ?? 0))
        .slice(0, registry.limits.maxSubjects)
      yield* Effect.forEach(admitted, (session) => inspect(session).pipe(Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        options.log?.("health session check failed")
        observed(session).nextCheck = Date.now() + 5000
        return Effect.void
      })), { concurrency: registry.limits.maxConcurrentProbes, discard: true })
      yield* Effect.sleep(100)
    }
  })
  // Expiry and lifecycle are cheap projections of authoritative inventory;
  // neither may wait for probe admission, a slow checker, or a durable append.
  // This loop also releases removed subjects while a probe batch is blocked.
  const publicationLoop = Effect.gen(function*() {
    while (!closed) {
      const inventory = options.manager.list()
      const ids = new Set(inventory.map((session) => session.sessionId))
      for (const id of sessions.keys()) if (!ids.has(id)) sessions.delete(id)
      for (const session of inventory) publish(session.sessionId)
      yield* Effect.sleep(100)
    }
  })
  // One owner fiber scopes both loops, so cached stop interrupts and awaits
  // every checker/finalizer before closing the durable writer.
  const fiber = Effect.runFork(Effect.all([probeLoop, publicationLoop], { concurrency: 2, discard: true }))
  return {
    status,
    list: () => options.manager.list().map((session) => ({ ...session, status: status(session.sessionId) })),
    stop: () => stopping ??= (async () => {
      closed = true
      await Effect.runPromise(Fiber.interrupt(fiber))
      if (journal !== undefined) await (await journal).close()
    })()
  }
}

export type SessionMonitor = Awaited<ReturnType<typeof createSessionMonitor>>
