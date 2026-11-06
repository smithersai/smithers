/**
 * The memory door: `remember` and `recall` as catalog entries.
 *
 * Binds the memory package's own shipped contract — its input/output
 * schemas and `runRemember`/`runRecall` handlers — under the flows'
 * declared names. Payloads and results are held to those schemas, with
 * the actual parse failure quoted in every refusal; store failures carry
 * the memory package's stable error code as the call's `cause`
 * (https://chain.smithers.sh/contract/).
 *
 * Both entries run under the host's `WithMemory.Policy`: a bank the policy
 * does not name fails `invalid_namespace` before the store runs, an empty
 * bank means the policy's own, and every remembered fact records the chain,
 * link, and call ordinal that wrote it. A script is model-authored, so the
 * bank in its payload is never the authority. The policy is part of each
 * entry's digest, so a journal written under one policy never replays under
 * another.
 *
 * Composition note: hosts that also mount the memory flows through the
 * registry must bind them there OR here, not both — a catalog holding two
 * `remember` declarations discloses one and runs the other, and journals
 * written under the registry's digest will refuse to resume against this
 * door's digest.
 *
 * @since 0.1.0
 */
import type * as MemoryError from "@smthrs/memory/MemoryError";
import * as MemoryStore from "@smthrs/memory/MemoryStore";
import * as Recall from "@smthrs/memory/Recall";
import * as WithMemory from "@smthrs/memory/WithMemory";
import { Effect, Layer, Schema } from "effect";
import * as Catalog from "./Catalog.vibe";
interface Contract {
    readonly name: string;
    readonly description: string;
    readonly input: Schema.Top;
    readonly output: Schema.Top;
    readonly effects: {
        readonly [key: string]: unknown;
    };
}
/**
 * The digest of a memory entry's shipped contract — name, description,
 * effect declaration, and the input/output schema shapes — so a
 * memory-package upgrade that changes the contract re-keys every call
 * that names it instead of replaying stale results.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const contractDigest: (contract: Contract) => string;
/**
 * The binding identity of a memory entry: its {@link contractDigest} and the
 * decoded policy it runs under. A journaled `recall` is replayed by digest, so
 * two policies must never share one: a result recorded under a broader policy
 * would otherwise answer a call under a narrower one.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const bindingDigest: (contract: Contract, policy: WithMemory.Policy) => string;
/**
 * Builds the two memory entries over the ambient store and recall
 * services — exactly those two services are captured, so call-time
 * provisions of anything else are never shadowed. Every call runs under
 * `policy`; an invalid policy fails with the memory package's
 * `invalid_argument` error.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (policy: WithMemory.Policy) => Effect.Effect<ReadonlyArray<Catalog.Entry>, MemoryError.MemoryError, MemoryStore.MemoryStore | Recall.Recall>;
/**
 * The memory entries under `policy` as a whole catalog of their own —
 * composed with the system entries, keeping the sealed realm's promise.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layer: (policy: WithMemory.Policy) => Layer.Layer<Catalog.Catalog, MemoryError.MemoryError, MemoryStore.MemoryStore | Recall.Recall>;
export {};
