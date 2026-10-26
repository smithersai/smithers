import type { SharedSqlite } from "@smthrs/platform-browser"
import { Cause, Data, Effect, Metric, Option, Schema } from "effect"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA, SESSION_ROUTE, type SessionState as State } from "../features/auth/contract"
import { Confirmed, SessionState } from "../features/auth/schema"
import { codeOf } from "../errorCode"

// Whose data this device holds (decision 0021, "Device ownership"; docs/features/sign-in.md#the-devices-owner). The
// leading engine worker checks it before the engine starts (`BrowserRuntime.run({ authorize })`), on every activation,
// and tells every tab; a tab opens the device store and the outbox only once its own session agrees. A different
// person never opens, sends or resumes another person's data: the device stays sealed, kept whole, until its owner
// signs in again or someone signs out, which wipes it as signing out always does.

/** The data's owner when it was made without a verified session: a visitor's, which the next person to sign in adopts. */
export const VISITOR = "@visitor"

/** The tab's and the engine worker's channel for the owner receipt, and its message `_tag`. */
export const IDENTITY_MESSAGE = "smithers/device-identity"

/** The activation was refused, or a request waits for the device to check its owner again. */
export class DeviceIdentityRefused extends Data.TaggedError("DeviceIdentityRefused")<{ readonly reason: string }> {}

/** Owner checks, by `outcome`, and `via` for a verified one. */
export const checks = Metric.counter("smithers_device_identity_checks", { incremental: true })

/**
 * What an activation found:
 * - `verified`: the person signed in owns the data; `via` says how they came to (`owner`: already did; `legacy`: an
 *   earlier build's confirmed login matches theirs; `visitor`: they adopt a visitor's data; `new`: an empty device);
 * - `visitor`: signed out or offline over a visitor's data or an empty device;
 * - `offline`: the owner's data, opened while ChatApi can't say who is signed in;
 * - refused, the data kept whole and unopened: `signed_out` (the owner's session ended), `changed` (another person,
 *   or an earlier build's data whose owner this build can't tell), `unverified` (an earlier build's data while
 *   offline).
 */
export type Outcome = "verified" | "visitor" | "offline" | "signed_out" | "changed" | "unverified"

/**
 * What the owner receipt carries: who the opened data belongs to (absent when it may not open) and the outcome; with
 * `reopen`, every tab should load again because another person is signed in now. With `continuous`, the owner
 * inherited authority over unstamped writes from an existing owner record or an earlier build's matching session.
 * Only that authority admits writes stored before writes named who queued them (`Outbox.Principal`).
 * A fresh claim or adoption permanently lacks it, including on reload, and keeps such writes sealed.
 */
export interface Receipt {
  readonly _tag: typeof IDENTITY_MESSAGE
  readonly owner: string | undefined
  readonly outcome: string
  readonly reopen?: true
  readonly continuous?: true
}

const Owner = Schema.Struct({ v: Schema.Literal(1), personId: Schema.String, login: Schema.String })

/**
 * The owner record: one row beside the collections in the device store, outside every synced or clearable row, so
 * expiry keeps it and only the device wipe deletes it. Version 1: the owner's stable person id, or `VISITOR`, and the
 * login they claimed it under (empty for a visitor), kept for diagnosis only; the id alone decides.
 * The additive owns_unstamped column preserves legacy-write eligibility independently of later activations.
 */
const OWNER_TABLE = "smithers_device_identity"

/** Collections that hold nobody's private data: the theme, and the confirmed session the owner check reads. */
const SHARED_COLLECTIONS = ["preferences", "auth-confirmed"]

/** An unclaimed device store, from an earlier build: empty, its confirmed login, or data whose owner it never kept. */
type Legacy =
  | { readonly _tag: "empty" }
  | { readonly _tag: "confirmed"; readonly login: string; readonly personId: string | undefined }
  | { readonly _tag: "unowned" }

const tableExists = (database: SharedSqlite.Service, name: string) =>
  Effect.map(
    database.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]),
    (rows) => rows.length > 0,
  )

