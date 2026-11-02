import { Clock, Config, Deferred, Effect, Metric, Option, Schema } from "effect"
import { Headers, type HttpServerRequest } from "effect/http"
import { ACCESSES } from "../src/features/branch/contract.ts"
import { ROLES } from "../src/features/auth/contract.ts"
import type { Actor } from "./Actor.ts"
import * as SessionStore from "./SessionStore.ts"
import { ROLE_RECHECK_MINUTES } from "./SignIn.ts"

// Every socket host's lease on who it admitted (docs/observability.md#socket-leases). A route authorizes a socket once,
// at connect, then hands it to a Durable Object that streams to it for as long as it stays open. So the route also
// hands over an `Admission`: the person, their sign-in session (and the alias session it came through), its end, and
// the basis they were let in on (a run's repository, a branch, a run's text). The host keeps it with the socket under a
// lease: an expiry at most `LEASE_MS` ahead and never past the session's end. Every frame, out and in, checks the lease
// where it is, with no query. Only a good check renews it (`renew`, by the rules the route used, worker/SocketChecks.ts):
// the session and the alias live, the role confirmed by GitHub within `roleFreshMs`, and the role or the branch's
// sharing still letting them in. Anything else, a failed or slow check included, ends it: every socket that lost its
// lease leaves its host's sending set before any of them closes, with `4401` (session), `1008` (no access) or `1012`
// (changed or unverified), and nothing private. Hosts: the transcript (worker/runners/TranscriptHost.ts), branch and text
// rooms (worker/BranchRooms.ts) and terminals (worker/BranchSandboxes.ts).

/** How far ahead a good check leases a socket: the longest it receives or sends after access ends. */
export const LEASE_MS = 60_000

/** How long before a lease lapses its host renews it, so a live socket never waits on a check. */
export const RENEW_AHEAD_MS = 10_000

/** A host's renewal takes every lease lapsing within this, so the sockets of one room or run renew together. */
export const RENEW_WINDOW_MS = 30_000

/** How long one authority's check may take; past it, it is `unverified`. */
export const CHECK_TIMEOUT_MS = 5_000

/** How long a whole renewal may take, opening its Postgres client included; past it, every socket in it is `unverified`. */
export const RENEW_DEADLINE_MS = 10_000

/** How many authorities a renewal checks at once. */
export const CHECK_CONCURRENCY = 4

/** How many sockets one person may hold open on one host (one run's transcript, one room, one machine). */
export const MAX_SOCKETS_PER_PERSON = 50

/**
 * How long past sign-in's own `ROLE_RECHECK_MINUTES` a role GitHub confirmed still renews a lease: by then any request
 * of theirs has started its check (worker/SignIn.ts `RoleChecks`). A check that failed confirms nothing.
 */
export const ROLE_GRACE_MS = 10 * 60_000

/** The oldest a role's last confirmation by GitHub may be to admit a socket or renew its lease, in milliseconds. */
export const roleFreshMs = Config.Number("ROLE_RECHECK_MINUTES").pipe(
  Config.withDefault(ROLE_RECHECK_MINUTES),
  Config.map((minutes) => minutes * 60_000 + ROLE_GRACE_MS),
)

/** The header only ChatApi sets on a socket it hands a host: the `Admission`, as JSON. A browser's is dropped. */
export const ADMISSION_HEADER = "x-smithers-admission"

/** What a socket was let in on, and so what renewing its lease asks again. */
export const Basis = Schema.Union([
  // A TODO run's transcript: a Member or above on the run's repository.
  Schema.Struct({ kind: Schema.Literal("run"), repoId: Schema.String }),
  // A branch's room, or a text kept under a branch: what the person may do on the branch.
  Schema.Struct({ kind: Schema.Literal("branch"), branchId: Schema.String }),
  // A terminal on a branch: the branch, and a Member or above (`canAsk`).
  Schema.Struct({ kind: Schema.Literal("terminal"), branchId: Schema.String }),
  // A text kept under a run.
  Schema.Struct({ kind: Schema.Literal("text"), run: Schema.String }),
])
export type Basis = typeof Basis.Type

