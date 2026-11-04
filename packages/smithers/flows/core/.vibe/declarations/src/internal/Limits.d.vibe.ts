/**
 * The limits a flow declares for one run: budget ceilings and the sandbox it
 * selects. `/Markdown` publishes them; `@smthrs/registry`'s `Descriptor`
 * re-exports the same schemas, so a Markdown flow and its descriptor read one
 * definition.
 *
 * @since 1.0.0-rc.17
 */
import * as Schema from "effect/Schema";
/**
 * A positive safe-integer budget ceiling.
 *
 * Tokens are indivisible, and millisecond envelopes use the same finite,
 * lossless representation so both fields survive durable JSON unchanged.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const BudgetCeiling: Schema.Int;
/**
 * A positive, finite dollar ceiling. Dollars are divisible, so `0.5` is fifty
 * cents.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const UsdCeiling: Schema.Finite;
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
export declare const BudgetOnExceeded: Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>;
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
export declare const Budget: Schema.Struct<{
    readonly tokens: Schema.optional<Schema.Int>;
    readonly milliseconds: Schema.optional<Schema.Int>;
    readonly usd: Schema.optional<Schema.Finite>;
    readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
}>;
/**
 * The ceilings a flow declares for one run.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Budget = typeof Budget.Type;
/**
 * The sandbox providers a flow may name, one per `@smthrs/sandbox` provider
 * module.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const SandboxProvider: Schema.Literals<readonly ["aws", "cloudflare", "command", "container", "daytona", "directory", "just-bash", "kubernetes", "microsandbox", "vercel"]>;
/**
 * The sandbox a flow selects: the provider, plus the neutral network policy
 * and resource limits every `@smthrs/sandbox` provider accepts
 * (`Sandbox.NetworkPolicy`, `Sandbox.ResourceLimits`). `cpus` may be
 * fractional; `memoryMib` and `timeoutSecs` are positive safe integers.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export declare const SandboxSelection: Schema.Struct<{
    readonly provider: Schema.Literals<readonly ["aws", "cloudflare", "command", "container", "daytona", "directory", "just-bash", "kubernetes", "microsandbox", "vercel"]>;
    readonly network: Schema.optionalKey<Schema.Union<readonly [Schema.Literals<readonly ["none", "open"]>, Schema.Struct<{
        readonly allow: Schema.$Array<Schema.String>;
    }>]>>;
    readonly cpus: Schema.optionalKey<Schema.Finite>;
    readonly memoryMib: Schema.optionalKey<Schema.Int>;
    readonly timeoutSecs: Schema.optionalKey<Schema.Int>;
}>;
/**
 * The sandbox a flow selects.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type SandboxSelection = typeof SandboxSelection.Type;
