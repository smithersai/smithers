/**
 * Scoped, expiring gateway tokens.
 *
 * A gateway's configured bearer credential grants everything the gateway
 * serves, for as long as it is configured. A scoped token is a grant the
 * holder of that credential mints for someone else: a closed list of
 * procedures, optionally confined to one run or one flow, and an expiry. It
 * is signed with HMAC-SHA256 under the bearer credential, so a gateway
 * verifies it with the key it already holds and stores nothing; rotating the
 * bearer credential revokes every token minted under it.
 *
 * The wire form is `smt1.<claims>.<signature>`, both parts unpadded base64url,
 * the claims a canonical JSON document. A token names procedures rather than
 * scope words so that what it authorizes is readable off the token itself and
 * does not change when a scope grows.
 *
 * Effect's WebCrypto reference supplies signing and randomness; its Clock
 * supplies time unless an explicit now override is passed. Both can be
 * provided without replacing process globals.
 *
 * @since 1.0.0
 */

import { Clock, Effect, Result, Schema } from "effect"
import * as WebCrypto from "effect/crypto/WebCrypto"
import { Base64Url, Hex } from "effect/encoding"
import { Unauthorized } from "./ControlError.ts"
import { type Authenticator, bearerCredential, type Call } from "./ControlRpcs.ts"
import type { Principal } from "./ControlSchema.ts"

/**
 * The version prefix every scoped token starts with.
 *
 * @category constants
 * @since 1.0.0
 */
export const prefix = "smt1"

/**
 * The scopes `smthrs token mint --scope` accepts, and the procedures each
 * one names.
 *
 * `read:runs` covers every read the control plane and the gateway serve.
 * `write:runs` covers the mutations that start, steer, signal, cancel, and
 * resume a run, and the gateway's `Run.Fork` and `Run.Verify`, which branch a
 * run or drive the project's flow code over a copy of it. `approve:runs` covers the approval decisions on both mounts.
 * A token holding `approve:runs` still needs the host's `ApprovalAuthority`
 * to delegate to its principal, exactly as the bearer does.
 *
 * @category constants
 * @since 1.0.0
 */
export const scopes = {
  "read:runs": ["List", "Watch", "Projection.Snapshot", "Projection.Subscribe"],
  "write:runs": ["Plan", "Run", "Steer", "Signal", "Cancel", "Resume", "Run.Fork", "Run.Verify"],
  "approve:runs": ["Approve", "Deny", "Approval.Submit"]
} as const satisfies Record<string, ReadonlyArray<string>>

/**
 * One scope name.
 *
 * @category models
 * @since 1.0.0
 */
export type Scope = keyof typeof scopes

/**
 * Every scope name, in the order {@link scopes} declares them.
 *
 * @category constants
 * @since 1.0.0
 */
export const scopeNames: ReadonlyArray<Scope> = Object.keys(scopes) as Array<Scope>

/**
 * What a token grants, as signed.
 *
 * @category models
 * @since 1.0.0
 */
export const Claims = Schema.Struct({
  v: Schema.Literal(1),
  /** A random identifier, so two tokens with the same grant differ. */
  id: Schema.String,
  procedures: Schema.Array(Schema.String),
  runId: Schema.optional(Schema.String),
  flowId: Schema.optional(Schema.String),
  /** Minted at, milliseconds since the epoch. */
  iat: Schema.Number,
  /** Expires at, milliseconds since the epoch; refused once `now >= exp`. */
  exp: Schema.Number
})

/**
 * What a token grants, as signed.
 *
 * @category models
 * @since 1.0.0
 */
export type Claims = typeof Claims.Type

/**
 * What `mint` needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface MintOptions {
  /** The signing key: the gateway's configured bearer credential. */
  readonly key: string
  readonly scopes: ReadonlyArray<Scope>
  /** How long the token lives, in milliseconds; must be positive. */
  readonly ttlMillis: number
  /** Confine every call to this run. */
  readonly runId?: string | undefined
  /** Confine every call to this flow. */
  readonly flowId?: string | undefined
  readonly now?: (() => number) | undefined
}

/**
 * A minted token beside the claims it carries.
 *
 * @category models
 * @since 1.0.0
 */
export interface Minted {
  readonly token: string
  readonly claims: Claims
}

const encodeClaims = Schema.encodeUnknownSync(Claims)
const decodeClaims = Schema.decodeUnknownResult(Claims)
const encoder = new TextEncoder()

const subtle = (): Effect.Effect<SubtleCrypto> =>
  WebCrypto.WebCrypto.use((crypto) =>
    Effect.sync(() => {
      if (crypto?.subtle === undefined) throw new Error("Web Crypto is not available on this host")
      return crypto.subtle
    })
  )

