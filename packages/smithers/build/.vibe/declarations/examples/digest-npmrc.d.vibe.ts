/**
 * Writes `npmrc` as the `.npmrc` of a fresh temporary project and resolves
 * with its digest, or with the refusal's code.
 */
export declare const digestNpmrc: (npmrc: string) => Promise<"command_failed" | "environment_mismatch" | "input_drift" | "lockfile_unreadable" | "manifest_unreadable" | "unsafe_configuration" | "unsupported" | (string & import("effect/Brand").Brand<"@smthrs/crypto/Sha256/Digest">) | null>;