/** Who a host admitted, as the route decided it. */
export const Admission = Schema.Struct({
  /** The home sign-in session; `null` where none resolved it (local development's developer). */
  session: Schema.NullOr(Schema.String),
  /** The alias session it came through at an alias host, under `session` (decision 0130); `null` at home. */
  alias: Schema.NullOr(Schema.String),
  /** When the session ends, in epoch milliseconds; `null` with no session. */
  expiresAt: Schema.NullOr(Schema.Number),
  /** When the route admitted it, epoch milliseconds. */
  admittedAt: Schema.Number,
  principal: Schema.String,
  /** The session's role at connect: what decides when there is no session to read it from again. */
  role: Schema.NullOr(Schema.Literals(ROLES)),
  basis: Basis,
  /** What they were let in with: the branch access, a terminal's `write` or `read`, or `member` for a run. */
  access: Schema.Union([Schema.Literals(ACCESSES), Schema.Literals(["write", "read", "member"])]),
})
export type Admission = typeof Admission.Type

const AdmissionJson = Schema.fromJsonString(Admission)
const encodeJson = Schema.encodeSync(AdmissionJson)
const decodeJson = Schema.decodeUnknownOption(AdmissionJson)
const decode = Schema.decodeUnknownOption(Admission)

/** `admission` decoded from a value a host kept, or `undefined`. */
export const admissionFrom = (value: unknown): Admission | undefined => Option.getOrUndefined(decode(value))

/** The admission ChatApi set on a request it handed a host, or `undefined`. */
export const admissionOf = (request: HttpServerRequest.HttpServerRequest): Admission | undefined =>
  Option.getOrUndefined(decodeJson(request.headers[ADMISSION_HEADER] ?? ""))

/** `request` with only ChatApi's `x-smithers-*` headers, `extra` and the admission. */
export const forward = (
  request: HttpServerRequest.HttpServerRequest,
  admission: Admission,
  extra: Record<string, string> = {},
) => {
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => !name.toLowerCase().startsWith("x-smithers-")),
  )
  return request.modify({ headers: Headers.fromInput({ ...headers, ...extra, [ADMISSION_HEADER]: encodeJson(admission) }) })
}

/** What `admit` decided: the admission, a session that ended, or a role GitHub hasn't confirmed lately (`503`, retry). */
export type Admitted =
  | { readonly _tag: "admitted"; readonly admission: Admission }
  | { readonly _tag: "ended" }
  | { readonly _tag: "stale" }

/** Whether a role GitHub last confirmed at `verifiedAt` still counts at `now`. */
export const roleFresh = (verifiedAt: number | null, now: number, freshMs: number): boolean =>
  verifiedAt !== null && now - verifiedAt <= freshMs

/**
 * The admission for `actor` on `basis` with `access`: their session, and alias session, read once here. One that ended
 * between the route's check and now admits nothing (`ended`), and neither does a role GitHub hasn't confirmed within
 * `roleFreshMs` (`stale`): the route's own `Sessions.resolve` has started that check, so the page's retry admits.
 */
export const admit = (actor: Actor, basis: Basis, access: Admission["access"]) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    let expiresAt: number | null = null
    if (actor.session !== undefined) {
      const found = yield* SessionStore.authority(actor.session, actor.alias ?? null)
      if (Option.isNone(found) || found.value.personId !== actor.subject.id) return { _tag: "ended" } as Admitted
      if (!roleFresh(found.value.roleVerifiedAt, now, yield* roleFreshMs)) return { _tag: "stale" } as Admitted
      // The end on this Worker's clock: the lookup started at `now`, and the database said how long was left then
      // (decision 0151 rule 9), so a Worker clock skewed from the database's never lengthens the lease.
      expiresAt = now + (found.value.expiresAt - found.value.serverNow)
    }
    return {
      _tag: "admitted",
      admission: {
        session: actor.session ?? null,
        alias: actor.alias ?? null,
        expiresAt,
        admittedAt: now,
        principal: actor.subject.id,
        role: actor.role,
        basis,
        access,
      },
    } as Admitted
  })

