import { Option } from "effect";
/**
 * Grant the request that was asked for and nothing more, then prove an
 * envelope covers it before storing it.
 *
 * @since 1.0.0
 */
import { Capability } from "@smthrs/capability";
/**
 * Derives the exact grant for a request, or nothing when the grammar cannot
 * express the resource without widening it.
 *
 * @param request - The capability a person approved.
 * @returns The grant pattern, or `Option.none()` for a resource with `*` or `?`.
 * @since 1.0.0
 */
export declare const exactGrant: (request: Capability.Capability) => Option.Option<Capability.CapabilityPattern>;
/**
 * Builds a subtree grant from an untrusted directory. The directory becomes an
 * exact capability first, so a `*` in it refuses instead of widening the grant.
 *
 * @param directory - An agent-supplied directory path.
 * @returns `fs:write` on `<directory>/**`, or `Option.none()`.
 * @since 1.0.0
 */
export declare const subtreeGrant: (directory: string) => Option.Option<Capability.CapabilityPattern>;
/**
 * Reports whether an envelope provably covers a claim. A `false` means the
 * coverage is not provable, so the caller asks again rather than storing it.
 *
 * @param envelope - The pattern a run already holds.
 * @param claim - The pattern a call needs.
 * @returns Whether every capability `claim` selects is selected by `envelope`.
 * @since 1.0.0
 */
export declare const covers: (envelope: Capability.CapabilityPattern, claim: Capability.CapabilityPattern) => boolean;
