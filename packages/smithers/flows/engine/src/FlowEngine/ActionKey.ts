/**
 * Derives the step identity an action dispatch is recorded under.
 *
 * @private
 * @since 0.1.0
 */

import { firstPath as schemaErrorPath } from "@smthrs/canonical/IssuePath"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Action, Flow, StepIdentity } from "@smthrs/flow"
import { DerivedKey, type StoredKey } from "@smthrs/keys"
import * as Node from "@smthrs/plan/Node"
import * as Context from "effect/Context"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * The encodings a keyed sealed action's key has been written in, newest first.
 *
 * A record is found again only under the key it was written with, so changing
 * how a key is derived must not strand the outcomes recorded before: every
 * earlier encoding stays derivable, and a driver looks a dispatch up under
 * them (`actionReplayKey`) before it writes under the newest. A change to the
 * derivation adds an encoding at the front and keeps the rest.
 *
 * - `4` hashes the declaration's `Node.representationIdentity` version 3,
 *   which includes what a JSON string (`Schema.fromJsonString`) in the success
 *   or error schema decodes to. Under every earlier encoding two declarations
 *   that differ only there derive one key, so a run that wrote a record under
 *   one and resumes after such an edit still finds that record.
 * - `3` names itself in the key (`keyEncoding: 3`) and hashes the
 *   declaration's `Node.representationIdentity` version 2. Every later
 *   encoding names itself the same way.
 * - `2` is encoding 3 without the name: the unversioned key written from
 *   `effect@4.0.4` (2026-10-13) until 2026-10-21.
 * - `1` hashes identity version 1, which every key written under
 *   `effect@4.0.0-rc.115` hashed: the same document with `Schema.brand`
 *   restored. It does not name itself either, and derives the key encoding
 *   2 derives for a declaration with no brand.
 *
 * @category identity
 * @since 1.0.0
 */
export const keyEncodings = [4, 3, 2, 1] as const

/**
 * One encoding of {@link keyEncodings}.
 *
 * @category identity
 * @since 1.0.0
 */
export type KeyEncoding = (typeof keyEncodings)[number]

/**
 * The encoding new keys are written in: the newest. A host never sets it; a
 * test sets an older one to write a journal as an earlier engine did.
 *
 * @category identity
 * @since 1.0.0
 */
export const ActionKeyEncoding = Context.Reference<KeyEncoding>("@smthrs/engine/FlowEngine/ActionKeyEncoding", {
  defaultValue: () => keyEncodings[0]
})

/** The representation identity version an encoding hashes a declaration with. */
const identityVersion = (encoding: KeyEncoding): Node.RepresentationIdentityVersion =>
  encoding === 4 ? 3 : encoding === 1 ? 1 : 2

/**
 * Extracts the hermetic boundary descriptor from an action's metadata when
 * it is shaped like one (`readSet` digests, `writeSet`, `boundaryMode`).
 *
 * The descriptor is what gates cross-run cacheability, so it must be part of
 * the cache key (issue #25): a changed read-set digest, write set, or
 * boundary mode yields a different key and therefore a cache miss. The key
 * is only half of Skyframe's dirty→recheck→rebuild model, though: these
 * digests are caller-declared, so before a sealed hit is served the store
 * re-measures them through `StepBoundary.prepare` and refuses a hit whose
 * declaration no longer matches the host (issue #90). Metadata of any other
 * shape stays out of the key.
 */
const fileBoundary = (
  metadata: unknown
): Action.FileBoundary | undefined => Option.getOrUndefined(Schema.decodeUnknownOption(Action.FileBoundary)(metadata))

/**
 * The ordinal allocation scope of an action dispatch — its stable
 * declaration identity and optional structural interpreter site (issue #85),
 * derived by the one canonical path in `StepIdentity` (issue #101).
 *
 * The action name always contributes (issue #73), and a declared
 * `idempotencyKey` refines the scope further — the string form and the
 * object form both, through the same canonicalization:
 * two concurrent invocations of one action name with distinguishable
 * inputs declare distinct keys, so each owns its own counter and a replay
 * that reverses fiber-arrival order can never hand one invocation the
 * other's recorded outcome. Refining only the string form left object-keyed
 * actions on the name-only counter and exposed to exactly that swap.
 * A structural interpreter site refines the scope again, so distinct graph
 * nodes calling one declaration each own a counter even without a declared
 * key. Without a site or a declared key, invocations of one name share a
 * counter and remain allocation-ordered — indistinguishable dispatches have
 * no material to order them by. Omitting the site preserves the prior scope
 * encoding byte for byte.
 * A declared implementation version appends its own length-framed `/v:`
 * component; absence appends nothing. Version changes belong to newly planned
 * executions, not upgrades of existing runs.
 *
 * @private
 * @since 0.1.0
 */
