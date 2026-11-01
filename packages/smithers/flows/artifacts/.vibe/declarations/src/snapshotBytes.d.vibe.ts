/**
 * Snapshotting caller-owned artifact bytes, so a caller that reuses its buffer
 * cannot change what is measured or stored.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect";
import { ArtifactStoreError } from "./ArtifactStoreError.vibe";
/**
 * Copies a caller-owned buffer when the returned Effect begins.
 *
 * A host that refuses the copy — a detached buffer, an allocation past what the
 * runtime will give — fails as `unavailable`, the code for a host refusal.
 *
 * @category utilities
 * @since 1.0.0-rc.0
 */
export declare const snapshotBytes: (bytes: Uint8Array) => Effect.Effect<Uint8Array, ArtifactStoreError>;