/**
 * Whether a socket opened for `expected` (the person a page names when it dials; not sent yet) may be `actor`'s: no
 * name, or theirs.
 */
export const personMatches = (actor: Actor, expected: string | undefined): boolean =>
  expected === undefined || expected === actor.subject.id

/** A lease from `now`: `LEASE_MS` ahead, never past the session's end. */
export const leaseFrom = (admission: Admission, now: number): number =>
  Math.min(admission.expiresAt ?? Infinity, now + LEASE_MS)

/** Whether `admission`'s session has passed its end at `now`. */
export const ended = (admission: Admission, now: number): boolean =>
  admission.expiresAt !== null && admission.expiresAt <= now

/**
 * A renewal's answer for one socket: renewed (`keep`), the session ended (`session`), the access is gone (`revoked`),
 * it changed and the page reconnects for the new one (`changed`), or no good check (`unverified`: Postgres or GitHub
 * didn't answer in time, or GitHub hasn't confirmed the role lately).
 */
export type Verdict = "keep" | "session" | "revoked" | "changed" | "unverified"

/** The close each ending verdict sends, and a socket from before leases (`legacy`): a code and a reason. */
export const CLOSES = {
  session: { code: 4401, reason: "session ended" },
  revoked: { code: 1008, reason: "no access" },
  changed: { code: 1012, reason: "access changed" },
  unverified: { code: 1012, reason: "access unverified" },
  legacy: { code: 1012, reason: "reconnect" },
} as const
export type Closing = keyof typeof CLOSES

/** Lease renewals by `host` and `outcome` (a verdict, or `legacy`): every close counts here. Never a person. */
export const leases = Metric.counter("smithers_socket_leases", {
  description: "Socket lease renewals and closes by their host, by host and outcome",
  incremental: true,
})

/** One authority: what a check asks, the same for every socket of one person's session on one basis. */
const authorityOf = (admission: Admission): string =>
  JSON.stringify([
    admission.session,
    admission.alias,
    admission.principal,
    admission.session === null ? admission.role : null,
    admission.basis,
    admission.access,
  ])

/**
 * Renews the leases of `entries`' admissions: one check per authority, `CHECK_CONCURRENCY` at a time, each within
 * `CHECK_TIMEOUT_MS`, and all of it, opening the client in `within` included, within `RENEW_DEADLINE_MS`. An admission
 * past its session's end is `session` with no query; a check that fails, or doesn't answer in time, is `unverified`.
 * Answers a verdict per entry, in order, and counts each (`leases`).
 */
export const renew = <RC, R>(
  host: string,
  admissions: ReadonlyArray<Admission>,
  check: (admission: Admission) => Effect.Effect<Verdict, never, RC>,
  within: <A>(effect: Effect.Effect<A, never, RC | R>) => Effect.Effect<A, unknown, R>,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const asked = new Map<string, Admission>()
    for (const admission of admissions) if (!ended(admission, now)) asked.set(authorityOf(admission), admission)
    const checked = yield* within(Effect.forEach(
      [...asked],
      ([key, admission]) =>
        check(admission).pipe(
          Effect.timeoutOrElse({ duration: CHECK_TIMEOUT_MS, orElse: () => Effect.succeed<Verdict>("unverified") }),
          Effect.map((verdict) => [key, verdict] as const),
        ),
      { concurrency: CHECK_CONCURRENCY },
    )).pipe(
      Effect.timeoutOrElse({ duration: RENEW_DEADLINE_MS, orElse: () => Effect.succeed([]) }),
      Effect.catchCause(() => Effect.succeed([])),
    )
    const verdicts = new Map<string, Verdict>(checked)
    // A check that answered after the session's end renews nothing: the end is checked again now.
    const after = yield* Clock.currentTimeMillis
    const answers = admissions.map((admission): Verdict =>
      ended(admission, after) ? "session" : verdicts.get(authorityOf(admission)) ?? "unverified"
    )
    const counts: Record<Verdict, number> = { keep: 0, session: 0, revoked: 0, changed: 0, unverified: 0 }
    for (const outcome of answers) {
      counts[outcome]++
      yield* Metric.update(Metric.withAttributes(leases, { host, outcome }), 1)
    }
    yield* Effect.logWithLevel(counts.unverified > 0 ? "Warn" : "Info")("socket.lease").pipe(
      Effect.annotateLogs({ host, sockets: admissions.length, checks: asked.size, ...counts }),
    )
    return answers
  }).pipe(Effect.withSpan("socket.lease", { attributes: { "smithers.socket.host": host } }))

