import { Result } from "effect"
import { timingSafeEqualString, validateCodeVerifier } from "../mcp/Pkce.ts"

// BYOA attach (decision 0173, Gate 4): how a person's own agent (Claude Code, Codex, Cursor) gets a grant to act in one
// conversation. The person copies a prompt holding an attach reference such as `K7QF-2MXD`. The reference is opaque,
// single use and lives 10 minutes, and it carries no authority: an agent that claims it gets only an opaque claim
// receipt and a pairing code, and learns nothing about the target. Nothing becomes usable until the same person, in
// their own session on the host origin, reviews the claim and enters the pairing code their agent shows. The approval
// returns a one-time code that only the claimant's PKCE verifier redeems, for a bearer token bound to one person,
// repository, branch and conversation, with a capability ceiling and `act: "agent"`. The store keeps SHA-256 digests
// of codes and tokens, never the values.
//
// Who may grant: mint, consent, approve and revoke take the session's verified `Actor` (worker/Actor.ts) and the
// actual `Request`. An actor carrying `act` is an agent, flow, frame or sandbox acting for the person and is refused
// `person_only`. The person is read from the actor, the Origin from the request's own header, and the ceiling is the
// requested capabilities intersected with what `permissions` says the person holds on the target now.

/** How long a minted reference can be claimed. */
export const INTENT_TTL_MS = 10 * 60 * 1000

/** How long a consent view stays approvable. The person reopens the card for a fresh one. */
export const CONSENT_TTL_MS = 2 * 60 * 1000

/** How long an approval's code can be redeemed. */
export const CODE_TTL_MS = 60 * 1000

/** How long a grant's token works, unless revoked first. */
export const GRANT_TTL_MS = 8 * 60 * 60 * 1000

/** Wrong pairing codes a claim survives. The next one burns the reference. */
export const MAX_PAIRING_ATTEMPTS = 5

/** Default caps on what one deployment's attach state holds. A full store refuses `too_many`, it never grows. */
export const ATTACH_LIMITS = {
  /** Unredeemed references across the deployment. */
  intents: 4096,
  /** Unredeemed references one person holds at once. */
  intentsPerPerson: 16,
  /** Live grants across the deployment. */
  tokens: 8192,
  /** Remembered revocations. Past the cap the oldest is forgotten, and its token then reads `unauthenticated`. */
  revocations: 8192,
} as const
export type AttachLimits = { readonly [K in keyof typeof ATTACH_LIMITS]: number }

/** Crockford base32 without I, L, O and U, so a reference reads aloud and survives a retype. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** A reference as the person sees it: two groups of four. */
export const REFERENCE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/

/** A pairing code as the agent shows it and the person types it: six digits. */
export const PAIRING_PATTERN = /^[0-9]{6}$/

/**
 * An RFC 7636 S256 challenge (section 4.2): the unpadded base64url of a 32-byte digest. That is exactly 43
 * characters, and the last one carries four data bits, so only 16 letters can end a canonical challenge.
 */
export const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/

/** What a grant is bound to. A token works only for this target. */
export interface Target {
  readonly repo: string
  readonly branch: string
  readonly conversation: string
}

/** A grant as the MCP route reads it. `act` is always the agent: a grant never carries the person's own authority. */
export interface Grant extends Target {
  readonly id: string
  readonly person: string
  readonly ceiling: ReadonlyArray<string>
  readonly act: "agent"
  readonly client: string
  readonly expiresAt: number
}

/** Why an attach step is refused. Every refusal names a code and nothing about other people's intents or grants. */
export type AttachRefusal =
  | "unknown_reference"
  | "expired"
  | "already_claimed"
  | "not_claimed"
  | "wrong_origin"
  | "wrong_person"
  | "person_only"
  | "forbidden"
  | "invalid_challenge"
  | "consent_expired"
  | "wrong_pairing"
  | "invalid_code"
  | "invalid_verifier"
  | "too_many"
  | "unauthenticated"
  | "revoked"
  | "wrong_target"

interface Claim {
  readonly id: string
  readonly client: string
  readonly challenge: string
  readonly pairing: string
  attempts: number
}

