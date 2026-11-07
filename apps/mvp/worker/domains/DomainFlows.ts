import { Action, Flow, Interpreter, Poll, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Metric, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import type { DomainState } from "../../src/features/domains/contract.ts"
import { codeOf } from "../ErrorCode.vibe"
import { DomainProvider, type Registration } from "./Provider.vibe"
import * as Store from "./Store.ts"

// The custom-domain flows (decision 0039 §4, docs/features/domains.md#flows). The route admits the write (signed in;
// a Maintainer or Admin acting in person) and starts one of them:
//
//   domain/Verify { repoId, hostname, actorId, pollId }        a poll: one round per attempt, a durable wait between
//     attempt 1: domain/Claim ─ the row, `add` or `refresh`      a row another poll owns, or removed, ends it
//     every attempt: domain/Check ─ ensure at the provider, read its verdict, write the row
//   domain/Remove { repoId, hostname, actorId }
//     domain/Release ─ mark the row removing, forget it at the provider, delete the row
//
// Each step writes and records once under its invocation key. Postgres failing is `StoreUnavailable` and the provider
// failing is `ProviderUnavailable`, both retried; a check that can't reach the provider records `unreachable` and
// waits for the next attempt instead.

/** Postgres couldn't record the step. Retried. */
export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  "@smthrs/mvp/domains/StoreUnavailable",
  {},
) {}

/** The provider couldn't forget the domain. Retried. */
export class ReleaseUnavailable extends Schema.TaggedError<ReleaseUnavailable>()(
  "@smthrs/mvp/domains/ReleaseUnavailable",
  {},
) {}

/** The step couldn't tell which step it is, so it couldn't record its change once. */
export class NoInvocationKey extends Schema.TaggedError<NoInvocationKey>()("@smthrs/mvp/domains/NoInvocationKey", {}) {}

/** Steps, by `op` (`claim`, `check`, `release`) and `outcome` (a claim's change, a check's state, `released`). */
export const steps_ = Metric.counter("smithers_domain_steps", {
  description: "Custom-domain flow steps, by op and outcome",
  incremental: true,
})

/** Recording: 1 s doubling to a minute, for at most 30 minutes, while Postgres is unreachable. */
export const STORE_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

/** Releasing: 5 s doubling to 10 minutes, for a day, while the provider is unreachable. */
export const RELEASE_RETRY = RetryPolicy.make({
  initialMs: 5_000,
  factor: 2,
  maxMs: 10 * 60_000,
  expirationMs: 24 * 60 * 60_000,
})

/**
 * The poll's schedule: a minute, then a minute longer each time, 140 attempts: about 6.8 days, inside Cloudflare's own
 * 7-day validation window, the last wait 2 h 19 min.
 */
export const VERIFY_INTERVAL_MS = 60_000
export const VERIFY_ATTEMPTS = 140

const verifyInput = {
  repoId: Schema.String,
  hostname: Schema.String,
  actorId: Schema.String,
  pollId: Schema.String,
  /** Whether the route saw the domain already: a refresh, which never adds it back. */
  refresh: Schema.Boolean,
}

/**
 * Claims the row for this poll: `add` or `refresh`; `taken` when another repository holds the hostname, `removing` while
 * a removal is in flight, `missing` for a refresh of a domain removed since.
 */
export const Claim = Action.make("domain/Claim", {
  payload: verifyInput,
  success: Schema.Struct({ change: Schema.Literals(["add", "refresh", "taken", "removing", "missing", "repeat"]) }),
  error: StoreUnavailable,
  capabilities: ["db:write:domains"],
  retryPolicy: STORE_RETRY,
})

/** One check: the provider's verdict on the row, and whether the poll is over. */
export const Check = Action.make("domain/Check", {
  payload: { ...verifyInput, attempt: Schema.Number },
  success: Poll.CheckResult(Schema.String),
  error: StoreUnavailable,
  capabilities: ["db:write:domains", "net:domains"],
  retryPolicy: STORE_RETRY,
})

/** Marks the row removing, forgets the domain at the provider and deletes the row. */
export const Release = Action.make("domain/Release", {
  payload: { repoId: Schema.String, hostname: Schema.String, actorId: Schema.String },
  success: Schema.Struct({ change: Schema.Literals(["released", "missing"]) }),
  error: Schema.Union([StoreUnavailable, ReleaseUnavailable]),
  capabilities: ["db:write:domains", "net:domains"],
  retryPolicy: RELEASE_RETRY,
})

