import { Flow } from "@smthrs/flow"
import { Clock, Context, Effect, Layer, Metric, Option, Result, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import { HttpServerRequest } from "effect/http"
import {
  AGENT_FLOWS,
  type ActKind,
  type Actor,
  refusesCredential,
  Sessions,
  type SessionsUnavailable,
} from "./Actor.ts"
import { ANONYMOUS_DEVICE_PERSON, DEVICE_PERSON_HEADER, NO_DEVICE_DATA } from "../src/features/auth/contract.ts"
import { CREDENTIAL_TTL_MS } from "../src/flows/contract.ts"
import type { SessionKeys } from "./SessionKeys.ts"

// Run credentials (decision 0017 slice 0, docs/features/sign-in.md#run-credentials): how the server tells a person from
// the agent, a flow or a plugin acting for them. Every run but a person's own press of a person's flow asks
// `POST /api/runs/<run>/credential`, and gets a signed bearer token bound to that run. The server sets its `act` from
// the registry's mark and the run's parent (worker/Actor.ts `AGENT_FLOWS`), never from the request, and narrows its
// ceiling at every hop. A request that carries one is that run's, never its person's, whatever cookie rides along:
// sessions read the credential first and never fall back (`resolveWith`). Every person-only route refuses an `act`.

/** The longest caller chain a credential carries: a deeper nested call is refused `too_deep`. */
export const MAX_CHAIN = 16

/** The largest bearer token sessions read; a longer `Authorization` header is no credential at all. */
export const MAX_TOKEN_LENGTH = 8 * 1024

/** A run's id: an engine's execution id, printable ASCII. */
const RunId = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,256}$/))

/** A flow's tag, as `Flow.make`'s first argument. */
const FlowTag = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*(\/[A-Za-z0-9][A-Za-z0-9.-]*){0,3}$/))
  .check(Schema.isMaxLength(128))

/** A capability ceiling in transported form (`Flow.intersectCeilings`): `[]` is unrestricted. */
const Ceiling = Schema.Array(Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(32)))
  .check(Schema.isMaxLength(16))

/**
 * What the engine asks a credential for: the run's flow, and its declared ceiling (its `Flow.make` capabilities) when
 * it declares one. A declared ceiling only ever narrows: the server intersects it, and refuses a callee whose declared
 * ceiling its caller's doesn't cover.
 */
export const MintRequest = Schema.Struct({ flow: FlowTag, ceiling: Schema.optional(Ceiling), renew: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_TOKEN_LENGTH))) })
export type MintRequest = typeof MintRequest.Type

/** What a credential says, signed: who, which run acts for them and as what, its chain, its ceiling and its end. */
export const Claims = Schema.Struct({
  v: Schema.Literal(1),
  /** The person the run acts for. */
  sub: Schema.String.check(Schema.isMaxLength(128)),
  /** The session it was minted under: it ends with that session. Absent where sign-in isn't configured. */
  sid: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  act: Schema.Literals(["agent", "flow", "app", "sandbox"]),
  run: RunId,
  root: RunId,
  chain: Schema.Array(FlowTag).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CHAIN)),
  ceiling: Ceiling,
  /** When it ends, in epoch milliseconds. */
  exp: Schema.Int,
})
export type Claims = typeof Claims.Type

/** Why a credential isn't minted: a person-only flow, a callee its caller's ceiling doesn't cover, or too deep. */
export type MintRefusal = "person_only" | "capability_exceeded" | "too_deep"

/**
 * The claims `who` gets for run `run` of `request.flow` at `now`, or why not. A request with no `act` is the person's
 * session starting a run that isn't their own press: the chain starts here, as the agent when the registry marks
 * `request.flow` an agent, else as a flow. One with an `act` is a credential's nested call: the chain grows by one, the
 * ceiling narrows to the intersection, and the kind stays the caller's, becoming the agent's inside an agent. Neither
 * mints for a person-only flow whose route refuses an `act`: those run only as the person's own press.
 */
export const claimsFor = (
  who: Actor,
  run: string,
  request: MintRequest,
  now: number,
): Result.Result<Claims, MintRefusal> => {
  if (refusesCredential(request.flow)) return Result.fail("person_only")
  const declared = request.ceiling ?? []
  const agent = AGENT_FLOWS.has(request.flow)
  const base = {
    v: 1 as const,
    sub: who.subject.id,
    ...(who.session === undefined ? {} : { sid: who.session }),
    run,
    exp: now + CREDENTIAL_TTL_MS,
  }
  const parent = who.act
  if (parent === undefined) {
    return Result.succeed({
      ...base,
      act: agent ? "agent" : "flow",
      root: run,
      chain: [request.flow],
      ceiling: Flow.intersectCeilings([], declared),
    })
  }
  const chain = parent.chain ?? [parent.id]
  const ceiling = parent.ceiling ?? []
  if (chain.length >= MAX_CHAIN) return Result.fail("too_deep")
  if (request.ceiling !== undefined && !Flow.ceilingWithin(declared, ceiling)) return Result.fail("capability_exceeded")
  const kind: ActKind = parent.kind === "agent" || agent ? "agent" : parent.kind
  return Result.succeed({
    ...base,
    act: kind,
    root: parent.root ?? parent.id,
    chain: [...chain, request.flow],
    ceiling: Flow.intersectCeilings(ceiling, declared),
  })
}