/**
 * Reads what an earlier build left: its confirmed session, kept by TanStack DB as the row's JSON `value`. Builds up to
 * c6940ac5 kept a login only; later ones also kept the stable person id.
 */
const legacyOf = (database: SharedSqlite.Service) =>
  Effect.gen(function* () {
    if (!(yield* tableExists(database, "collection_registry"))) return { _tag: "empty" } as Legacy
    const [registered] = yield* database.execute(
      "SELECT table_name AS tableName FROM collection_registry WHERE collection_id = 'auth-confirmed'",
    )
    const table = (registered as { readonly tableName?: string } | undefined)?.tableName
    // TanStack DB registers a collection before it creates its table: a registration alone holds no row.
    if (table !== undefined && (yield* tableExists(database, table))) {
      const [row] = yield* database.execute(`SELECT value FROM "${table.replaceAll('"', '""')}" LIMIT 1`)
      const confirmed = Schema.decodeUnknownOption(Schema.fromJsonString(Confirmed))(
        (row as { readonly value?: unknown } | undefined)?.value,
      )
      if (Option.isSome(confirmed)) {
        return { _tag: "confirmed", login: confirmed.value.login, personId: confirmed.value.personId } as Legacy
      }
    }
    const others = yield* database.execute(
      `SELECT collection_id FROM collection_registry WHERE collection_id NOT IN (${SHARED_COLLECTIONS.map(() => "?").join(", ")}) LIMIT 1`,
      SHARED_COLLECTIONS,
    )
    return (others.length > 0 ? { _tag: "unowned" } : { _tag: "empty" }) as Legacy
  })

/**
 * Whether an earlier build's confirmed session is `person`'s: by stable id when it kept one, else by login, which
 * GitHub keeps unique without regard to case.
 */
const confirmedFor = (legacy: Legacy | undefined, person: { readonly personId: string; readonly login: string }) =>
  legacy?._tag === "confirmed" &&
  (legacy.personId === undefined
    ? legacy.login.toLowerCase() === person.login.toLowerCase()
    : legacy.personId === person.personId)

/**
 * The activation check the leading engine worker runs before the engine starts. Allowed, it records the owner when
 * this activation decided it and reports `owner`; refused, it reports no owner and fails with `DeviceIdentityRefused`,
 * and nothing of the device's data opens. It never deletes a row: an owner change keeps the data sealed for its owner.
 * Its log line and count carry the outcome only, never a login or a person.
 */