const randomId = WebCrypto.WebCrypto.use((crypto) =>
  Effect.sync(() => {
    if (crypto?.getRandomValues === undefined) throw new Error("Web Crypto is not available on this host")
    return Hex.encode(crypto.getRandomValues(new Uint8Array(12)))
  })
)

const hmacKey = (crypto: SubtleCrypto, key: string, usage: "sign" | "verify") =>
  crypto.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [usage])

/**
 * Whether a bearer credential is spelled as a scoped token.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isScopedToken = (credential: string): boolean => credential.startsWith(`${prefix}.`)

/**
 * The procedures a list of scopes names, each once, in scope order.
 *
 * @category getters
 * @since 1.0.0
 */
export const procedures = (
  names: ReadonlyArray<Scope>
): ReadonlyArray<string> => [...new Set(names.flatMap((name) => scopes[name]))]

/**
 * Mints one token under the key.
 *
 * An empty key, no scopes, or a non-positive lifetime is a caller defect: it
 * cannot produce a token anyone should hold, so it dies rather than signs.
 *
 * @category constructors
 * @since 1.0.0
 */
export const mint = (options: MintOptions): Effect.Effect<Minted> =>
  Effect.gen(function*() {
    if (options.key.length === 0) return yield* Effect.die(new Error("A scoped token needs a non-empty signing key"))
    if (options.scopes.length === 0) return yield* Effect.die(new Error("A scoped token needs at least one scope"))
    if (!Number.isFinite(options.ttlMillis) || options.ttlMillis <= 0) {
      return yield* Effect.die(new Error("A scoped token needs a positive lifetime"))
    }
    const now = options.now === undefined ? yield* Clock.currentTimeMillis : options.now()
    const crypto = yield* subtle()
    const id = yield* randomId
    const claims: Claims = {
      v: 1,
      id,
      procedures: procedures(options.scopes),
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      ...(options.flowId === undefined ? {} : { flowId: options.flowId }),
      iat: now,
      exp: now + Math.floor(options.ttlMillis)
    }
    const body = Base64Url.encode(JSON.stringify(encodeClaims(claims)))
    return yield* Effect.promise(async () => {
      const key = await hmacKey(crypto, options.key, "sign")
      const signature = new Uint8Array(await crypto.sign("HMAC", key, encoder.encode(`${prefix}.${body}`)))
      return { token: `${prefix}.${body}.${Base64Url.encode(signature)}`, claims }
    })
  })

const refused = (message: string) => Effect.fail(new Unauthorized({ message }))

/**
 * Verifies a token's signature and expiry under the key and returns its
 * claims. Every malformation, a wrong key, and an expired token all fail with
 * the same `Unauthorized`, so the token is not a parsing oracle.
 *
 * @param now the moment to judge `exp` against, in milliseconds
 * @category verification
 * @since 1.0.0
 */
export const verify = (key: string, token: string, now: number): Effect.Effect<Claims, Unauthorized> =>
  Effect.suspend(() => {
    const parts = token.split(".")
    if (key.length === 0 || parts.length !== 3 || parts[0] !== prefix || parts[1]!.length === 0) {
      return refused("A valid scoped token is required")
    }
    const signature = Base64Url.decode(parts[2]!)
    if (Result.isFailure(signature)) return refused("A valid scoped token is required")
    return subtle().pipe(
      Effect.flatMap((crypto) =>
        Effect.promise(async () => {
          const hmac = await hmacKey(crypto, key, "verify")
          return crypto.verify("HMAC", hmac, new Uint8Array(signature.success), encoder.encode(`${prefix}.${parts[1]}`))
        })
      ),
      Effect.flatMap((valid) => {
        if (!valid) return refused("A valid scoped token is required")
        const text = Base64Url.decodeString(parts[1]!)
        if (Result.isFailure(text)) return refused("A valid scoped token is required")
        let parsed: unknown
        try {
          parsed = JSON.parse(text.success)
        } catch {
          return refused("A valid scoped token is required")
        }
        const claims = decodeClaims(parsed)
        if (Result.isFailure(claims)) return refused("A valid scoped token is required")
        if (!(now < claims.success.exp)) return refused("The scoped token has expired")
        return Effect.succeed(claims.success)
      })
    )
  })

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined

/**
 * The filters a payload names, unless the server ignores them: a `List` of
 * the flow catalog returns every flow whatever its free-form filters say, so
 * they confine nothing.
 */
const honoredFilters = (payload: unknown): unknown =>
  field(payload, "_tag") === "flows" ? undefined : field(payload, "filters")

/** The run a payload names, wherever the control and gateway schemas put it. */
const namedRun = (payload: unknown): unknown =>
  field(payload, "runId") ??
    field(field(payload, "target"), "runId") ??
    field(field(payload, "selector"), "runId") ??
    field(honoredFilters(payload), "runId")

