/**
 * Measuring artifact bytes: the SHA-256 content address of one immutable
 * snapshot, computed through the injected `Crypto` service.
 *
 * @since 1.0.0-rc.0
 */
import { type Crypto } from "@smthrs/crypto";
import * as Effect from "effect/Effect";
import type { Digest } from "../../../src/ArtifactStore.ts";
import { ArtifactStoreError } from "./ArtifactStoreError.vibe";
/**
 * Measures one immutable byte snapshot without ever retaining it in an error.
 *
 * @category utilities
 * @since 1.0.0-rc.0
 */
export declare const measureBytes: (bytes: Uint8Array) => Effect.Effect<Digest, ArtifactStoreError, Crypto.Crypto>;
