import type { SharedSqlite } from "@smthrs/platform-browser"
import { Cause, Data, Effect, Metric, Option, Schema } from "effect"
import {
  ACCEPTS_HEADER,
  CONFIRM_401_HEADER,
  DEVICE_PERSON_HEADER,
  NO_DEVICE_DATA,
  SESSION_CHECK_HEADER,
  SESSION_ROUTE,
  type SessionState as State,
  SIGN_OUT_ROUTE,
} from "../features/auth/contract"
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
export class DeviceIdentityRefused extends Data.TaggedError("DeviceIdentityRefused")<{
  readonly reason: string
  readonly stage?: "credential_lock"
  readonly wait?: "deadline" | "cancelled"
}> {}

/** A queued write returns to its durable retry policy instead of waiting on another context indefinitely. */
export const CREDENTIAL_LOCK_WAIT_MS = 2_000

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
  /** The owner's recorded tag lets a reread diagnose its prior session without granting authority. */
  readonly sessionTag?: string
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
  readonly report: (owner: string | undefined, outcome: Outcome, continuous: boolean, sessionTag?: string) => void
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
    if (!columns.some((column) => (column as { name: string }).name === "session_tag")) {
      yield* database.execute(`ALTER TABLE ${OWNER_TABLE} ADD COLUMN session_tag TEXT`)
    }
    const [row] = yield* database.execute(
      `SELECT v, person_id AS personId, login, owns_unstamped AS ownsUnstamped, session_tag AS sessionTag FROM ${OWNER_TABLE} WHERE singleton = 1`,
    )
    const recorded = row === undefined ? undefined : (yield* Schema.decodeUnknownEffect(Owner)(row)).personId
    let sessionTag = tagOf((row as { sessionTag?: unknown } | undefined)?.sessionTag)
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
        sessionTag = tagOf(person.session) ?? (via === "owner" ? sessionTag : undefined)
        if (sessionTag !== undefined) {
          yield* database.execute(`UPDATE ${OWNER_TABLE} SET session_tag = ? WHERE singleton = 1 AND person_id = ?`, [sessionTag, owner])
        }
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
    yield* Effect.sync(() => options.report(owner, outcome, continuous, owner === undefined ? undefined : sessionTag))
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