interface Intent extends Target {
  readonly reference: string
  readonly person: string
  readonly ceiling: ReadonlyArray<string>
  readonly expiresAt: number
  claim?: Claim
  /** When the consent view the person last opened stops being approvable. */
  consentUntil?: number
  /**
   * The claim's one approval. `pending` is taken synchronously before an approval's first await, so a concurrent
   * approval of the same claim sees it and is refused. It returns to unset only when that approval fails its pairing
   * check. Once `approved` it never changes, and the intent is dropped when its code is redeemed or goes stale.
   */
  approval?: "pending" | "approved"
  /** The digest of the approval's code, so the code goes when the intent does. */
  code?: string
}

interface Code {
  /** The reference of the intent that issued this code. A code whose intent is gone or expired is dead. */
  readonly reference: string
  readonly claim: string
  readonly challenge: string
  readonly grant: Grant
  readonly expiresAt: number
}

/**
 * The person's own verified session and the request it arrived with. `actor` is what `Sessions` resolved, never a
 * value read from a body. `request` is the actual request, so the Origin checked is the one the browser sent.
 */
export interface PersonRequest {
  readonly actor: {
    readonly subject: { readonly kind: "person"; readonly id: string }
    readonly act?: { readonly kind: "agent" | "flow" | "app" | "sandbox" }
  }
  readonly request: Request
}

export interface AttachOptions {
  /** The host origin a person approves from, such as `https://smithers.sh`. */
  readonly hostOrigin: string
  /**
   * The capabilities `person` holds on `target` now, or `undefined` when they may not act there at all. Asked at mint,
   * at approval and on every bearer request, so a person who loses a permission loses it in their grants too.
   */
  readonly permissions: (
    person: string,
    target: Target,
  ) => ReadonlyArray<string> | undefined | Promise<ReadonlyArray<string> | undefined>
  readonly limits?: Partial<AttachLimits>
  readonly now?: () => number
  readonly random?: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>
}

const encoder = new TextEncoder()

const targetOf = (target: Target): Target => ({ repo: target.repo, branch: target.branch, conversation: target.conversation })

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

const sha256 = async (text: string): Promise<string> =>
  base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))))

/** The PKCE S256 challenge for a verifier (RFC 7636 section 4.2). */
export const challengeFor = (verifier: string): Promise<string> => sha256(verifier)

/** Uppercases and trims a pasted reference, and maps the letters Crockford base32 reads as digits. */
export const normalizeReference = (raw: string): string =>
  raw.trim().toUpperCase().replaceAll("O", "0").replaceAll("I", "1").replaceAll("L", "1")

/** A grant nothing can change: a fresh frozen copy with its own frozen ceiling. */
export const freezeGrant = (grant: Grant, ceiling: ReadonlyArray<string> = grant.ceiling): Grant =>
  Object.freeze({
    id: grant.id,
    person: grant.person,
    repo: grant.repo,
    branch: grant.branch,
    conversation: grant.conversation,
    ceiling: Object.freeze([...ceiling]),
    act: "agent" as const,
    client: grant.client,
    expiresAt: grant.expiresAt,
  })

/**
 * The attach state of one deployment, in memory. A sweep visits every entry: insertion order is not expiry order
 * (a code is capped by its intent's deadline, the clock is injectable), so it never stops at the first live entry.
 * The caps bound each map, so a sweep is O(cap). Each check that follows an await runs synchronously with the write
 * it guards, so concurrent calls cannot both pass a single-use or capacity check.
 */