/** How a credential a request carried read: as its run (`verified`), or not at all, and why not. */
export type Verification = "verified" | "forged" | "expired" | "ended"

/** Credentials minted, renewed and read, by `op` (`mint`, `renew`, `verify`), `outcome` and `act`. */
export const credentials = Metric.counter("smithers_run_credentials", {
  description: "Run credentials minted and read, by op, outcome and act",
  incremental: true,
})

/** Signs and reads run credentials. */
export class RunCredentials extends Context.Service<
  RunCredentials,
  {
    /** `claims`, signed: the bearer token the engine sends with every request of the run. */
    readonly sign: (claims: Claims) => Effect.Effect<string>
    /**
     * The actor a bearer token stands for: its person, as their session stands now, with `act` from its claims. None
     * when it is forged, has expired, or its session ended. Each read that fails is logged and counted.
     */
    readonly verify: (token: string) => Effect.Effect<Option.Option<Actor>, SessionsUnavailable>
    /** Renew the exact signed authority while its original session is live; never reinterpret it as a new run. */
    readonly renew: (token: string, actor: Actor, run: string) => Effect.Effect<Option.Option<Claims>, SessionsUnavailable>
  }
>()("@smthrs/mvp/RunCredentials") {}

/**
 * Requests read as nobody because of whose device data they come from (`x-smithers-device-person`), by `outcome`:
 * `mismatch`, another person's; `unbound`, a cookie-authenticated write that names no one, as an earlier build's tab
 * sends; `anonymous`, a page whose viewer is nobody.
 */
export const devicePrincipalRefusals = Metric.counter("smithers_device_principal_refusals", { incremental: true })

const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims))

/**
 * Run credentials signed with `keys` (purpose `run`, so no cookie ever reads as one), whose person `person` resolves as
 * their session stands now: none once it ended.
 */
export const make = (options: {
  readonly keys: SessionKeys
  readonly person: (claims: Claims) => Effect.Effect<Option.Option<Actor>, SessionsUnavailable>
}): RunCredentials["Service"] => {
  const failed = (outcome: Exclude<Verification, "verified">) =>
    Effect.as(
      Effect.andThen(
        Metric.update(Metric.withAttributes(credentials, { op: "verify", outcome, act: "none" }), 1),
        Effect.logWarning("auth.credential").pipe(Effect.annotateLogs({ op: "verify", outcome })),
      ),
      Option.none<Actor>(),
    )
  const read = (token: string) => Effect.gen(function* () {
    const value = yield* options.keys.verify("run", token)
    if (Option.isNone(value)) return Option.none<Claims>()
    const text = Base64Url.decodeString(value.value.value)
    return Result.isSuccess(text) ? decodeClaims(text.success) : Option.none<Claims>()
  })
  return RunCredentials.of({
    renew: (token, actor, run) => Effect.gen(function* () {
      const claims = yield* read(token)
      if (Option.isNone(claims)) return Option.none()
      const original = claims.value
      if (actor.act !== undefined || actor.subject.id !== original.sub || actor.session !== original.sid || run !== original.run) return Option.none()
      const person = yield* options.person(original)
      if (Option.isNone(person)) return Option.none()
      return Option.some({ ...original, exp: (yield* Clock.currentTimeMillis) + CREDENTIAL_TTL_MS })
    }).pipe(Effect.withSpan("auth.credential.renew")),
    sign: (claims) => options.keys.sign("run", Base64Url.encode(JSON.stringify(claims))),
    verify: (token) =>
      Effect.gen(function* () {
        const value = yield* options.keys.verify("run", token)
        if (Option.isNone(value)) return yield* failed("forged")
        const text = Base64Url.decodeString(value.value.value)
        const claims = Result.isSuccess(text) ? decodeClaims(text.success) : Option.none()
        // Signed by us yet not claims: a key reused for another purpose would be a bug; it reads as forged.
        if (Option.isNone(claims)) return yield* failed("forged")
        if ((yield* Clock.currentTimeMillis) >= claims.value.exp) return yield* failed("expired")
        const person = yield* options.person(claims.value)
        if (Option.isNone(person)) return yield* failed("ended")
        const { act, run, root, chain, ceiling } = claims.value
        yield* Metric.update(Metric.withAttributes(credentials, { op: "verify", outcome: "verified", act }), 1)
        return Option.some<Actor>({ ...person.value, act: { kind: act, id: run, root, chain, ceiling } })
      }).pipe(Effect.withSpan("auth.credential.verify")),
  })
}

