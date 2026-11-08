/**
 * Typed permission failures and capability policy rules.
 *
 * This module is the `@smthrs/capability/Permission` barrel. Each public
 * concept is defined in the file of the same name and re-exported here, so
 * `Permission.evaluate` and `import { Rule } from ".../Permission.ts"` keep
 * working unchanged. Every module on this side reaches capability values
 * through the `Capability` barrel, never its parts, so a test that mocks that
 * barrel observes the same calls the kernel makes.
 *
 * The schema ids are identity, not display text: a stored decision keeps
 * those exact strings and is read back through them.
 *
 * Reference: https://capability.smithers.sh/concepts/authorization-model/
 *
 * @since 0.1.0
 */

export * from "./evaluate.ts"
export * from "./formatError.ts"
export * from "./fromPlatformError.vibe"
export * from "./GrantStoreError.vibe"
export * from "./GrantStoreErrorCode.vibe"
export * from "./isPermissionError.vibe"
export * from "./maxDisplayFieldLength.ts"
export * from "./PermissionDenied.vibe"
export * from "./PermissionError.vibe"
export type { PermissionErrorPayload } from "./PermissionErrorPayload.ts"
export * from "./PermissionRequired.vibe"
export * from "./Rule.vibe"
export * from "./RuleEffect.vibe"
export * from "./toPlatformError.ts"
