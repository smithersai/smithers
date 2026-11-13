/**
 * Run ownership arbitration: liveness evidence, probes, and heartbeat
 * supervision.
 *
 * The identity being arbitrated — {@link OwnerId} — is defined by
 * `@smthrs/journal`, because it is the fencing token the journal accepts on
 * durable appends. It is re-exported here so ownership callers keep reading it
 * as one vocabulary.
 *
 * @since 0.1.0
 */

import { LivenessEvidence } from "@smthrs/journal/Consensus"
import { OwnerId } from "@smthrs/journal/OwnerId"
import { Cause, Clock, Duration, Effect, Semaphore } from "effect"
import { heartbeatInterval, heartbeatStaleAfter, heartbeatWriteTolerance } from "./Heartbeat.ts"
import { RunStore } from "./RunStore.ts"

export {
  /**
   * A process identity scoped to a host and a unique ownership nonce, defined
   * by `@smthrs/journal` as the fence on durable appends.
   *
   * @since 0.1.0
   * @category models
   */
  OwnerId
}

export {
  /**
   * Evidence that the owner in an exact run snapshot is no longer live.
   *
   * Defined by `@smthrs/journal`'s `Consensus`, because R5 — steal requires
   * staleness plus liveness evidence — is a consensus rule every strategy
   * validates. Two of the three kinds are collected outside the store:
   * `same-host-pid-dead` is a local process probe, and
   * `cross-host-unreachable-stale` is a reachability judgement the deployment
   * makes. `lease-expired` is different — it asserts only that the persisted
   * heartbeat is older than the staleness cutoff, which is the one claim the
   * strategy can check for itself, and `steal` checks it: the takeover
   * refuses any lease whose heartbeat is still inside the window. It is
   * therefore accepted from a claimant on any host, while the other two stay
   * bound to the host relation that makes them meaningful. The observation
   * must carry the exact instant supplied to the consuming operation:
   * `checkedAtMs` must equal that operation's `nowMs`. A caller that probes
   * at T and calls at T+1 is refused and must build fresh evidence.
   *
   * @since 0.1.0
   * @category models
   */
  LivenessEvidence
}

/**
 * Evidence-factory signature a composition uses for ownership arbitration.
 *
 * A `LivenessProbe` returns `LivenessEvidence` or `undefined` for `steal`,
 * `claimAndOwn`, and `recoverClaim` to verify. {@link LivenessCheck} is the
 * separate alive-or-not question the engine asks before it decides to steal.
 * `RunStore` validates supplied evidence and never probes a process or network
 * itself.
 *
 * @since 0.1.0
 * @category models
 */
export type LivenessProbe<E = never, R = never> = (
  expectedOwner: OwnerId,
  claimant: OwnerId,
  checkedAtMs: number
) => Effect.Effect<LivenessEvidence | undefined, E, R>

/**
 * What a liveness check knows about the run it is asked about, beyond the
 * owner recorded on it.
 *
 * The lease is here because it is the only liveness signal every deployment
 * has: `heartbeatAtMs` is the last heartbeat the owner persisted, `nowMs` is
 * the reading the arbitration is made against, and `claimant` is the identity
 * that would take the run over. A check that wants to probe a pid compares
 * hosts with {@link sameHostIncarnation} first; a check that has nothing but
 * the lease uses {@link leaseLiveness}.
 *
 * @since 0.1.0
 * @category models
 */
export interface LivenessContext {
  readonly claimant: OwnerId
  readonly heartbeatAtMs: number | null
  readonly nowMs: number
}

/**
 * The question ownership arbitration asks before it steals a run: is the
 * recorded owner still working?
 *
 * Answering `true` refuses the takeover. The engine consults this only for a
 * run whose lease has already expired, so a check that has no better evidence
 * than the lease answers `false` there — which is exactly what
 * {@link leaseLiveness} does.
 *
 * @since 0.1.0
 * @category models
 */
export type LivenessCheck = (
  expectedOwner: OwnerId,
  context: LivenessContext
) => Effect.Effect<boolean>

/**
 * Whether two owner identities are incarnations on the same host.
 *
 * The predicate a probe applies before it inspects a pid: `owner.pid` names a
 * process in the claimant's own process namespace only when the hosts match,
 * so a cross-host probe that read it would be answering about an unrelated
 * process. Exposed because the check that needs it — a
 * `process.kill(pid, 0)` probe — belongs to a platform package rather than
 * here.
 *
 * @since 0.1.0
 * @category ownership
 */
export const sameHostIncarnation = (
  expectedOwner: OwnerId,
  claimant: OwnerId
): boolean => expectedOwner.hostId === claimant.hostId