/** Malformed diagnostic tags never leave the device because they cannot identify a prior session. */
const tagOf = (value: unknown) => typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? value : undefined

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
  const sessionTag = tagOf(receipt.sessionTag)
  return {
    _tag: IDENTITY_MESSAGE,
    owner: receipt.owner,
    outcome: receipt.outcome,
    ...(receipt.reopen === true ? { reopen: true } : {}),
    ...(receipt.continuous === true ? { continuous: true } : {}),
    ...(sessionTag === undefined ? {} : { sessionTag }),
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
  /** Shared durable transport state, on the same device store that sign-out wipes. Memory-only pages supply memory. */
  readonly credentialStorage?: {
    readonly get: (key: string) => Promise<string | null>
    readonly set: (key: string, value: string) => Promise<void>
  }
  /** Serializes publication across contexts; a supplied signal cancels a queued lock acquisition. */
  readonly withCredential?: <A>(action: () => Promise<A>, signal?: AbortSignal) => Promise<A>
  /** The shared page lifecycle protects sign-out before the server request and through its wipe. */
  readonly signOut?: ((send: () => Promise<Response>) => Promise<Response>) | undefined
  /** The person whose data this context opened: an owner, `VISITOR`, or `NO_DEVICE_DATA`. */
  readonly principal: () => string
  /** Rereads use the device's recorded tag when its verified session supplied one. */
  readonly sessionTag?: (() => string | undefined) | undefined
  /** Every request to the origin's `/api/` waits for it: the activation's decision. */
  readonly ready?: Promise<void> | undefined
  /**
   * Starts a new activation: true when the page reopens, false when it held the reopen back (main.tsx reopens once a
   * minute at most, `reopenDue`). Without it, nothing reopens (the engine worker).
   */
  readonly reauthorize?: (() => Promise<boolean>) | undefined
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
 * Whether a reopen may go now: none was asked for under `mark` in `marks` (sessionStorage, which outlives the tab's
 * reloads) within `within` ms of `now`. Only an accepted reopen records the mark, at its lifecycle boundary.
 * Storage that cannot be read skips the throttle.
 */
export const reopenDue = (marks: Pick<Storage, "getItem" | "setItem">, mark: string, within: number, now: number) => {
  try {
    const last = marks.getItem(mark)
    return last === null || now - Number(last) >= within
  } catch {
    // Blocked storage cannot prevent identity recovery.
    return true
  }
}

/**
 * The page's and the engine worker's transport under Effect's HttpClient (`FetchHttpClient.Fetch`), around `next`, the
 * browser's: every request to this origin's `/api/` waits for `ready`, then carries the person whose data this context
 * opened (`principal`), so ChatApi refuses it under another person's cookie. A context that opened nothing of the
 * device's says so (`NO_DEVICE_DATA`) and acts as its cookie's person. With `reauthorize`, every session answer checks
 * the activation again: its own, or one it reads after a `401`. A stale one (`stale`) starts a new activation, and this
 * request and every later one fail as unsent, so a queued write waits for its owner instead of being refused, until the
 * page has loaded again, unless the page held that reopen back; a context bound to the visitor's data asks its leader to
 * `adopt` it for the person first, and reopens only when that is refused. A write that opts in (`CONFIRM_401_HEADER`)
 * has its `401` checked against the session: still its person, the refusal comes back marked (`SESSION_CHECK_HEADER`),
 * so its caller holds the write (src/outbox.ts `held`); the session ended, the page reopens and the write fails as
 * unsent, except while a sign-out this page sent is ending it, whose wipe decides the write instead. This is the one
 * place a page acts on who is signed in now; Auth's session reads, startup, reconnect and `auth/refresh` alike, pass
 * through it. A `503` marked `x-smithers-credential: stale` fails as `credential_stale` before any status handler:
 * durable retries keep the write, and this transport sends no later write until `Retry-After` has elapsed and a
 * tagged session reread verifies its bound person.
 */
export const boundFetch = (next: typeof globalThis.fetch, binding: Binding): typeof globalThis.fetch => {
  const { origin, principal, ready = Promise.resolve(), reauthorize, reopensOnSignIn = () => false, adopt } = binding
  let recovering: Promise<boolean> | undefined
  let adopting: Promise<Adoption> | undefined
  let credential: string | null = null
  let verifiedCredential: string | null = null
  let transientPerson: string | undefined
  // A refused storage write cannot erase a deadline this transport already observed.
  const pendingCredentials = new Map<string, { readonly until: number; readonly personId: string | undefined }>()
  const publications = new Map<string, { readonly attempt: () => Promise<void> }>()
  const credentialStorage = binding.credentialStorage ?? {
    get: async (_key: string) => credential,
    set: async (_key: string, value: string) => { credential = value },
  }
  const withCredential: NonNullable<Binding["withCredential"]> = binding.withCredential ?? (<A>(action: () => Promise<A>) => action())
  // Sign-outs this page sent that ChatApi hasn't answered, and whether ChatApi took one: its wipe comes next, and a
  // reopen now would stop the sign-out before it marks the wipe (decision 0023).
  let signingOut = 0
  let signedOut = false
  const reopen = async () => {
    const reopening = (recovering ??= reauthorize!())
    // A reopen the page held back leaves this context as it was: later requests go on, and a later answer may reopen it.
    try {
      if (!(await reopening) && recovering === reopening) recovering = undefined
    } catch (error) {
      if (recovering === reopening) recovering = undefined
      throw error
    }
  }
  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    // The opt-in is the page's own: it never leaves the page, whatever the request.
    const headers = new Headers(request.headers)
    const confirming = headers.has(CONFIRM_401_HEADER)
    headers.delete(CONFIRM_401_HEADER)
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) {
      return next(confirming ? new Request(request, { headers }) : request)
    }
    await ready
    // A request made while the visitor's data is being adopted goes once it is, as its new owner's.
    await adopting
    if (recovering !== undefined) {
      // Cancellation leaves the current binding intact, including requests already waiting for the decision.
      const reopening = recovering
      const accepted = await reopening.catch(() => false)
      if (accepted) throw new DeviceIdentityRefused({ reason: "reauthorizing" })
      if (recovering === reopening) recovering = undefined
    }
    const bound = principal()
    headers.set(DEVICE_PERSON_HEADER, bound)
    headers.set(ACCEPTS_HEADER, "credential-stale")
    const signOut = url.pathname === SIGN_OUT_ROUTE && request.method === "POST"
    const credentialKey = `outbox:credential:${encodeURIComponent(bound)}`
    const readCredential = async () => {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(CREDENTIAL_LOCK_WAIT_MS)])
      try {
        return await withCredential(() => credentialStorage.get(credentialKey), signal)
      } catch (error) {
        if (signal.aborted) throw new DeviceIdentityRefused({ reason: "credential_stale", stage: "credential_lock",
          wait: request.signal.aborted ? "cancelled" : "deadline" })
        throw error
      }
    }
    const publishCredential = (): Promise<void> => {
      const existing = publications.get(credentialKey)
      if (existing !== undefined) return existing.attempt()
      let acquired!: () => void
      let acquisitionFailed!: (error: unknown) => void
      const ready = new Promise<void>((resolve, reject) => { acquired = resolve; acquisitionFailed = reject })
      let release!: () => void
      const released = new Promise<void>(resolve => { release = resolve })
      let active = true
      let tail = Promise.resolve()
      const publication = {
        attempt: () => {
          const attempt = tail.then(async () => {
            await ready
            if (!active) return
            const pending = pendingCredentials.get(credentialKey)
            if (pending !== undefined) {
              const prior = await credentialStorage.get(credentialKey)
              const previous = prior === null ? undefined : JSON.parse(prior) as { until: number; personId?: string }
              await credentialStorage.set(credentialKey, JSON.stringify({
                until: Math.max(previous?.until ?? 0, pending.until), revision: crypto.randomUUID(),
                personId: previous?.personId ?? pending.personId,
              }))
              // Another response may have extended the deadline while storage was awaiting its write.
              if (pendingCredentials.get(credentialKey) === pending) pendingCredentials.delete(credentialKey)
            }
            if (!pendingCredentials.has(credentialKey)) {
              active = false
              if (publications.get(credentialKey) === publication) publications.delete(credentialKey)
              release()
            }
          })
          // No automatic retry: a later ordinary request supplies the next attempt inside this same lock.
          tail = attempt.catch(() => undefined)
          return attempt
        },
      }
      publications.set(credentialKey, publication)
      // A storage rejection retains the cross-context fence. Retrying uses the held lock instead of waiting for
      // itself; a successor cannot read absent/older state while this transport still has an unpublished refusal.
      void (async () => withCredential(async () => { acquired(); await released }))().catch(error => {
        active = false
        if (publications.get(credentialKey) === publication) publications.delete(credentialKey)
        acquisitionFailed(error)
      })
      return publication.attempt()
    }
    // Internal session rereads publish the same durable delay as ordinary responses.
    const observeCredential = async (response: Response) => {
      if (response.status === 503 && response.headers.get("x-smithers-credential") === "stale") {
        const after = response.headers.get("retry-after")
        const seconds = after === null ? NaN : Number(after)
        const until = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000 : Date.parse(after ?? "")
        pendingCredentials.set(credentialKey, {
          until: Math.max(pendingCredentials.get(credentialKey)?.until ?? 0, Number.isFinite(until) ? until : 0),
          personId: bound === NO_DEVICE_DATA ? transientPerson : undefined,
        })
        // Start one serialized publication, but expose the observed refusal immediately: a stalled lock or store
        // must not turn it into AuthClient's generic timeout and leave private rows visible. The local hold remains
        // until publication completes; later outbox attempts await publication before any send and own its retries.
        void publishCredential().catch(() => undefined)
        throw new DeviceIdentityRefused({ reason: "credential_stale" })
      }
      return response
    }
    const readCurrent = async () => {
      const tag = tagOf(binding.sessionTag?.())
      // The reread shares the caller's cancellation and never carries a tag in a URL or diagnostic record.
      const response = await next(new Request(`${origin}${SESSION_ROUTE}`, {
        cache: "no-store", signal: request.signal,
        headers: { [ACCEPTS_HEADER]: "credential-stale", ...(tag === undefined ? {} : { "x-smithers-session-tag": tag }) },
      })).catch(() => undefined)
      return response === undefined ? undefined : observeCredential(response)
    }
    const checkIdentity = async (session: State | undefined) => {
      if (reauthorize === undefined || !stale(bound, reopensOnSignIn(), session)) return false
      const adoption = bound === VISITOR && adopt !== undefined
        ? await (adopting ??= adopt(session!, request.signal).finally(() => (adopting = undefined)))
        : "refused"
      if (adoption === "adopted") return true
      if (adoption === "unavailable") throw new DeviceIdentityRefused({ reason: "adopting" })
      await reopen()
      throw new DeviceIdentityRefused({ reason: "reauthorizing" })
    }
    // The outbox owns retries. A retry cannot resend a held write until the server's delay and an owner reread agree.
    const writing = request.method !== "GET" && request.method !== "HEAD" && !signOut
    // Adoption can change this transport's principal in place. Recover every held controller under its original
    // key, including the visitor's; otherwise its global lock would strand the adopted owner's writes forever.
    const attempts = [...publications].filter(([key]) => key !== credentialKey).map(([, publication]) => publication.attempt())
    if (pendingCredentials.has(credentialKey)) attempts.push(publishCredential())
    if (attempts.length > 0) {
      const publication = Promise.all(attempts)
      if (writing) {
        await publication.catch(() => { throw new DeviceIdentityRefused({ reason: "credential_stale" }) })
        if (pendingCredentials.has(credentialKey) || publications.size > 0) throw new DeviceIdentityRefused({ reason: "credential_stale" })
      } else {
        // Session reads and explicit sign-out stay usable while storage is blocked. Their ordinary traffic can
        // recover a failed publication even when a different page or worker owns the waiting outbox write.
        void publication.catch(() => undefined)
      }
    }
    // A successor respects an unpublished refusal, but a failed publisher cannot strand its request or lock waiter.
    const held = writing ? await readCredential() : null
    if (held !== null && held !== verifiedCredential) {
      const gate = JSON.parse(held) as { until: number; personId?: string }
      const expected = bound === NO_DEVICE_DATA ? gate.personId ?? transientPerson : bound
      if (Date.now() < gate.until) throw new DeviceIdentityRefused({ reason: "credential_stale" })
      const checked = await readCurrent()
      const session = checked?.ok ? readSession(await checked.json().catch(() => undefined)) : undefined
      await checkIdentity(session)
      if (session !== undefined && !session.signedIn && reauthorize !== undefined) {
        if (signingOut === 0 && !signedOut) await reopen()
        throw new DeviceIdentityRefused({ reason: "signed_out" })
      }
      if (session?.signedIn !== true || (expected !== undefined && session.personId !== expected) || principal() !== bound || await readCredential() !== held) {
        throw new DeviceIdentityRefused({ reason: "credential_stale" })
      }
      verifiedCredential = held
      // A transient page has no retained owner. Its verified person still fences this send against a cookie swap.
      if (bound === NO_DEVICE_DATA) transientPerson = session.personId
    }
    if (writing && held !== null && bound === NO_DEVICE_DATA && transientPerson !== undefined) headers.set(DEVICE_PERSON_HEADER, transientPerson)
    if (signOut) signingOut++
    const send = () => next(new Request(request, { headers }))
    const response = await (signOut && binding.signOut !== undefined ? binding.signOut(send) : send()).finally(() => {
      if (signOut) signingOut--
    })
    if (signOut && response.ok) signedOut = true
    await observeCredential(response)
    if (reauthorize === undefined) return response
    // Who the browser is signed in as now: this answer, when it is the session's; after a refusal, asked again.
    const answered = url.pathname === SESSION_ROUTE
      ? response.clone()
      : response.status === 401
      // expected: a session read that fails tells nothing new
      ? await readCurrent()
      : undefined
    // expected: an unreadable session body names no session
    const session = answered?.ok === true ? readSession(await answered.json().catch(() => undefined)) : undefined
    // A memory page's first verified person fences its held transient writes without opening device data.
    if (bound === NO_DEVICE_DATA && session?.signedIn === true) transientPerson ??= session.personId
    if (await checkIdentity(session)) return response
    // A write that opted in (CONFIRM_401_HEADER) and was refused 401 in a person's data: the session read decides.
    if (confirming && response.status === 401 && bound !== VISITOR && bound !== NO_DEVICE_DATA) {
      // No session answer: nobody can say whether the person is still signed in, so the write fails as unsent, stays
      // queued, and is checked again when it is sent again.
      if (session === undefined) throw new DeviceIdentityRefused({ reason: "unchecked" })
      // The session ended: the page reopens, as for another person, and its activation decides the device's data, this
      // write's included. Meanwhile the write fails as unsent, so it stays queued for that decision. A sign-out this page
      // sent ended it: the page stays open for the sign-out to mark its wipe, which deletes the write with the rest.
      if (!session.signedIn) {
        if (signingOut === 0 && !signedOut) await reopen()
        throw new DeviceIdentityRefused({ reason: "signed_out" })
      }
      // Still the same person: the refusal stands, marked, for the caller to hold the write until they sign in again.
      if (session.personId === bound) {
        const marked = new Headers(response.headers)
        marked.set(SESSION_CHECK_HEADER, "same_person")
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: marked })
      }
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
