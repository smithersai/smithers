/**
 * Validating a content address before any implementation logs it or
 * interpolates it into a path or URL.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect";
import type { Digest } from "./ArtifactStore.ts";
import { ArtifactStoreError } from "./ArtifactStoreError.vibe";
/**
 * Refuses anything other than the canonical SHA-256 address representation.
 *
 * Every implementation validates before logging or interpolating an untrusted
 * value into a path or URL. The failure text is constant and bounded, so even a
 * hostile multi-megabyte value cannot be copied into logs or durable errors.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 * @slop
 */
export declare const validateDigest: (digest: string) => Effect.Effect<Digest, ArtifactStoreError>;