/** `domain/Verify`: claims a domain, then checks it until it is active, has failed, or the attempts run out. */
export const Verify = Poll.make("domain/Verify", {
  input: verifyInput,
  result: Schema.String,
  intervalMs: VERIFY_INTERVAL_MS,
  backoff: "linear",
  maxAttempts: VERIFY_ATTEMPTS,
  onTimeout: "return-last",
  check: Node.capture(
    { claim: Claim.name, check: Check.name, implementationVersion: "domain/verify-check/v1" },
    (round) => {
      const { attempt, ...input } = round
      const check = Check.call({ ...input, attempt })
      // A step that ran out of retries is one more unsatisfied attempt: the poll goes on.
      return (attempt === 1 ? Claim.call(input).pipe(Node.andThen(check)) : check).pipe(
        Node.catch({ onFailure: () => Node.succeed({ satisfied: false, output: "unavailable" }) }),
      )
    },
  ),
})

/** `domain/Remove`: removes a repository's custom domain. */
export const Remove = Flow.make("domain/Remove", {
  description: "Remove a repository's custom domain; a Maintainer or Admin acting in person only.",
  capabilities: ["db:write:domains", "net:domains"],
  modelInvocable: false,
  payload: Release.payloadSchema.fields,
  success: Release.successSchema,
  error: Release.errorSchema,
  body: Node.capture({ release: Release.name }, (write) => Release.call(write)),
})

/** Every outcome as one count and log line, carrying the repository and codes; never the hostname or a token. */
const recorded = <A, E, R>(
  op: "claim" | "check" | "release",
  repoId: string,
  outcome: (a: A) => string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tap((a) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(steps_, { op, outcome: outcome(a) }), 1),
        Effect.logInfo("domain.step").pipe(Effect.annotateLogs({ op, repoId, outcome: outcome(a) })),
      )
    ),
    Effect.withSpan("domain.step", { attributes: { "smithers.domain.op": op, "smithers.repo.id": repoId } }),
  )

/** A database failure as the step's retried failure, recorded by its code. */
const unavailable = (error: unknown) =>
  Effect.andThen(
    Effect.logWarning("domain.step").pipe(Effect.annotateLogs({ outcome: "unavailable", errorCode: codeOf(error) })),
    Effect.fail(new StoreUnavailable()),
  )

/** A registration's verdict as the row's state: active once verified with a certificate (or none to manage). */
export const stateOf = (registration: Registration): DomainState =>
  registration.verification === "failed" || registration.certificate === "failed"
    ? "failed"
    : registration.verification === "active" &&
        (registration.certificate === "active" || registration.certificate === "unmanaged")
    ? "active"
    : "pending"

const invocationKey = Effect.gen(function* () {
  const key = yield* Action.CurrentInvocationKey
  if (key === undefined) return yield* Effect.die(new NoInvocationKey())
  return key
})

