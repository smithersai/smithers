/**
 * The artifact store's typed failures: a refusal of the store itself, the
 * typed miss, and a digest mismatch, with the stable codes a refusal carries.
 *
 * @since 1.0.0-rc.0
 */
import * as Schema from "effect/Schema";
/**
 * Stable error codes returned by artifact store operations.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export declare const ArtifactStoreErrorCode: Schema.Literals<readonly ["digest_failed", "invalid_configuration", "invalid_digest", "unavailable", "transport_failed"]>;
/**
 * Stable error codes returned by artifact store operations.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type ArtifactStoreErrorCode = typeof ArtifactStoreErrorCode.Type;
declare const ArtifactStoreError_base: Schema.Class<ArtifactStoreError, Schema.TaggedStruct<"@smthrs/artifacts/ArtifactStoreError", {
    readonly code: Schema.Literals<readonly ["digest_failed", "invalid_configuration", "invalid_digest", "unavailable", "transport_failed"]>;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * A typed failure of the store itself: the host or crypto provider refused an
 * operation, the remote tier refused a request, or the caller supplied invalid
 * configuration or an invalid content address.
 *
 * Distinct from {@link ArtifactMissing} and {@link ArtifactCorruption} on
 * purpose. A miss is an ordinary, expected outcome that a second tier may
 * still satisfy; corruption is an integrity violation of the store's strongest
 * invariant. `invalid_configuration` and `invalid_digest` are permanent;
 * retryability of host, crypto, and transport failures depends on the cause.
 *
 * @category errors
 * @since 1.0.0-rc.0
 * @slop
 */
export declare class ArtifactStoreError extends ArtifactStoreError_base {
}
declare const ArtifactMissing_base: Schema.Class<ArtifactMissing, Schema.TaggedStruct<"@smthrs/artifacts/ArtifactMissing", {
    readonly code: Schema.Literal<"artifact_missing">;
    readonly digest: Schema.brand<Schema.String, "@smthrs/crypto/Sha256/Digest">;
}>, import("effect/Cause").YieldableError>;
/**
 * The typed miss: this tier holds no bytes at the requested address.
 *
 * A miss is not a failure of the store — it is the answer a read-through
 * composition is built to act on, so it is a distinct tag rather than an
 * `unavailable` code that a caller would have to string-match.
 *
 * @category errors
 * @since 1.0.0-rc.0
 * @slop
 */
export declare class ArtifactMissing extends ArtifactMissing_base {
}
declare const ArtifactCorruption_base: Schema.Class<ArtifactCorruption, Schema.TaggedStruct<"@smthrs/artifacts/ArtifactCorruption", {
    readonly code: Schema.Literal<"artifact_corruption">;
    readonly recordedDigest: Schema.brand<Schema.String, "@smthrs/crypto/Sha256/Digest">;
    readonly measuredDigest: Schema.brand<Schema.String, "@smthrs/crypto/Sha256/Digest">;
}>, import("effect/Cause").YieldableError>;
/**
 * Bytes stored at a content address no longer hash to it.
 *
 * Every read is digest-verified, so a truncated blob left by a crashing writer
 * or by disk corruption is refused rather than handed back as if it were the
 * recorded artifact.
 *
 * @category errors
 * @since 1.0.0-rc.0
 * @slop
 */
export declare class ArtifactCorruption extends ArtifactCorruption_base {
}
export {};
