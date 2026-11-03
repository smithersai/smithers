/**
 * Parses Agent Skills documents and lowers markdown prompts into ordinary
 * flows.
 *
 * General markdown discovery belongs to `/registry`. Agent Skills
 * frontmatter is parsed with the complete failsafe YAML schema, then checked
 * against the intrinsic rules of the Agent Skills specification
 * (https://agentskills.io/specification), before this module lowers the
 * document to the ordinary flow shape. The one rule that needs the file
 * system, that `name` equals the skill directory name, stays with the
 * registry.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */
import type * as Duration from "effect/Duration";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Effects from "../../../src/Effects.ts";
import * as Flow from "../../../src/Flow.ts";
import { Budget, SandboxSelection } from "./internal/Limits.vibe";
/**
 * Separates leading YAML frontmatter from the markdown body without parsing it.
 * @category parsing
 * @since 1.0.0
 */
export { split as splitFrontmatter } from "./internal/skillFrontmatter.vibe";
declare const input: Schema.Struct<{
    readonly args: Schema.String;
}>;
type input = typeof input.Type;
declare const output: Schema.String;
/**
 * Already-parsed metadata accepted by the markdown flow loader.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface MarkdownFrontmatter {
    /**
     * The flow's name, which becomes its tag.
     *
     * It is required because the tag is what a host binds an implementation to
     * and what a plan records; a registry derives it from the frontmatter or
     * from the document's path before lowering.
     */
    readonly name: string;
    readonly description?: string | undefined;
    readonly model?: string | readonly [string, ...Array<string>] | undefined;
    readonly flows?: ReadonlyArray<string> | undefined;
    readonly capabilities?: ReadonlyArray<string> | undefined;
    readonly effects?: {
        readonly reads?: ReadonlyArray<string> | undefined;
        readonly writes?: ReadonlyArray<string> | undefined;
        readonly mode?: Effects.Declaration["mode"] | undefined;
        readonly onConflict?: Effects.Declaration["onConflict"] | undefined;
        readonly tier?: Effects.Declaration["tier"];
    } | undefined;
    readonly placement?: "sandbox" | "remote" | "client" | "local" | undefined;
    /**
     * Whether a catalog may offer this flow to a model; `@smthrs/flow`'s
     * `Flow.ModelInvocable`. Defaults to `true`.
     *
     * @since 1.0.0-rc.17
     */
    readonly modelInvocable?: boolean | undefined;
    /**
     * The tokens, milliseconds and dollars one run asks a control plane to
     * approve, and what exceeding them does.
     *
     * @since 1.0.0-rc.17
     */
    readonly budget?: Budget | undefined;
    /**
     * How long one run may take, counted from its first start; `@smthrs/flow`'s
     * `Flow.make` `deadline`. A number is milliseconds.
     *
     * @since 1.0.0-rc.17
     */
    readonly deadline?: Duration.Input | undefined;
    /**
     * The sandbox the flow runs in. Selecting one places the flow in a sandbox.
     *
     * @since 1.0.0-rc.17
     */
    readonly sandbox?: SandboxSelection | undefined;
}
/**
 * A positive safe-integer budget ceiling. Tokens are indivisible, and
 * milliseconds use the same lossless representation.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export { BudgetCeiling } from "./internal/Limits.vibe";
/**
 * A positive, finite dollar ceiling. Dollars are divisible, so `0.5` is fifty
 * cents.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export { UsdCeiling } from "./internal/Limits.vibe";
/**
 * What a run does when a model call would exceed one of its ceilings: `fail`
 * fails the call, `warn` journals a warning and makes it, `skip-remaining`
 * refuses it and every later call in the run, and `park` suspends the run
 * until an operator approves a raised ceiling.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export { BudgetOnExceeded } from "./internal/Limits.vibe";
/**
 * The tokens, milliseconds and dollars one run asks a control plane to
 * approve, and what exceeding them does. An absent ceiling is not a zero: it
 * is the absence of that ceiling. `@smthrs/registry`'s `Descriptor.FlowBudget`
 * extends these fields with the run deadline.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export { Budget } from "./internal/Limits.vibe";
/**
 * The sandbox providers a flow may name, one per `@smthrs/sandbox` provider
 * module.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export { SandboxProvider } from "./internal/Limits.vibe";
/**
 * The sandbox a flow selects: the provider, plus the neutral network policy
 * and resource limits every `@smthrs/sandbox` provider accepts. `cpus` may be
 * fractional; `memoryMib` and `timeoutSecs` are positive safe integers.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export { SandboxSelection } from "./internal/Limits.vibe";
/**
 * Agent Skills frontmatter that passed {@link validateSkillFrontmatter}.
 *
 * `allowedTools` is the specification's space-separated `allowed-tools`
 * scalar, split into tool names. `extra` holds every other field, including
 * the validated optional `license`, `compatibility`, and `metadata`, as a
 * frozen null-prototype record.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface SkillFrontmatter {
    readonly name: string;
    readonly description: string;
    readonly allowedTools: ReadonlyArray<string>;
    readonly extra: Record<string, unknown>;
}
/**
 * Parsed Agent Skills document.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface SkillDocument extends SkillFrontmatter {
    readonly body: string;
}
/**
 * Stable code emitted by markdown loader failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export declare const MarkdownErrorCode: Schema.Literals<readonly ["skill_missing_frontmatter", "skill_invalid_frontmatter", "skill_missing_name", "skill_invalid_name", "skill_missing_description", "skill_invalid_description", "skill_invalid_allowed_tools", "skill_invalid_compatibility", "skill_invalid_metadata", "skill_invalid_license"]>;
/**
 * Stable code emitted by markdown loader failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type MarkdownErrorCode = typeof MarkdownErrorCode.Type;
declare const MarkdownError_base: Schema.Class<MarkdownError, Schema.TaggedStruct<"flows/core/MarkdownError", {
    readonly code: Schema.Literals<readonly ["skill_missing_frontmatter", "skill_invalid_frontmatter", "skill_missing_name", "skill_invalid_name", "skill_missing_description", "skill_invalid_description", "skill_invalid_allowed_tools", "skill_invalid_compatibility", "skill_invalid_metadata", "skill_invalid_license"]>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A typed markdown loader failure.
 *
 * @category errors
 * @since 0.0.0
 * @slop
 */