export const authorizeDevice = (options: {
  readonly database: SharedSqlite.Service
  readonly session: Effect.Effect<State, unknown>
  readonly report: (owner: string | undefined, outcome: Outcome, continuous: boolean) => void
}) => {
  let stage = "owner"
  return Effect.gen(function* () {
    const { database } = options
    yield* database.execute(
      `CREATE TABLE IF NOT EXISTS ${OWNER_TABLE} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), v INTEGER NOT NULL CHECK (v = 1), person_id TEXT NOT NULL, login TEXT NOT NULL)`,
    )
    // Eligibility for legacy outbox writes survives reload. A new/adopted owner never inherits it merely by
    // becoming the recorded owner; existing records predate this distinction and retain their legacy authority.
    const columns = yield* database.execute(`PRAGMA table_info(${OWNER_TABLE})`)
    if (!columns.some((column) => (column as { name: string }).name === "owns_unstamped")) {
      yield* database.execute(`ALTER TABLE ${OWNER_TABLE} ADD COLUMN owns_unstamped INTEGER NOT NULL DEFAULT 1`)
    }
    const [row] = yield* database.execute(
      `SELECT v, person_id AS personId, login, owns_unstamped AS ownsUnstamped FROM ${OWNER_TABLE} WHERE singleton = 1`,
    )
    const recorded = row === undefined ? undefined : (yield* Schema.decodeUnknownEffect(Owner)(row)).personId
    stage = "legacy"
    const legacy = recorded === undefined ? yield* legacyOf(database) : undefined
    stage = "session"
    const session = yield* Effect.result(options.session)
    const claim = (personId: string, login = "", ownsUnstamped = false) => {
      stage = "claim"
      return Effect.as(
        database.execute(`INSERT OR REPLACE INTO ${OWNER_TABLE} (singleton, v, person_id, login, owns_unstamped) VALUES (1, 1, ?, ?, ?)`, [
          personId,
          login,
          ownsUnstamped ? 1 : 0,
        ]),
        personId,
      )
    }
    let owner: string | undefined
    let outcome: Outcome
    let via: "owner" | "legacy" | "visitor" | "new" | undefined
    if (session._tag === "Failure" || !session.success.signedIn) {
      const offline = session._tag === "Failure"
      if (recorded !== undefined && recorded !== VISITOR) {
        // The owner's data opens offline as theirs; signed out, it stays sealed until they sign in again.
        owner = offline ? recorded : undefined
        outcome = offline ? "offline" : "signed_out"
      } else if (recorded === VISITOR || legacy?._tag === "empty") {
        owner = recorded ?? (yield* claim(VISITOR))
        outcome = "visitor"
      } else {
        // An earlier build's data, whose owner only an online sign-in can tell.
        outcome = offline ? "unverified" : "signed_out"
      }
    } else {
      const person = session.success
      if (person.personId === undefined) return yield* new DeviceIdentityRefused({ reason: "missing_person" })
      const matches = recorded !== undefined
        ? recorded === person.personId || recorded === VISITOR
        : legacy?._tag === "empty" || confirmedFor(legacy, { personId: person.personId, login: person.login })
      if (matches) {
        via = recorded === person.personId ? "owner" : recorded === VISITOR ? "visitor" : legacy?._tag === "confirmed" ? "legacy" : "new"
        owner = via === "owner" ? person.personId : yield* claim(person.personId, person.login, via === "legacy")
        outcome = "verified"
      } else {
        outcome = "changed"
      }
    }
    const fields: Record<string, string> = via === undefined ? { outcome } : { outcome, via }
    yield* Metric.update(Metric.withAttributes(checks, fields), 1)
    // A session read that failed names why by its code; one ChatApi answered outside the contract, such as a 5xx, is a
    // failure (Warn) with its status, where no answer at all is this device being offline (Info).
    const failed = session._tag === "Failure" ? session.failure : undefined
    const status = (failed as { readonly status?: unknown } | undefined)?.status
    yield* Effect.logWithLevel(typeof status === "number" ? "Warn" : "Info")("auth.device_identity").pipe(
      Effect.annotateLogs(failed === undefined ? fields : {
        ...fields,
        errorCode: codeOf(failed),
        ...(typeof status === "number" ? { status } : {}),
      }),
    )
    // Reload never turns a fresh claim or visitor adoption into authority over legacy writes.
    const continuous = owner !== undefined &&
      ((owner === recorded && (row as { ownsUnstamped: number }).ownsUnstamped === 1) || via === "legacy")
    yield* Effect.sync(() => options.report(owner, outcome, continuous))
    if (owner === undefined) return yield* new DeviceIdentityRefused({ reason: outcome })
  }).pipe(
    Effect.tapCause((cause) => {
      const failure = Cause.squash(cause)
      const reason = failure instanceof DeviceIdentityRefused ? failure.reason : "storage"
      // A refusal by outcome was counted above. Anything else leaves the device unopened too, and is counted here
      // by stage, never with the failure's message, which can quote a row.
      if (reason !== "missing_person" && reason !== "storage") return Effect.void
      return Metric.update(Metric.withAttributes(checks, { outcome: "unavailable" }), 1).pipe(
        Effect.andThen(Effect.logWarning("auth.device_identity").pipe(Effect.annotateLogs({ outcome: "unavailable", stage, reason }))),
      )
    }),
  )
}

/** The browser's session now, as a leader reads it for a tab about to follow: ChatApi's answer, or why not. */
export type SessionNow = State | "unreachable" | "malformed"

