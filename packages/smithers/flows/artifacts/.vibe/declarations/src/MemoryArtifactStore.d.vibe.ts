/**
 * The in-memory artifact store: a private map from digest to a defensive copy
 * of the bytes, for tests and hosts with no durable filesystem.
 *
 * @since 1.0.0-rc.0
 */
import type { Service } from "../../../src/ArtifactStore.ts";
/**
 * Builds an in-memory artifact store, for tests and for a browser host with no
 * durable filesystem yet.
 *
 * Reads are not digest-verified here, and that is not an oversight: the map is
 * keyed by the digest this store measured when it accepted the bytes, and both
 * boundaries copy — `put` stores a copy of the caller's array and `get` hands
 * out a copy of the stored one — so no reference a caller can still mutate
 * aliases the stored content, and there is no window in which the address and
 * the content can disagree. The filesystem and remote implementations verify
 * because their address spaces are genuinely shared.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export declare const makeMemory: () => Service;
