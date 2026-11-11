/**
 * The limits a flow declares for one run: budget ceilings and the sandbox it
 * selects. `/Markdown` publishes them; `@smthrs/registry`'s `Descriptor`
 * re-exports the same schemas, so a Markdown flow and its descriptor read one
 * definition.
 *
 * @since 1.0.0-rc.17
 */

import * as Schema from "effect/Schema"

/**
 * A positive safe-integer budget ceiling.
 *
 * Tokens are indivisible, and millisecond envelopes use the same finite,
 * lossless representation so both fields survive durable JSON unchanged.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const BudgetCeiling = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * A positive, finite dollar ceiling. Dollars are divisible, so `0.5` is fifty
 * cents.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const UsdCeiling = Schema.Finite.check(Schema.isGreaterThan(0))

/**
 * What a run does when a model call would exceed one of its ceilings.
 *
 * `fail` fails the call, `warn` journals a warning and makes it,
 * `skip-remaining` refuses it and every later call in the run, and `park`
 * suspends the run until an operator approves a raised ceiling.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const BudgetOnExceeded = Schema.Literals(["fail", "warn", "skip-remaining", "park"])

/**
 * The ceilings a flow declares for one run, and what exceeding them does.
 *
 * An absent ceiling is not a zero: it is the absence of that ceiling.
 * `@smthrs/registry`'s `Descriptor.FlowBudget` extends these fields with the
 * run deadline.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Budget = Schema.Struct({
  tokens: Schema.optional(BudgetCeiling),
  milliseconds: Schema.optional(BudgetCeiling),
  usd: Schema.optional(UsdCeiling),
  onExceeded: Schema.optional(BudgetOnExceeded)
})

/**
 * The ceilings a flow declares for one run.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Budget = typeof Budget.Type

/**
 * The sandbox providers a flow may name, one per `@smthrs/sandbox` provider
 * module.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const SandboxProvider = Schema.Literals([
  "aws",
  "cloudflare",
  "command",
  "container",
  "daytona",
  "directory",
  "just-bash",
  "kubernetes",
  "microsandbox",
  "vercel"
])

/**
 * The sandbox a flow selects: the provider, plus the neutral network policy
 * and resource limits every `@smthrs/sandbox` provider accepts
 * (`Sandbox.NetworkPolicy`, `Sandbox.ResourceLimits`). `cpus` may be
 * fractional; `memoryMib` and `timeoutSecs` are positive safe integers.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const SandboxSelection = Schema.Struct({
  provider: SandboxProvider,
  network: Schema.optionalKey(Schema.Union([
    Schema.Literals(["none", "open"]),
    Schema.Struct({ allow: Schema.Array(Schema.String) })
  ])),
  cpus: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  memoryMib: Schema.optionalKey(BudgetCeiling),
  timeoutSecs: Schema.optionalKey(BudgetCeiling)
})

/**
 * The sandbox a flow selects.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type SandboxSelection = typeof SandboxSelection.Type