export declare class MarkdownError extends MarkdownError_base {
}
/**
 * Lowers parsed markdown metadata and a markdown body to an ordinary flow.
 *
 * The prompt is the markdown body. Harnesses append non-empty runtime `args`
 * when rendering that prompt, preserving the markdown-flow calling convention.
 * The lowered flow declares no body, so it carries the action a host supplies
 * the implementation for; the collaborators it names stay declarations, and no
 * flow implementation is resolved while lowering. The `smart` model seat is
 * the explicit fallback when frontmatter declares no `model`.
 * Model-seat and collaborator arrays are copied, so later changes to the
 * supplied frontmatter arrays do not change the lowered flow or its decorators.
 *
 * The declared limits are part of the flow, not metadata beside it.
 * `modelInvocable` and `deadline` go to `@smthrs/flow`'s `Flow.make`, so the
 * native flow carries `Flow.ModelInvocable` and enforces the deadline;
 * `budget` and `sandbox` are copied onto the signature. A `sandbox` selection
 * places the flow in a sandbox. An invalid limit, or a sandbox selection
 * beside another placement, throws a `RangeError` naming the flow and the
 * field, like `Flow.make`'s own construction errors.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export declare const lowerMarkdown: (frontmatter: MarkdownFrontmatter, body: string) => Flow.Flow<typeof input, typeof output>;
/**
 * Whether `name` is a valid Agent Skills name: 1 to 64 lowercase ASCII
 * letters, digits, or single hyphens, not starting or ending with a hyphen.
 *
 * {@link validateSkillFrontmatter} applies this rule, and `@smthrs/registry`
 * reads the same predicate when it warns about a discovered skill's name, so
 * the rule has one definition.
 *
 * @category validation
 * @since 1.0.0-rc.1
 */
export declare const isSkillName: (name: string) => boolean;
/**
 * Checks already-parsed Agent Skills frontmatter against the specification's
 * intrinsic rules and lowers the fields this package reads.
 *
 * `name` is 1 to 64 lowercase ASCII letters, digits, or single hyphens and
 * cannot start or end with a hyphen. `description` is 1 to 1024 characters.
 * `allowed-tools`, when present, is one space-separated scalar. `license` is
 * a scalar, `compatibility` is 1 to 500 characters, and `metadata` maps
 * string keys to scalar values. A field that is absent reports a `missing`
 * code; a field that is present but malformed reports its own `invalid` code
 * without echoing the offending value. The registry keeps the one rule that
 * needs the file system: `name` must equal the skill directory name.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export declare const validateSkillFrontmatter: (fields: Record<string, unknown>) => Result.Result<SkillFrontmatter, MarkdownError>;
/**
 * Parses an Agent Skills document with failsafe-schema YAML semantics and
 * validates its frontmatter with {@link validateSkillFrontmatter}.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export declare const parseSkill: (text: string) => Result.Result<SkillDocument, MarkdownError>;
/**
 * Parses and lowers an Agent Skills document to an ordinary flow.
 *
 * Only `name`, `description`, and `allowed-tools` are lowered. Every other
 * frontmatter field remains in {@link parseSkill}'s `extra` record for the
 * caller to interpret. Agent Skills frontmatter is untyped failsafe YAML;
 * coercing extra fields such as `model` or `placement` here would duplicate
 * the flow-level frontmatter typing owned by `@smthrs/registry`.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export declare const lowerSkill: (text: string) => Result.Result<Flow.Flow<typeof input, typeof output>, MarkdownError>;