/** A session answer the owner check can trust: a signed-in one names its stable person. */
export const readSession = (value: unknown): State | undefined => {
  const state = Option.getOrUndefined(Schema.decodeUnknownOption(SessionState)(value))
  return state?.signedIn && state.personId === undefined ? undefined : state
}

/** `GET /api/auth/session`'s response as `SessionNow`: not OK is unreachable, an answer it can't trust is malformed. */
export const sessionNow = async (response: Response): Promise<SessionNow> =>
  // expected: a body that is not JSON reads as malformed
  response.ok ? (readSession(await response.json().catch(() => undefined)) ?? "malformed") : "unreachable"

/**
 * What a leader answers a tab about to follow it, by the browser's session now rather than at its activation: its
 * receipt when the data it opened is still that session's (or ChatApi can't say); no owner otherwise, and `reopen`
 * when another person is signed in, so every tab loads again and a new activation checks them.
 */
export const answer = (receipt: Receipt, session: SessionNow): Receipt => {
  const owner = receipt.owner
  if (owner === undefined || session === "unreachable") return receipt
  if (session !== "malformed" && (session.signedIn ? session.personId === owner : owner === VISITOR)) return receipt
  return session !== "malformed" && session.signedIn
    ? { _tag: IDENTITY_MESSAGE, owner: undefined, outcome: receipt.outcome, reopen: true }
    : { _tag: IDENTITY_MESSAGE, owner: undefined, outcome: receipt.outcome }
}

/** A receipt from a tab's channel or worker, checked: anything else is not one. */
export const readReceipt = (value: unknown): Receipt | undefined => {
  const receipt = value as Partial<Receipt> | null | undefined
  if (
    receipt?._tag !== IDENTITY_MESSAGE || typeof receipt.outcome !== "string" ||
    (receipt.owner !== undefined && typeof receipt.owner !== "string")
  ) return undefined
  return {
    _tag: IDENTITY_MESSAGE,
    owner: receipt.owner,
    outcome: receipt.outcome,
    ...(receipt.reopen === true ? { reopen: true } : {}),
    ...(receipt.continuous === true ? { continuous: true } : {}),
  }
}

/**
 * How asking the leader to adopt the visitor's data for the person signed in ended: adopted, so this page's data is
 * theirs now; refused, so the page reopens; or not now (ChatApi couldn't say, or no one is signed in any more), so the
 * answer fails as unsent and the session is asked again.
 */
export type Adoption = "adopted" | "refused" | "unavailable"

/** How a page or worker binds its requests, and when a session answer means its activation must be made again. */
export interface Binding {
  readonly origin: string
  /** The person whose data this context opened: an owner, `VISITOR`, or `NO_DEVICE_DATA`. */
  readonly principal: () => string
  /** Every request to the origin's `/api/` waits for it: the activation's decision. */
  readonly ready?: Promise<void> | undefined
  /** Starts a new activation; without it, nothing reopens (the engine worker). */
  readonly reauthorize?: (() => Promise<void>) | undefined
  /**
   * Whether this context, on memory stores, was sealed only because no one was signed in, or ChatApi couldn't say
   * who: a session answer naming a signed-in person then reopens it, so the owner's data opens once they are back.
   */
  readonly reopensOnSignIn?: (() => boolean) | undefined
  /**
   * Asks the leader to adopt, in place, the visitor's data this context opened for `session`'s person (decision 0023,
   * "Adopting in place"): a session answer naming a person on a context bound to `VISITOR` asks this before it
   * reopens anything. The request signal carries its caller's Effect deadline through the adoption wait.
   */
  readonly adopt?: ((session: State, signal: AbortSignal) => Promise<Adoption>) | undefined
}

/**
 * Whether `session`, ChatApi's answer now, leaves an activation bound to `principal` stale: data opened for someone
 * else, or a page sealed until someone signs in (`reopensOnSignIn`).
 */