/** The steps over `database`, reaching the provider through `DomainProvider`. */
export const steps = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const store = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provide(database), Effect.catch(unavailable))

  const claim = (input: typeof Claim.payloadSchema.Type) =>
    Effect.gen(function* () {
      const key = yield* invocationKey
      const change = yield* store(Store.claim({ ...input, invocationKey: key }))
      return { change }
    }).pipe((effect) => recorded("claim", input.repoId, ({ change }) => change, effect))

  const check = (input: typeof Check.payloadSchema.Type) =>
    Effect.gen(function* () {
      const row = yield* store(Store.read(input.hostname))
      // Removed, refreshed by a newer poll, or another repository's: this poll is over.
      if (
        Option.isNone(row) || row.value.pollId !== input.pollId || row.value.state === "removing" ||
        row.value.repoId !== input.repoId
      ) return { satisfied: true, output: "superseded" }
      const last = input.attempt >= VERIFY_ATTEMPTS
      const provider = yield* DomainProvider
      const providerId = row.value.providerId
      const write = (found: Omit<Store.Check, "hostname" | "pollId">) =>
        Effect.gen(function* () {
          const recorded = yield* store(Store.record({ ...found, hostname: input.hostname, pollId: input.pollId }))
          if (recorded === "written") return { satisfied: found.state !== "pending", output: found.state }
          // Removed while this check registered it: the release saw no registration, so this check forgets it.
          if (recorded === "removed" && found.providerId !== undefined && providerId === null) {
            // Only a provider's answer carries a provider id, so the provider is there. A failure here leaves the
            // registration behind: counted and logged as `orphaned` for an operator, since no row is left to retry from.
            yield* Option.getOrThrow(provider).remove(found.providerId).pipe(
              Effect.catch((error) =>
                Effect.andThen(
                  Metric.update(Metric.withAttributes(steps_, { op: "check", outcome: "orphaned" }), 1),
                  Effect.logError("domain.step").pipe(
                    Effect.annotateLogs({ op: "check", repoId: input.repoId, outcome: "orphaned", errorCode: error.code }),
                  ),
                )
              ),
            )
          }
          return { satisfied: true, output: "superseded" }
        })
      if (Option.isNone(provider)) {
        return yield* write(last ? { state: "failed", problem: "timed_out" } : { state: "pending", problem: "unreachable" })
      }
      // A registration the provider forgot (Cloudflare deletes one that didn't validate in its window) is made anew.
      const looked = yield* (providerId === null
        ? provider.value.ensure(input.hostname)
        : Effect.flatMap(
          provider.value.status(providerId, input.hostname),
          Option.match({ onNone: () => provider.value.ensure(input.hostname), onSome: Effect.succeed }),
        )).pipe(Effect.result)
      if (looked._tag === "Failure") {
        const failure = looked.failure
        if (failure._tag === "@smthrs/mvp/domains/HostnameTaken") return yield* write({ state: "failed", problem: "taken" })
        if (failure._tag === "@smthrs/mvp/domains/HostnameRejected") return yield* write({ state: "failed", problem: failure.reason })
        yield* Effect.logWarning("domain.step").pipe(
          Effect.annotateLogs({ op: "check", repoId: input.repoId, outcome: "unreachable", errorCode: failure.code }),
        )
        return yield* write(last ? { state: "failed", problem: "timed_out" } : { state: "pending", problem: "unreachable" })
      }
      const registration = looked.success
      const state = stateOf(registration)
      return yield* write({
        providerId: registration.id,
        state: state === "pending" && last ? "failed" : state,
        verification: registration.verification,
        certificate: registration.certificate,
        records: registration.records,
        problem: state === "pending" && last ? "timed_out" : registration.problem ?? null,
      })
    }).pipe((effect) => recorded("check", input.repoId, ({ output }) => output, effect))

  const release = (input: typeof Release.payloadSchema.Type) =>
    Effect.gen(function* () {
      const key = yield* invocationKey
      const withdrawn = yield* store(Store.withdraw({ ...input, invocationKey: key }))
      if (Option.isNone(withdrawn)) return { change: "missing" as const }
      const provider = yield* DomainProvider
      if (withdrawn.value.providerId !== null) {
        // With the provider off, its registration can't be forgotten: the step waits for it rather than orphan it.
        if (Option.isNone(provider)) return yield* Effect.fail(new ReleaseUnavailable())
        yield* provider.value.remove(withdrawn.value.providerId).pipe(
          Effect.catch((error) =>
            Effect.andThen(
              Effect.logWarning("domain.step").pipe(
                Effect.annotateLogs({ op: "release", outcome: "unavailable", errorCode: error.code }),
              ),
              Effect.fail(new ReleaseUnavailable()),
            )
          ),
        )
      }
      yield* store(Store.erase(input.hostname))
      return { change: "released" as const }
    }).pipe((effect) => recorded("release", input.repoId, ({ change }) => change, effect))

  return { claim, check, release }
}

/** Registers `domain/Verify` and `domain/Remove` with their steps over `database`, reaching `provider`. */
export const registration = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  provider: Layer.Layer<DomainProvider>,
) => {
  const implementation = steps(database)
  return Layer.merge(
    Interpreter.layerWithImplementations(
      Verify,
      Layer.mergeAll(Claim.toLayer(implementation.claim), Check.toLayer(implementation.check), Poll.layer),
    ),
    Interpreter.layerWithImplementations(Remove, Release.toLayer(implementation.release)),
  ).pipe(Layer.provide(provider), Layer.provideMerge(Action.layerImplementations))
}