export const makeAttach = (options: AttachOptions) => {
  const now = options.now ?? Date.now
  const random = options.random ?? ((bytes: Uint8Array<ArrayBuffer>) => crypto.getRandomValues(bytes))
  const limits: AttachLimits = { ...ATTACH_LIMITS, ...options.limits }
  const intents = new Map<string, Intent>()
  const claims = new Map<string, string>()
  const codes = new Map<string, Code>()
  const tokens = new Map<string, Grant>()
  /** Revoked token digests, each with its grant's expiry: past it the token would be dead anyway. */
  const revoked = new Map<string, number>()

  const opaque = (bytes: number) => base64Url(random(new Uint8Array(bytes)))

  const dropIntent = (intent: Intent) => {
    intents.delete(intent.reference)
    if (intent.claim !== undefined) claims.delete(intent.claim.id)
    if (intent.code !== undefined) codes.delete(intent.code)
  }

  /**
   * Forgets everything expired: references with their claims and codes, codes that expired (with their spent intent)
   * or whose intent is gone, tokens and revocations. Every entry is checked, in any order.
   */
  const sweep = (at: number) => {
    for (const intent of [...intents.values()]) if (intent.expiresAt <= at) dropIntent(intent)
    for (const [key, code] of codes) {
      const intent = intents.get(code.reference)
      if (intent === undefined || intent.code !== key) codes.delete(key)
      // An approved claim whose code lapsed is spent: the intent goes with it, so it can never issue another.
      else if (code.expiresAt <= at) dropIntent(intent)
    }
    for (const [key, grant] of tokens) if (grant.expiresAt <= at) tokens.delete(key)
    for (const [key, until] of revoked) if (until <= at) revoked.delete(key)
  }

  /** The person behind a root session on the host origin, or why the request is not one. */
  const personOf = (input: PersonRequest): Result.Result<string, AttachRefusal> => {
    // Anyone acting for the person (RFC 8693 `act`) is not the person. Only their own session grants and revokes.
    if (input.actor.act !== undefined) return Result.fail("person_only")
    if (input.actor.subject.kind !== "person" || input.actor.subject.id === "") return Result.fail("unauthenticated")
    if (input.request.headers.get("origin") !== options.hostOrigin) return Result.fail("wrong_origin")
    return Result.succeed(input.actor.subject.id)
  }

  /** `ceiling` narrowed to what the person holds on `target` now, or `undefined` when they hold nothing there. */
  const allowed = async (person: string, target: Target, ceiling: ReadonlyArray<string>) => {
    const held = await options.permissions(person, target)
    if (held === undefined) return undefined
    return [...new Set(ceiling)].filter((capability) => held.includes(capability))
  }

  const newReference = (): string => {
    for (;;) {
      const bytes = random(new Uint8Array(8))
      const chars = Array.from(bytes, (byte) => ALPHABET[byte % 32])
      const reference = `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`
      if (!intents.has(reference)) return reference
    }
  }

  /** Six digits, drawn without modulo bias. */
  const newPairing = (): string => {
    for (;;) {
      const value = new DataView(random(new Uint8Array(4)).buffer).getUint32(0)
      if (value < 4_294_000_000) return String(value % 1_000_000).padStart(6, "0")
    }
  }

  /**
   * Step 1, in the person's own session on the host origin: a reference for the copied prompt. The target is read
   * field by field, and the ceiling kept is the requested one narrowed to the person's permissions on that target.
   */
  const mintIntent = async (input: PersonRequest & {
    readonly repo: string
    readonly branch: string
    readonly conversation: string
    readonly ceiling: ReadonlyArray<string>
  }): Promise<Result.Result<{ readonly reference: string; readonly expiresAt: number; readonly ceiling: ReadonlyArray<string> }, AttachRefusal>> => {
    const person = personOf(input)
    if (Result.isFailure(person)) return Result.fail(person.failure)
    const target: Target = { repo: input.repo, branch: input.branch, conversation: input.conversation }
    const ceiling = await allowed(person.success, target, input.ceiling)
    if (ceiling === undefined) return Result.fail("forbidden")
    const at = now()
    sweep(at)
    if (intents.size >= limits.intents) return Result.fail("too_many")
    let held = 0
    for (const intent of intents.values()) if (intent.person === person.success) held += 1
    if (held >= limits.intentsPerPerson) return Result.fail("too_many")
    const reference = newReference()
    const expiresAt = at + INTENT_TTL_MS
    intents.set(reference, { ...target, person: person.success, ceiling: Object.freeze(ceiling), reference, expiresAt })
    return Result.succeed({ reference, expiresAt, ceiling })
  }

  /**
   * Step 2, from the agent: claims a reference with a PKCE S256 challenge. The first claim wins. The answer is an
   * opaque receipt and a pairing code for the agent to show, and nothing else: a reference holder learns no
   * repository, branch, conversation or person. A thief who claims first holds a pairing code the person never sees,
   * so the person cannot approve the thief's claim by mistake.
   */
  const claimIntent = (input: { readonly reference: string; readonly client: string; readonly challenge: string }):
    Result.Result<{ readonly claim: string; readonly pairing: string }, AttachRefusal> => {
    if (!S256_CHALLENGE_PATTERN.test(input.challenge)) return Result.fail("invalid_challenge")
    const at = now()
    sweep(at)
    const reference = normalizeReference(input.reference)
    const intent = REFERENCE_PATTERN.test(reference) ? intents.get(reference) : undefined
    if (intent === undefined) return Result.fail("unknown_reference")
    if (intent.claim !== undefined) return Result.fail("already_claimed")
    const claim = opaque(16)
    const pairing = newPairing()
    intent.claim = { id: claim, client: input.client.slice(0, 128), challenge: input.challenge, pairing, attempts: 0 }
    claims.set(claim, reference)
    return Result.succeed({ claim, pairing })
  }

  /**
   * What the consent card shows the person for their own reference: the target, the ceiling, the claim under review
   * and who claimed it. The pairing code is not here. The person reads it from their agent. The view is approvable
   * until `expiresAt`.
   */
  const consentFor = (input: PersonRequest & { readonly reference: string }) => {
    const person = personOf(input)
    if (Result.isFailure(person)) return Result.fail(person.failure)
    const at = now()
    sweep(at)
    const intent = intents.get(normalizeReference(input.reference))
    if (intent === undefined || intent.person !== person.success) return Result.fail("unknown_reference" as const)
    if (intent.claim === undefined) return Result.fail("not_claimed" as const)
    intent.consentUntil = Math.min(at + CONSENT_TTL_MS, intent.expiresAt)
    return Result.succeed({
      repo: intent.repo,
      branch: intent.branch,
      conversation: intent.conversation,
      ceiling: intent.ceiling,
      claim: intent.claim.id,
      client: intent.claim.client,
      expiresAt: intent.consentUntil,
    })
  }

  /**
   * Step 3, in the minting person's own session on the host origin: approves exactly the claim the person reviewed,
   * named by its claim id and the pairing code its agent shows, and returns a one-time code for the claimant. The
   * grant's ceiling is narrowed again to the person's permissions at this moment. A claim is approved at most once:
   * the reservation is taken before the first await, so of two concurrent approvals exactly one issues a code.
   */
  const approveIntent = async (input: PersonRequest & { readonly claim: string; readonly pairing: string }):
    Promise<Result.Result<{ readonly code: string }, AttachRefusal>> => {
    const person = personOf(input)
    if (Result.isFailure(person)) return Result.fail(person.failure)
    const at = now()
    sweep(at)
    const intent = intents.get(claims.get(input.claim) ?? "")
    if (intent === undefined || intent.claim === undefined || intent.claim.id !== input.claim) {
      return Result.fail("unknown_reference")
    }
    if (intent.person !== person.success) return Result.fail("wrong_person")
    if (intent.approval !== undefined) return Result.fail("already_claimed")
    if (intent.consentUntil === undefined || intent.consentUntil <= at) return Result.fail("consent_expired")
    // Reserved synchronously, before the first await: a concurrent approval of this claim now reads `already_claimed`.
    intent.approval = "pending"
    const claim = intent.claim
    if (!PAIRING_PATTERN.test(input.pairing) || !timingSafeEqualString(input.pairing, claim.pairing)) {
      delete intent.approval
      claim.attempts += 1
      if (claim.attempts >= MAX_PAIRING_ATTEMPTS) dropIntent(intent)
      return Result.fail("wrong_pairing")
    }
    const code = opaque(32)
    let key: string
    let ceiling: Array<string> | undefined
    try {
      key = await sha256(code)
      ceiling = await allowed(intent.person, targetOf(intent), intent.ceiling)
    } catch (error) {
      // Fail closed: a reservation that cannot finish burns the reference rather than staying pending.
      dropIntent(intent)
      throw error
    }
    const settled = now()
    if (intents.get(intent.reference) !== intent || intent.expiresAt <= settled) {
      dropIntent(intent)
      return Result.fail("unknown_reference")
    }
    if (ceiling === undefined) {
      dropIntent(intent)
      return Result.fail("forbidden")
    }
    // Consumed for good: nothing resets `approved`, and the intent goes when its code is redeemed or goes stale.
    intent.approval = "approved"
    intent.code = key
    const grant = freezeGrant({
      id: opaque(12),
      person: intent.person,
      repo: intent.repo,
      branch: intent.branch,
      conversation: intent.conversation,
      ceiling,
      act: "agent",
      client: claim.client,
      expiresAt: at + GRANT_TTL_MS,
    })
    codes.set(key, {
      reference: intent.reference,
      claim: claim.id,
      challenge: claim.challenge,
      grant,
      // A code never outlives the reference that issued it.
      expiresAt: Math.min(at + CODE_TTL_MS, intent.expiresAt),
    })
    return Result.succeed({ code })
  }

  /**
   * Step 4, from the agent: trades the code and its PKCE verifier for the grant's bearer token, once. The store is
   * swept before the code is read, and a code whose intent is gone, expired or issued another code reads
   * `invalid_code`. The code is consumed before the verifier is read, so a wrong verifier burns it. Token capacity is
   * checked in the same synchronous step that stores the token, so concurrent redemptions cannot pass the cap.
   */
  const redeemCode = async (input: { readonly claim: string; readonly code: string; readonly verifier: string }):
    Promise<Result.Result<{ readonly token: string; readonly grant: Grant }, AttachRefusal>> => {
    const key = await sha256(input.code)
    const at = now()
    sweep(at)
    const entry = codes.get(key)
    if (entry === undefined || entry.claim !== input.claim) return Result.fail("invalid_code")
    codes.delete(key)
    const intent = intents.get(entry.reference)
    // The sweep already enforced these. They are checked again here so the single-use rule does not rest on it.
    const live = intent !== undefined && intent.code === key && intent.expiresAt > at && entry.expiresAt > at
    if (intent !== undefined) dropIntent(intent)
    if (!live) return Result.fail("invalid_code")
    // RFC 7636 section 4.1: 43 to 128 unreserved characters, checked before the verifier is hashed.
    if (!validateCodeVerifier(input.verifier)) return Result.fail("invalid_verifier")
    if (!timingSafeEqualString(await challengeFor(input.verifier), entry.challenge)) return Result.fail("invalid_verifier")
    const token = `smat_${opaque(32)}`
    const tokenKey = await sha256(token)
    // No await from here to the write: the capacity check and the insertion are one step.
    sweep(now())
    if (tokens.size >= limits.tokens) return Result.fail("too_many")
    tokens.set(tokenKey, entry.grant)
    return Result.succeed({ token, grant: freezeGrant(entry.grant) })
  }

  /** Ends a grant now. Only its own person, in their own session, can revoke it. Later requests read `revoked`. */
  const revokeGrant = (input: PersonRequest & { readonly grant: string }): Result.Result<void, AttachRefusal> => {
    const person = personOf(input)
    if (Result.isFailure(person)) return Result.fail(person.failure)
    const at = now()
    sweep(at)
    for (const [key, grant] of tokens) {
      if (grant.id !== input.grant) continue
      if (grant.person !== person.success) return Result.fail("wrong_person")
      tokens.delete(key)
      if (revoked.size >= limits.revocations) revoked.delete(revoked.keys().next().value!)
      revoked.set(key, grant.expiresAt)
      return Result.void
    }
    return Result.fail("unknown_reference")
  }

  /**
   * Reads an `Authorization` header as a grant for `target`. Runs on every MCP request. A reference, a code or a
   * token from another deployment reads as `unauthenticated`. The grant returned is a fresh frozen copy whose ceiling
   * is narrowed to what the person holds now, and `forbidden` when the person no longer holds anything there.
   */
  const verifyBearer = async (authorization: string | null, target: Omit<Target, "conversation">):
    Promise<Result.Result<Grant, AttachRefusal>> => {
    const match = /^Bearer (smat_[A-Za-z0-9_-]{43})$/.exec(authorization ?? "")
    if (match === null) return Result.fail("unauthenticated")
    const key = await sha256(match[1]!)
    const at = now()
    const until = revoked.get(key)
    if (until !== undefined && until > at) return Result.fail("revoked")
    const grant = tokens.get(key)
    if (grant === undefined) return Result.fail("unauthenticated")
    if (grant.expiresAt <= at) {
      tokens.delete(key)
      return Result.fail("expired")
    }
    if (grant.repo !== target.repo || grant.branch !== target.branch) return Result.fail("wrong_target")
    const ceiling = await allowed(grant.person, targetOf(grant), grant.ceiling)
    // A revocation during the permission lookup wins: the token must still be live after the await.
    if (tokens.get(key) !== grant) return Result.fail(revoked.has(key) ? "revoked" : "unauthenticated")
    if (ceiling === undefined) return Result.fail("forbidden")
    return Result.succeed(freezeGrant(grant, ceiling))
  }

  /** How many entries each store holds, for tests and metrics. It carries no content. */
  const sizes = () => ({
    intents: intents.size,
    claims: claims.size,
    codes: codes.size,
    tokens: tokens.size,
    revocations: revoked.size,
  })

  return { mintIntent, claimIntent, consentFor, approveIntent, redeemCode, revokeGrant, verifyBearer, sizes }
}

export type Attach = ReturnType<typeof makeAttach>