export const stale = (principal: string, reopensOnSignIn: boolean, session: State | undefined) =>
  session?.signedIn === true &&
  (principal === NO_DEVICE_DATA ? reopensOnSignIn : session.personId !== principal)

/**
 * The page's and the engine worker's transport under Effect's HttpClient (`FetchHttpClient.Fetch`), around `next`, the
 * browser's: every request to this origin's `/api/` waits for `ready`, then carries the person whose data this context
 * opened (`principal`), so ChatApi refuses it under another person's cookie. A context that opened nothing of the
 * device's says so (`NO_DEVICE_DATA`) and acts as its cookie's person. With `reauthorize`, every session answer checks
 * the activation again: its own, or one it reads after a `401`. A stale one (`stale`) starts a new activation, and this
 * request and every later one fail as unsent, so a queued write waits for its owner instead of being refused, until the
 * page has loaded again; a context bound to the visitor's data asks its leader to `adopt` it for the person first, and
 * reopens only when that is refused. This is the one place a page acts on who is signed in now; Auth's session reads,
 * startup, reconnect and `auth/refresh` alike, pass through it.
 */
export const boundFetch = (next: typeof globalThis.fetch, binding: Binding): typeof globalThis.fetch => {
  const { origin, principal, ready = Promise.resolve(), reauthorize, reopensOnSignIn = () => false, adopt } = binding
  let recovering: Promise<void> | undefined
  let adopting: Promise<Adoption> | undefined
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return next(request)
    await ready
    // A request made while the visitor's data is being adopted goes once it is, as its new owner's.
    await adopting
    if (recovering !== undefined) {
      await recovering
      throw new DeviceIdentityRefused({ reason: "reauthorizing" })
    }
    const bound = principal()
    const headers = new Headers(request.headers)
    headers.set(DEVICE_PERSON_HEADER, bound)
    const response = await next(new Request(request, { headers }))
    if (reauthorize === undefined) return response
    // Who the browser is signed in as now: this answer, when it is the session's; after a refusal, asked again.
    const answered = url.pathname === SESSION_ROUTE
      ? response.clone()
      : response.status === 401
      // expected: a session read that fails tells nothing new
      ? await next(new Request(`${origin}${SESSION_ROUTE}`, { cache: "no-store" })).catch(() => undefined)
      : undefined
    // expected: an unreadable session body names no session
    const session = answered?.ok === true ? readSession(await answered.json().catch(() => undefined)) : undefined
    if (stale(bound, reopensOnSignIn(), session)) {
      // The visitor's data this context opened becomes the person's in place: the answer goes on as theirs.
      const adoption = bound === VISITOR && adopt !== undefined
        ? await (adopting ??= adopt(session!, request.signal).finally(() => (adopting = undefined)))
        : "refused"
      if (adoption === "adopted") return response
      if (adoption === "unavailable") throw new DeviceIdentityRefused({ reason: "adopting" })
      await (recovering ??= reauthorize())
      throw new DeviceIdentityRefused({ reason: "reauthorizing" })
    }
    return response
  }
}

/**
 * The tab's one activation decision, made once: `retained` opens the device's data, `memory` never does; a later
 * receipt can't change it. Until then the device store and the outbox wait, as they wait for a leader anyway.
 */
export const activationGate = (refused: () => void) => {
  let state: "pending" | "retained" | "memory" = "pending"
  let resolve!: () => void
  const ready = new Promise<void>((done) => {
    resolve = done
  })
  const settle = (next: "retained" | "memory") => {
    if (state !== "pending") return false
    state = next
    if (next === "memory") refused()
    resolve()
    return true
  }
  return { ready, state: () => state, allow: () => settle("retained"), refuse: () => settle("memory") }
}

/** The outbox uses the opened owner's identity, including the memory-only activation. */
export const outboxPrincipal = (owner: () => string | undefined, continuous: () => boolean) => ({
  now: () => owner() ?? NO_DEVICE_DATA,
  ownsUnstamped: continuous,
})