/** Counts a socket from before leases, which its host closes with `CLOSES.legacy` before anything else. */
export const countLegacy = (host: string, count: number) =>
  count === 0 ? Effect.void : Metric.update(Metric.withAttributes(leases, { host, outcome: "legacy" }), count)

/** Whether a lease stops at the session's end, not `LEASE_MS` on: no renewal can move it, only the end can come. */
const capped = (admission: Admission, leaseUntil: number): boolean =>
  admission.expiresAt !== null && leaseUntil >= admission.expiresAt

/** When a host acts on a lease: `RENEW_AHEAD_MS` before it lapses, or at the session's end when that caps it. */
const actAt = (admission: Admission, leaseUntil: number): number =>
  capped(admission, leaseUntil) ? leaseUntil : leaseUntil - RENEW_AHEAD_MS

/**
 * Whether a host renews a lease now: one lapsing within `RENEW_WINDOW_MS`, so the sockets of one host renew together;
 * one the session's end caps only once that end has come, when renewing ends it with no query.
 */
export const due = (admission: Admission, leaseUntil: number, now: number): boolean =>
  capped(admission, leaseUntil) ? leaseUntil <= now : leaseUntil <= now + RENEW_WINDOW_MS

/** When a host next acts on these leases (`actAt`), never before `now`; none with none. */
export const nextRenewal = (
  leases: ReadonlyArray<{ readonly admission: Admission; readonly leaseUntil: number }>,
  now: number,
): number | undefined =>
  leases.length === 0
    ? undefined
    : Math.max(Math.min(...leases.map((lease) => actAt(lease.admission, lease.leaseUntil))), now + 1)

/**
 * One renewal at a time per host: a caller that finds one running waits for it instead of starting its own, so a burst
 * of frames on lapsed leases costs one renewal, not one each.
 */
export const singleFlight = () => {
  let running: Deferred.Deferred<void> | undefined
  return <E, R>(renewal: Effect.Effect<void, E, R>): Effect.Effect<void, E, R> =>
    Effect.suspend(() => {
      if (running !== undefined) return Deferred.await(running)
      const done = Deferred.makeUnsafe<void>()
      running = done
      return renewal.pipe(Effect.ensuring(Effect.suspend(() => {
        running = undefined
        return Deferred.succeed(done, undefined)
      })))
    })
}

/**
 * A notification from outside any effect (a socket's own event) that starts `renewal` through `fork` unless the one it
 * started is still running: a burst of frames on a lapsed lease costs one fiber, never one each.
 */
export const coalesced = <R>(
  renewal: Effect.Effect<void, never, R>,
  fork: (effect: Effect.Effect<void, never, R>) => unknown,
): () => void => {
  let pending = false
  return () => {
    if (pending) return
    pending = true
    fork(Effect.ensuring(renewal, Effect.sync(() => void (pending = false))))
  }
}

/**
 * The renewal loop of a host that never hibernates while a socket is open: it sleeps until `nextRenewal` of `leases()`,
 * runs `renewDue`, and ends when no lease is left. `nudge` wakes its sleep sooner for a new lease acted on before that
 * wake; it never cancels a renewal that runs, and a later lease never moves the wake.
 */
