/**
 * Safe derivation of an exact grant pattern from a capability.
 *
 * @since 0.1.0
 */
import { Option } from "effect";
import { CapabilityPattern } from "./CapabilityPattern.vibe";
import type { Capability } from "./ExactCapability.vibe";
/**
 * Derives an exact pattern from a capability when the glob grammar can
 * represent the resource exactly.
 *
 * The function returns `Option.none()` when the resource is longer than
 * {@link maxResourceLength} or contains `*` or `?`. The grammar has no escape
 * for those metacharacters, so returning a pattern would silently widen the
 * grant. Quotes, newlines, and other literal text are accepted. The derived
 * pattern matches that resource and nothing else because the matcher neither
 * normalizes text nor folds case.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export declare const patternFromCapability: (capability: Capability) => Option.Option<CapabilityPattern>;