/** The run credential `request` carries: its `Authorization: Bearer` token, when one at most `MAX_TOKEN_LENGTH` long. */
export const bearerOf = (request: HttpServerRequest.HttpServerRequest): Option.Option<string> => {
  const header = request.headers["authorization"]
  if (header === undefined || !header.startsWith("Bearer ")) return Option.none()
  const token = header.slice("Bearer ".length).trim()
  return token.length === 0 || token.length > MAX_TOKEN_LENGTH ? Option.none() : Option.some(token)
}

/**
 * Who a request is: the run its credential names, when it carries one, and never its cookie's person then, even when the
 * credential doesn't read; else `session`, the person behind its cookie. A request that says whose device data it comes
 * from (`x-smithers-device-person`, src/device/identity.ts) and names anyone else reads as nobody, so one person's
 * queued writes and open pages never act as the next person signed in on the browser; so does a cookie-authenticated
 * write that names no one. A page that opened none of the device's data says so (`@none`) and acts as its cookie's
 * person. Annotates the span with who acts, as which `act`, never with content; a refusal is logged and counted
 * without either person.
 */
export const resolveWith = <R>(
  credentials: RunCredentials["Service"],
  session: Effect.Effect<Option.Option<Actor>, SessionsUnavailable, R>,
): Effect.Effect<Option.Option<Actor>, SessionsUnavailable, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.headers[DEVICE_PERSON_HEADER] === ANONYMOUS_DEVICE_PERSON) return yield* refuseAnonymous
    const bearer = bearerOf(request)
    const actor = Option.isSome(bearer) ? yield* credentials.verify(bearer.value) : yield* session
    return yield* bound(request, actor, Option.isSome(bearer))
  })

/**
 * The person behind `request`'s session cookie alone (`session`), never a run credential its `Authorization` carries,
 * bound by the device header as `resolveWith` binds a cookie's person.
 */
export const resolveCookieWith = <R>(
  session: Effect.Effect<Option.Option<Actor>, SessionsUnavailable, R>,
): Effect.Effect<Option.Option<Actor>, SessionsUnavailable, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.headers[DEVICE_PERSON_HEADER] === ANONYMOUS_DEVICE_PERSON) return yield* refuseAnonymous
    return yield* bound(request, yield* session, false)
  })

/** Anonymous device viewers resolve neither proof, even if another tab signed in first. */
const refuseAnonymous = Effect.gen(function* () {
  yield* Metric.update(Metric.withAttributes(devicePrincipalRefusals, { outcome: "anonymous" }), 1)
  yield* Effect.logWarning("auth.device_principal").pipe(Effect.annotateLogs({ outcome: "anonymous" }))
  yield* Effect.annotateCurrentSpan({ "smithers.actor.act": "none" })
  return Option.none<Actor>()
})

/** `actor`, or nobody where the request's device header names someone else, or a cookie write names no one. */
const bound = (request: HttpServerRequest.HttpServerRequest, actor: Option.Option<Actor>, viaBearer: boolean) =>
  Effect.gen(function* () {
    const header = request.headers[DEVICE_PERSON_HEADER]
    // A page with none of the device's data carries no one's data: it binds nothing.
    const expected = header === NO_DEVICE_DATA ? undefined : header
    const cookieMutation = !viaBearer && request.headers.cookie !== undefined && !["GET", "HEAD", "OPTIONS"].includes(request.method)
    if (Option.isSome(actor) && ((cookieMutation && header === undefined) || (expected !== undefined && actor.value.subject.id !== expected))) {
      const outcome = expected === undefined ? "unbound" : "mismatch"
      yield* Metric.update(Metric.withAttributes(devicePrincipalRefusals, { outcome }), 1)
      yield* Effect.logWarning("auth.device_principal").pipe(Effect.annotateLogs({ outcome }))
      return Option.none()
    }
    yield* Effect.annotateCurrentSpan({
      "smithers.actor.act": Option.match(actor, { onNone: () => "none", onSome: (who) => who.act?.kind ?? "person" }),
    })
    return actor
  })

/** `Sessions` that read a request's run credential first (`resolveWith`), else `session`, with the `RunCredentials` in context. */
export const sessionsWith = (
  session: Effect.Effect<Option.Option<Actor>, SessionsUnavailable, HttpServerRequest.HttpServerRequest>,
): Layer.Layer<Sessions, never, RunCredentials> =>
  Layer.effect(
    Sessions,
    Effect.map(RunCredentials, (credentials) =>
      Sessions.of({ resolve: resolveWith(credentials, session), resolveCookie: resolveCookieWith(session) })),
  )