/**
 * The default liveness check: the lease, and nothing else.
 *
 * An owner is treated as alive for as long as its persisted heartbeat is
 * younger than `staleAfter`, and as gone once it is not. That is the weakest
 * honest answer, and it is the one every host can give: a fresh process with
 * no application code at all can reclaim a hard-killed owner's runs once the
 * lease it stopped renewing has expired. A deployment that can say more — a
 * pid probe on the owner's host, an orchestrator that reports pod liveness —
 * supplies its own {@link LivenessCheck} and refuses the takeover for longer.
 *
 * An owner with no recorded heartbeat holds no lease and is reported gone; the
 * steal it enables is still gated by the store's own snapshot compare-and-swap.
 *
 * @since 0.1.0
 * @category ownership
 */
export const leaseLiveness = (
  staleAfter: Duration.Input = heartbeatStaleAfter
): LivenessCheck => {
  const staleAfterMs = Duration.toMillis(staleAfter)
  return (_expectedOwner, context) =>
    Effect.succeed(
      context.heartbeatAtMs !== null &&
        context.heartbeatAtMs >= context.nowMs - staleAfterMs
    )
}

const lease = leaseLiveness()

/**
 * The liveness check for a host that runs one incarnation at a time.
 *
 * Such a host builds its engine only while it holds an exclusive claim: a
 * Cloudflare Durable Object inside its alarm, a browser engine inside the
 * worker that holds its origin's Web Lock. An owner recorded under the
 * claimant's own host id with another `pid` or `nonce` is an earlier
 * incarnation whose claim has ended, so it is dead, and the engine takes its
 * runs at once instead of waiting out the lease. Every other owner, the
 * claimant included, is judged by {@link leaseLiveness} alone.
 *
 * Two Node engines over one database can share a host id and both be alive,
 * so a Node host uses `HostLiveness.sameHostPidProbe` from
 * `@smthrs/platform-node` instead.
 *
 * @since 1.0.0-rc.16
 * @category ownership
 */
export const singleIncarnationLiveness: LivenessCheck = (expectedOwner, context) =>
  sameHostIncarnation(expectedOwner, context.claimant) &&
    (expectedOwner.pid !== context.claimant.pid || expectedOwner.nonce !== context.claimant.nonce)
    ? Effect.succeed(false)
    : lease(expectedOwner, context)

