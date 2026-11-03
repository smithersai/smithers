/**
 * Derives the step identity an action dispatch is recorded under.
 *
 * @private
 * @since 0.1.0
 */
import type { Crypto } from "@smthrs/crypto";
import { Action, Flow } from "@smthrs/flow";
import { type StoredKey } from "@smthrs/keys";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
/**
 * The encodings a keyed sealed action's key has been written in, newest first.
 *
 * A record is found again only under the key it was written with, so changing
 * how a key is derived must not strand the outcomes recorded before: every
 * earlier encoding stays derivable, and a driver looks a dispatch up under
 * them (`actionReplayKey`) before it writes under the newest. A change to the
 * derivation adds an encoding at the front and keeps the rest.
 *
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
export declare const keyEncodings: readonly [3, 2, 1];
/**
 * One encoding of {@link keyEncodings}.
 *
 * @category identity
 * @since 1.0.0
 */
export type KeyEncoding = (typeof keyEncodings)[number];
/**
 * The encoding new keys are written in: the newest. A host never sets it; a
 * test sets an older one to write a journal as an earlier engine did.
 *
 * @category identity
 * @since 1.0.0
 */
export declare const ActionKeyEncoding: Context.Reference<1 | 2 | 3>;
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
export declare const ordinalScope: (action: Action.Any, site?: string | undefined) => Effect.Effect<string, Schema.SchemaError, Crypto.Crypto>;
/**
 * Finds the first rejected field without rendering its value.
 * @private
 * @since 0.1.0
 */
export { firstPath as schemaErrorPath } from "@smthrs/canonical/IssuePath";
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
export declare const uncanonicalKey: (actionName: string, error: Schema.SchemaError) => Flow.Complete<never, never>;
/**
 * The persisted key an action dispatch is recorded under: a pure cache key
 * for a keyed sealed action, an ordinal-scoped invocation key otherwise.
 * `encoding` derives the key an earlier engine wrote; only a keyed sealed
 * action's key with a string `idempotencyKey` differs between encodings.
 *
 * @private
 * @since 0.1.0
 */
export declare const actionKey: (action: Action.AnyWithProps & Pick<Action.Any, "annotations">, executionId: string, ordinal: number, environment: {
    readonly layers: readonly string[];
    readonly capabilities: {
        readonly [x: string]: readonly string[];
    };
} | undefined, scope: string, encoding?: 1 | 2 | 3) => Effect.Effect<StoredKey, Schema.SchemaError, Crypto.Crypto>;