export const ordinalScope = (
  action: Action.Any,
  site?: string | undefined
): Effect.Effect<string, Schema.SchemaError, (EffectDigest.Digest | SecureRandom.SecureRandom)> =>
  StepIdentity.allocationScope({
    kind: "action",
    name: action.name,
    idempotency: action.idempotencyKey,
    site
  }).pipe(Effect.map((scope) =>
    action.implementationVersion === undefined
      ? scope
      : `${scope}/v:${action.implementationVersion.length}:${action.implementationVersion}`
  ))

/**
 * Finds the first rejected field without rendering its value.
 * @private
 * @since 0.1.0
 */
export { firstPath as schemaErrorPath } from "@smthrs/canonical/IssuePath"

/**
 * A caller-declared identity carried material canonicalization rejects
 * (issue #151): the failure surfaces as a recorded typed completion — the
 * same channel `RetryPolicy`'s terminal errors use — naming the offending
 * path, instead of `Result.getOrThrow` killing the fiber with an untyped
 * defect. It is non-retryable by construction: the same declaration derives
 * the same rejection on every attempt, so no retry loop is entered and the
 * body never runs.
 *
 * @private
 * @since 0.1.0
 */
export const uncanonicalKey = (
  actionName: string,
  error: Schema.SchemaError
): Flow.Complete<never, never> =>
  new Flow.Complete({
    exit: Exit.die(
      new Action.UncanonicalIdempotencyKey({
        actionName,
        reason: "canonicalize_failed",
        path: schemaErrorPath(error),
        message: error.message
      })
    )
  })

// Schemas are immutable and shared by separately constructed actions. Weak
// keys keep discarded declarations collectible. Identity versions 3 and 2
// depend on the AST alone, so they are cached by AST and shared across schema
// values; version 1 reads the brand off the schema value, so it is cached by
// that value. Cache only successful hashes so a failed Crypto operation can be
// retried with a working service.
const declarations: Record<Node.RepresentationIdentityVersion, WeakMap<object, WeakMap<object, StoredKey>>> = {
  1: new WeakMap(),
  2: new WeakMap(),
  3: new WeakMap()
}

/**
 * SHA-256 of the canonical success/error declaration document (issue #120).
 *
 * The document is `Node.representationIdentity`, not the installed
 * `SchemaRepresentation.toJson`: `effect` is a peer range, and a release that
 * encodes a schema differently would re-key every recorded sealed step. The
 * encoding picks the identity version, so a key written before an `effect`
 * upgrade stays derivable.
 */
const declarationDigest = Effect.fnUntraced(function*(action: Action.AnyWithProps, encoding: KeyEncoding) {
  const version = identityVersion(encoding)
  const success = version === 1 ? action.successSchema : action.successSchema.ast
  const error = version === 1 ? action.errorSchema : action.errorSchema.ast
  let errors = declarations[version].get(success)
  const cached = errors?.get(error)
  if (cached !== undefined) return cached
  const digest = yield* Schema.decodeUnknownEffect(DerivedKey)({
    success: Node.representationIdentity(action.successSchema, version),
    error: Node.representationIdentity(action.errorSchema, version)
  })
  if (errors === undefined) {
    errors = new WeakMap()
    declarations[version].set(success, errors)
  }
  errors.set(error, digest)
  return digest
})

const boundaries = new WeakMap<object, { readonly document: string; readonly digest: StoredKey }>()

/** Hash the validated boundary once per distinct metadata document. */
const boundaryDigest = Effect.fnUntraced(function*(metadata: unknown) {
  const boundary = fileBoundary(metadata)
  if (boundary === undefined) return undefined
  // Metadata is caller-owned and may mutate. The decoded JSON snapshot is a
  // cheap equality check, never hash input: DerivedKey still canonicalizes
  // the descriptor, so object property order cannot change its identity.
  const document = JSON.stringify(boundary)
  const cached = boundaries.get(metadata as object)
  if (cached?.document === document) return cached.digest
  const digest = yield* Schema.decodeUnknownEffect(DerivedKey)(boundary)
  boundaries.set(metadata as object, { document, digest })
  return digest
})

/**
 * The persisted key an action dispatch is recorded under: a pure cache key
 * for a keyed sealed action, an ordinal-scoped invocation key otherwise.
 * `encoding` derives the key an earlier engine wrote; only a keyed sealed
 * action's key differs between encodings. A string `idempotencyKey` hashes the
 * declaration, which the encoding shapes; every keyed sealed key from encoding
 * 3 on names its encoding.
 *
 * @private
 * @since 0.1.0
 */