export {
  /**
   * How often the supervision loop pulses to renew the owner's lease.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatInterval,
  /**
   * How far the owner's wall clock may run behind a peer's before the lease
   * reasoning stops holding.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatSkewAllowance,
  /**
   * How old a persisted heartbeat must be before a peer may steal the run.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatStaleAfter,
  /**
   * How long the owner may keep working through failing or stalled heartbeat writes.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatWriteTolerance
} from "./Heartbeat.ts"

/**
 * Hooks a {@link heartbeatLoop} caller may supply.
 *
 * @since 1.0.0
 * @category models
 */
export interface HeartbeatLoopOptions {
  /** Called after a fenced pulse. The caller must keep this nonblocking so
   * external receipts cannot hold ownership supervision. */
  readonly onPulse?: (() => Effect.Effect<void>) | undefined
  /** Called after the same unclaimed owner reconfirms an expired heartbeat budget. */
  readonly onReconfirm?: ((unconfirmedMs: number) => Effect.Effect<void>) | undefined
  /** Called with the unconfirmed milliseconds when the lease lapses, before the loop interrupts itself. */
  readonly onLapse?: ((unconfirmedMs: number) => Effect.Effect<void>) | undefined
}

/**
 * Runs heartbeats until the persisted ownership fence is lost, then interrupts
 * itself. Race this effect with owned work so structured concurrency
 * interrupts the work when ownership disappears.
 *
 * Each pulse drives the injected `Consensus` strategy's `heartbeat` through
 * `RunStore.heartbeat`, which renews the strategy's lease and mirrors the
 * recorded stamp onto the run row in the same transaction. Heartbeats are
 * lease evidence, never journal events.
 *
 * Pulses are delayed by `heartbeatInterval` and read the Effect `Clock`, so the
 * loop is fully driveable with `TestClock`.
 *
 * A lost fence — any outcome other than `Updated` — is durable evidence and
 * interrupts immediately. A failed heartbeat *write* is not: the persisted
 * heartbeat is still there and no other process may steal the run until it is
 * `heartbeatStaleAfter` old, so transient write errors are tolerated for
 * `heartbeatWriteTolerance` — deliberately shorter than the steal cutoff by a
 * pulse plus `heartbeatSkewAllowance`. The reserved pulse bounds a final
 * reconfirmation; a pending claim or changed owner fails that check. Past that allowance
 * the fence still protects durable writes but non-durable side effects may
 * overlap; see {@link heartbeatWriteTolerance}.
 *
 * An independent deadline races the pulse loop. At expiry it reconfirms the
 * same owner with no pending claim, bounded by one heartbeat interval. A
 * renewed lease continues supervision; loss, error, or timeout interrupts
 * even when an ordinary heartbeat write never returns. Each successful
 * pulse re-arms the deadline from the timestamp sent to the store, not from
 * its completion time. The deadline re-reads the clock after waking, so delayed
 * writes cannot hide expiry behind a stale clock reading.
 *
 * `options.onReconfirm` records a successful reconfirmation after a gap. Its
 * deadline is the remaining renewed lease budget, measured from the timestamp
 * sent to the store. A blocked or failed receipt lapses the lease instead of
 * stranding supervision; receipt completion never grants another lease budget.
 * `options.onLapse` runs once, before the self-interrupt, when reconfirmation
 * fails: it receives how long the lease went unconfirmed, so the caller can
 * record why its work stopped. A lost fence does not call it.
 *
 * @since 0.1.0
 * @category supervision
 */
export const heartbeatLoop = (
  runId: string,
  owner: OwnerId,
  options: HeartbeatLoopOptions = {}
): Effect.Effect<never, never, RunStore> =>
  Effect.gen(function*() {
    const runStore = yield* RunStore
    const toleranceMs = Duration.toMillis(heartbeatWriteTolerance)
    const intervalMs = Duration.toMillis(heartbeatInterval)
    let lastConfirmedPulseMs = yield* Clock.currentTimeMillis
    let failing = false
    // Both overdue timers may wake after a host stall. Serialize expiry and
    // recheck the budget so they cannot reconfirm or journal the same gap twice.
    const expiry = yield* Semaphore.make(1)
    const expire = () =>
      expiry.withPermit(Effect.gen(function*() {
        // A competing expiry may have held the permit across a write. Take
        // fresh evidence after acquisition, never the waiting timer's reading.
        const nowMs = yield* Clock.currentTimeMillis
        if (nowMs - lastConfirmedPulseMs < toleranceMs) return
        const unconfirmedMs = nowMs - lastConfirmedPulseMs
        const renewed = yield* runStore.reconfirm(runId, owner, Math.floor(nowMs)).pipe(
          // Only the ownership check consumes the old lease's reserved pulse.
          Effect.timeout(heartbeatInterval),
          Effect.flatMap((outcome) =>
            Effect.gen(function*() {
              if (outcome._tag !== "Updated") return false
              lastConfirmedPulseMs = Math.max(lastConfirmedPulseMs, Math.floor(nowMs))
              failing = false
              yield* options.onPulse?.() ?? Effect.void
              const confirmedAtMs = yield* Clock.currentTimeMillis
              const remainingMs = lastConfirmedPulseMs + toleranceMs - confirmedAtMs
              if (remainingMs <= 0) return false
              // The receipt is still required and bounded, but ownership was
              // already renewed. Spending only its old reserved pulse would
              // interrupt live work despite a fresh, fenced persisted lease.
              yield* (options.onReconfirm?.(unconfirmedMs) ?? Effect.void).pipe(Effect.timeout(remainingMs))
              return true
            })
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.succeed(false)
          )
        )
        if (renewed) return
        return yield* Effect.logWarning("run lease lapsed; interrupting owned work").pipe(
          Effect.annotateLogs({ runId, unconfirmedMs }),
          Effect.andThen(options.onLapse?.(unconfirmedMs) ?? Effect.void),
          Effect.andThen(Effect.interrupt)
        )
      }))
    const deadline = Effect.gen(function*() {
      while (true) {
        const nowMs = yield* Clock.currentTimeMillis
        const remainingMs = lastConfirmedPulseMs + toleranceMs - nowMs
        if (remainingMs <= 0) {
          yield* expire()
          continue
        }
        // Check alongside pulse intervals, with a shorter final wait when needed.
        yield* Effect.sleep(Math.min(remainingMs, intervalMs))
      }
    })
    const pulses = Effect.sleep(heartbeatInterval).pipe(
      Effect.andThen(Clock.currentTimeMillis.pipe(Effect.map(Math.floor))),
      Effect.flatMap((nowMs) =>
        nowMs - lastConfirmedPulseMs >= toleranceMs ? expire() : runStore.heartbeat(runId, owner, nowMs).pipe(
          Effect.flatMap((outcome) =>
            outcome._tag === "Updated"
              ? Effect.sync(() => {
                lastConfirmedPulseMs = Math.max(lastConfirmedPulseMs, nowMs)
                failing = false
              }).pipe(Effect.andThen(options.onPulse?.() ?? Effect.void))
              : Effect.interrupt
          ),
          // A failed write keeps the confirmed lease; the independent deadline
          // supervises its expiry. Warn on the first failure of an outage.
          Effect.catch((error) => {
            if (failing) return Effect.void
            failing = true
            return Effect.logWarning("run heartbeat write failed").pipe(
              Effect.annotateLogs({ runId, code: error.code })
            )
          })
        )
      ),
      Effect.forever
    )
    return yield* Effect.raceFirst(pulses, deadline)
  })