/** The flow a payload names. */
const namedFlow = (payload: unknown): unknown => field(payload, "flowId") ?? field(honoredFilters(payload), "flowId")

/** The plan a payload names: a `Run` of a plan card, or a plan approval target. */
const namedPlan = (payload: unknown): unknown => field(payload, "planId") ?? field(field(payload, "target"), "planId")

/** The procedure and run confinement, which never needs the host. */
const permits = (claims: Claims, call: Call): boolean =>
  claims.procedures.includes(call.rpc) &&
  (claims.runId === undefined || namedRun(call.payload) === claims.runId)

/**
 * Whether verified claims authorize one call.
 *
 * The procedure must be named. A token confined to a run authorizes only a
 * call that names that run, and one confined to a flow only a call that names
 * that flow: a call that names neither, such as an unfiltered `List`, is
 * refused rather than widened. A flow-catalog `List` never names a run or
 * flow, because the server ignores its filters.
 *
 * @category verification
 * @since 1.0.0
 */
export const authorizes = (claims: Claims, call: Call): boolean =>
  permits(claims, call) && (claims.flowId === undefined || namedFlow(call.payload) === claims.flowId)

/**
 * The host's answer to which flow a run or a plan belongs to.
 *
 * Each lookup answers `undefined` for a run or plan the host does not know;
 * a call naming one is then refused.
 *
 * @category models
 * @since 1.0.0
 */
export interface FlowLookup {
  readonly ofRun: (runId: string) => Effect.Effect<string | undefined>
  readonly ofPlan: (planId: string) => Effect.Effect<string | undefined>
}

/**
 * The flow a call acts on: the one it names, else the one the host resolves
 * its run, or failing that its plan, to.
 */
const actedFlow = (call: Call, flows: FlowLookup): Effect.Effect<unknown> => {
  const named = namedFlow(call.payload)
  if (named !== undefined) return Effect.succeed(named)
  const run = namedRun(call.payload)
  if (typeof run === "string") return flows.ofRun(run)
  const plan = namedPlan(call.payload)
  return typeof plan === "string" ? flows.ofPlan(plan) : Effect.succeed(undefined)
}

/**
 * Whether verified claims authorize one call, resolving through the host
 * what {@link authorizes} reads off the payload alone: a flow-confined token
 * also admits a call that names a run or plan of that flow.
 */
const admits = (claims: Claims, call: Call, flows: FlowLookup | undefined): Effect.Effect<boolean> =>
  flows === undefined || claims.flowId === undefined || !permits(claims, call)
    ? Effect.succeed(authorizes(claims, call))
    : Effect.map(actedFlow(call, flows), (flow) => flow === claims.flowId)

/**
 * What the scoped-token authenticator needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface AuthenticatorOptions {
  /** The verifying key: the gateway's configured bearer credential. */
  readonly key: string
  /** The principal every valid scoped token is stamped as. */
  readonly principal: Omit<Principal, "stampedAt">
  readonly now?: (() => number) | undefined
  /**
   * Resolves the flow of the run or plan a call names, so a flow-confined
   * token can launch, steer, watch, and decide on runs and plans of its flow.
   * Without it, a flow-confined token admits only calls that name the flow
   * itself: `Plan` and a `List` filtered by flow.
   */
  readonly flows?: FlowLookup | undefined
}

/**
 * Authenticates a bearer credential spelled as a scoped token: the signature
 * and expiry always, and the procedure plus run or flow confinement whenever
 * the boundary knows which call it is guarding. An edge that authenticates an
 * upgrade knows no call, so it admits the socket and leaves each frame to the
 * in-band check.
 *
 * A credential that is not a scoped token is refused here; compose with
 * `ControlRpcs.bearerAuthenticator` through `ControlRpcs.anyAuthenticator`
 * to accept both.
 *
 * @category constructors
 * @since 1.0.0
 */
export const authenticator = (options: AuthenticatorOptions): Authenticator => ({
  authenticate: (headers, call) => {
    const credential = bearerCredential(headers)
    if (credential === undefined || !isScopedToken(credential)) return refused("A valid scoped token is required")
    return Effect.gen(function*() {
      const now = options.now === undefined ? yield* Clock.currentTimeMillis : options.now()
      return yield* verify(options.key, credential, now).pipe(
        Effect.flatMap((claims) =>
          call === undefined ? Effect.void : admits(claims, call, options.flows).pipe(
            Effect.flatMap((admitted) =>
              admitted ? Effect.void : refused(`The scoped token does not authorize ${call.rpc}`)
            )
          )
        ),
        Effect.as({ ...options.principal, stampedAt: now })
      )
    })
  }
})
