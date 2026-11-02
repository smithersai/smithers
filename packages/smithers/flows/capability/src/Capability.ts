/**
 * Capability values, wildcard policy patterns, and effect-tier
 * classification.
 *
 * This module is the `@smthrs/capability/Capability` barrel. Each public
 * concept is defined in the file of the same name and re-exported here, so
 * `Capability.matches` and `import { matches } from ".../Capability.ts"`
 * keep working unchanged. The `Capability` class itself lives in
 * `ExactCapability.ts`, because a class defined in this barrel would sit in
 * a runtime cycle with the constructors and parsers that instantiate it.
 *
 * Reference: https://capability.smithers.sh/concepts/resource-globs/
 *
 * @since 0.1.0
 */

export * from "./Action.vibe"
export * from "./CapabilityPattern.vibe"
export * from "./EffectTier.vibe"
export { Capability } from "./ExactCapability.vibe"
export * from "./format.ts"
export * from "./InvalidCapabilityAction.vibe"
export * from "./isLiteralResource.ts"
export * from "./make.ts"
export * from "./matches.ts"
export * from "./maxMatchWork.ts"
export * from "./maxResourceLength.ts"
export * from "./mayOverlap.ts"
export * from "./parse.vibe"
export * from "./parsePattern.vibe"
export * from "./PatternAction.vibe"
export * from "./patternFromCapability.vibe"
export * from "./requiresIdempotencyKey.ts"
export * from "./subsumes.ts"
export * from "./tierOf.ts"
export * from "./TierOptions.ts"
export * from "./withinMatchBudget.ts"