export const actionKey = Effect.fnUntraced(function*(
  action: Action.AnyWithProps & Pick<Action.Any, "annotations">,
  executionId: string,
  ordinal: number,
  environment: Action.CacheEnvironment | undefined,
  scope: string,
  encoding: KeyEncoding = keyEncodings[0]
): Effect.fn.Return<StoredKey, Schema.SchemaError, (EffectDigest.Digest | SecureRandom.SecureRandom)> {
  if (action.tier === "sealed" && action.idempotencyKey !== undefined) {
    // Skyframe's SkyKey is (functionName, argument): a string idempotencyKey
    // is namespaced by the action name so two distinct actions sharing an
    // idempotency string can never collide and replay each other's outcomes,
    // and the declared success/error schemas are folded in so the body is the
    // *compiled declaration* the step-key spec requires — a schema change
    // must miss rather than replay a stale row decoded under the new schema
    // (issue #120). The object form stays caller-owned (no
    // name and no schema material folded in) as the explicit, documented
    // escape hatch for rename- and refactor-stable identity. Note: folding
    // the declaration changes the digest of every persisted string-key row
    // from before this fix; those keys were unsafe to replay across schema
    // changes, so the break is intentional (same precedent as the
    // name-namespacing fix). Compact declaration and boundary SHA-256 keys
    // intentionally change those bytes again under the same precedent. A
    // boundary also re-keys the object form; boundary-free object keys retain
    // their encoding.
    // The two forms build `input` from different material, so the form itself
    // is key input. Without it a caller object that spells the string form's
    // `{action, idempotencyKey, declaration}` encoding — the shape a caller
    // reaches for when copying the engine's own encoding to get a
    // rename-stable key — digests byte-identically to the string form, shares
    // one attempt row and one cache row, and replays the string form's
    // recorded outcome under its own schema. `StepIdentity.allocationScope`
    // already tags the same aliasing `/s:` and `/c:` (StepIdentity.ts:88-89);
    // the persisted key omitted it. The tag is a sibling of `input`, not a
    // member of it, so the caller-owned object stays verbatim and
    // rename-stability is untouched.
    const form = typeof action.idempotencyKey === "string" ? "declared" : "caller"
    const input: Schema.JsonObject = typeof action.idempotencyKey === "string"
      ? {
        action: action.name,
        idempotencyKey: action.idempotencyKey,
        declaration: yield* declarationDigest(action, encoding)
      }
      : action.idempotencyKey
    // The cacheability-gating boundary descriptor is cache key input
    // (issue #25): a changed read set, write set, or boundary mode must miss
    // rather than replay a stale cross-run cache entry. Both key forms fold
    // it through this one path — the caller-owned object keeps
    // rename-stability (no name enters the digest) but can never opt out of
    // the read-set material `ActionPersistence` gates cacheability on
    // (issue #57): the descriptor derived from `action.metadata` overrides
    // any caller-supplied `boundary` field.
    const boundary = yield* boundaryDigest(action.metadata)
    // The caller-owned object can carry material canonicalization
    // rejects; the typed `SchemaError` propagates to the dispatch site
    // (issue #151) instead of being discarded through `Result.getOrThrow`.
    // A declared nondeterministic result is also key material. Otherwise a
    // tolerant declaration could consume a strict row (or the reverse) under
    // an identity whose conflict policy was never part of the claim. Omitting
    // it emits no field and preserves every deterministic key byte-for-byte.
    // Cache hits disclose the output without re-running guarded host operations.
    // Partition both key forms by effective authority; run-local replay identity
    // remains stable and cannot be turned into a second execution by a ceiling.
    const ceiling = environment === undefined ?
      [] :
      (yield* Flow.attenuateCapabilities(Flow.capabilityCeilings(action.annotations))(CapabilitySet.current)).groups
    return yield* Schema.decodeUnknownEffect(DerivedKey)({
      // An encoding names itself from 3 on; 2 and 1 were written before keys
      // were versioned and emit nothing, so their bytes stay derivable.
      ...(encoding < 3 ? {} : { keyEncoding: encoding }),
      kind: environment === undefined ? "run" : "cache",
      ...(ceiling.length === 0 ? {} : {
        capabilityCeilings: ceiling.map((group) => group.map(({ action, resource }) => ({ action, resource })))
      }),
      form,
      input,
      // This is outside caller-owned input, retaining object-key rename
      // stability while preventing it from masking an explicit version. An
      // absent version emits no field and preserves all legacy key bytes.
      ...(action.implementationVersion === undefined ? {} : { implementationVersion: action.implementationVersion }),
      ...(environment === undefined ? { runId: executionId } : { environment }),
      ...(action.nondeterministic === undefined ? {} : { nondeterministic: action.nondeterministic }),
      ...(boundary === undefined ? {} : { boundary })
    })
  }
  // The ordinal is allocated from a counter scoped to this action's
  // declaration identity and that scope is folded into the key as
  // `parentScope` (issues #73, #85). One per-run counter bumped in
  // fiber-arrival order made the identity of a compensable, irreversible, or
  // unsealed action depend on scheduling: under `Effect.all` with
  // concurrency a replay could hand `chargeCard` the ordinal `sendEmail`
  // recorded and replay the wrong attempt rows, checkpoint, and outcome.
  // Per-identity counters are stable under any interleaving of distinct
  // declarations or structural dispatch sites — distinct names, one name
  // with distinct declared idempotency keys, or distinct interpreter graph
  // nodes; the scope also keeps two identities from sharing the number 1.
  return yield* StepIdentity.invocationKey({
    runId: executionId,
    parentScope: scope,
    ordinal,
    tier: action.tier === "sealed" ? "unsealed" : action.tier
  })
})