export const renewalLoop = <R>(
  leases: () => ReadonlyArray<{ readonly admission: Admission; readonly leaseUntil: number }>,
  renewDue: Effect.Effect<void, never, R>,
) => {
  let wakeAt: number | undefined
  let wake = Deferred.makeUnsafe<void>()
  const loop = Effect.gen(function* () {
    for (;;) {
      const now = yield* Clock.currentTimeMillis
      const next = nextRenewal(leases(), now)
      if (next === undefined) return
      wake = Deferred.makeUnsafe<void>()
      wakeAt = next
      yield* Effect.raceFirst(Effect.sleep(next - now), Deferred.await(wake))
      wakeAt = undefined
      yield* renewDue
    }
  }).pipe(Effect.ensuring(Effect.sync(() => void (wakeAt = undefined))))
  const nudge = (lease: { readonly admission: Admission; readonly leaseUntil: number }) => {
    if (wakeAt !== undefined && actAt(lease.admission, lease.leaseUntil) < wakeAt) Deferred.doneUnsafe(wake, Effect.void)
  }
  return { loop, nudge }
}

/** Whether `principal` already holds `MAX_SOCKETS_PER_PERSON` of these admissions. */
export const crowded = (admissions: ReadonlyArray<Admission | undefined>, principal: string): boolean =>
  admissions.filter((admission) => admission?.principal === principal).length >= MAX_SOCKETS_PER_PERSON

/** The storage a hibernating host keeps its alarm in: a Durable Object's, or a test's. */
export interface Storage<R = never> {
  readonly get: <T>(key: string) => Effect.Effect<T | undefined, never, R>
  readonly put: <T>(key: string, value: T) => Effect.Effect<void, never, R>
  readonly getAlarm: () => Effect.Effect<number | null, never, R>
  readonly setAlarm: (at: number) => Effect.Effect<void, never, R>
}

/** Arms `storage`'s alarm for `next` unless one is due sooner; nothing with no `next`. */
export const armAt = <R>(storage: Storage<R>, next: number | undefined) =>
  Effect.gen(function* () {
    if (next === undefined) return
    const alarm = yield* storage.getAlarm()
    if (alarm === null || alarm > next) yield* storage.setAlarm(next)
  })

/** A hibernatable socket as a host holds it: Alchemy's `Cloudflare.WebSocket`, or a test's. */
export interface HostSocket {
  readonly send: (text: string) => Effect.Effect<void, unknown>
  readonly close: (code: number, reason: string) => Effect.Effect<void, unknown>
  readonly serializeAttachment: (value: unknown) => void
  readonly deserializeAttachment: <T>() => T | null
}

/** A raw socket as a terminal reads and writes it (`@smthrs/platform-cloudflare`'s `ContainerTerminal.Socket`). */
export interface RawSocket<E> {
  send(message: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message" | "close" | "error", listener: (event: E) => void): void
  removeEventListener(type: "message" | "close" | "error", listener: (event: E) => void): void
}

/**
 * `raw` with every frame, out and in, passed only while `live()` says its lease holds: a frame past it is dropped, and
 * `lapsed` asked to renew it.
 */
export const gate = <E>(raw: RawSocket<E>, live: () => boolean, lapsed: () => void): RawSocket<E> => {
  const wrapped = new Map<(event: E) => void, (event: E) => void>()
  return {
    send: (message) => {
      if (live()) raw.send(message)
      else lapsed()
    },
    close: (code, reason) => raw.close(code, reason),
    addEventListener: (type, listener) => {
      const gated = type !== "message" ? listener : (event: E) => {
        if (live()) listener(event)
        else lapsed()
      }
      wrapped.set(listener, gated)
      raw.addEventListener(type, gated)
    },
    removeEventListener: (type, listener) => raw.removeEventListener(type, wrapped.get(listener) ?? listener),
  }
}
