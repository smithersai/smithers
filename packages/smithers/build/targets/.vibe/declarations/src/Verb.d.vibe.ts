/**
 * The CLI verbs a generated pipeline may run across a target graph.
 *
 * A pipeline declaration names verbs, not target kinds: `smithers-build test '//...'`
 * is one command a CI job runs, the same verb-and-pattern shape Bazel's own CI
 * uses for `bazel test //...`. Before this module a PACKAGE.ts file named them
 * with bare strings, so the authoring surface was four quoted words whose
 * spelling nothing checked at the call site and whose meaning the attr name did
 * not explain.
 *
 * This module gives each verb a value. `Verb.Build`, `Verb.Test`, `Verb.Lint`,
 * `Verb.Docs`, and `Verb.Review` are declarations a PACKAGE.ts file
 * references by name, so a misspelling is an unresolved identifier rather than
 * a string the renderer rejects at plan time.
 *
 * The set is deliberately smaller than {@link Target.Kind}. `run` is
 * addressable from the CLI and is not here: run targets include development
 * servers and source-tree scaffolds, and an unattended pipeline must not start
 * or mutate one merely because it is addressable. A pipeline that runs `run`
 * targets is therefore not a declaration that exists, rather than one the
 * renderer refuses.
 *
 * `review` IS here, and it is not in {@link all}. A pipeline may declare a job
 * that runs the model reviews, and that job is the only thing that plans them:
 * the aggregate `ci` verb does not.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
import type * as Target from "../../../src/Target.ts";
/**
 * Schema for the `build` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const BuildVerb: Schema.Struct<{
    readonly name: Schema.Literal<"build">;
}>;
/**
 * The `build` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type BuildVerb = typeof BuildVerb.Type;
/**
 * Schema for the `test` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const TestVerb: Schema.Struct<{
    readonly name: Schema.Literal<"test">;
}>;
/**
 * The `test` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type TestVerb = typeof TestVerb.Type;
/**
 * Schema for the `lint` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const LintVerb: Schema.Struct<{
    readonly name: Schema.Literal<"lint">;
}>;
/**
 * The `lint` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type LintVerb = typeof LintVerb.Type;
/**
 * Schema for the `docs` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const DocsVerb: Schema.Struct<{
    readonly name: Schema.Literal<"docs">;
}>;
/**
 * The `docs` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type DocsVerb = typeof DocsVerb.Type;
/**
 * Schema for the `review` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const ReviewVerb: Schema.Struct<{
    readonly name: Schema.Literal<"review">;
}>;
/**
 * The `review` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type ReviewVerb = typeof ReviewVerb.Type;
/**
 * Schema for the aggregate `ci` verb.
 *
 * `ci` is not a {@link Target.Kind}: it is the CLI's own name for planning every
 * kind over one pattern in a single invocation. It has a value here so a
 * pipeline declaration can ask for the aggregate without restating the four
 * verbs it stands for.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const CiVerb: Schema.Struct<{
    readonly name: Schema.Literal<"ci">;
}>;
/**
 * The aggregate `ci` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type CiVerb = typeof CiVerb.Type;
/**
 * Schema for one verb a generated pipeline may run.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Verb: Schema.Union<readonly [Schema.Struct<{
    readonly name: Schema.Literal<"build">;
}>, Schema.Struct<{
    readonly name: Schema.Literal<"test">;
}>, Schema.Struct<{
    readonly name: Schema.Literal<"lint">;
}>, Schema.Struct<{
    readonly name: Schema.Literal<"docs">;
}>, Schema.Struct<{
    readonly name: Schema.Literal<"review">;
}>]>;
/**
 * One verb a generated pipeline may run.
 *
 * @category models
 * @since 0.1.0
 */
export type Verb = typeof Verb.Type;
/**
 * Builds every target in the pattern.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * // Runs `smithers-build build '//...'`
 * export const verbs = [Smithers.Verb.Build]
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const Build: BuildVerb;
/**
 * Runs every test target in the pattern.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const Test: TestVerb;
/**
 * Runs every lint target in the pattern.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const Lint: LintVerb;
/**
 * Runs the documentation-parity check over the pattern.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const Docs: DocsVerb;
/**
 * Runs the model-assisted review targets in the pattern.
 *
 * Deliberately its own verb rather than a flavour of `lint`. A review target
 * diffs the checkout against a base revision and spawns a model CLI, so it
 * needs a full-history checkout, a model binary, and a credential that no
 * ordinary lint job has. Kept under `lint` it was planned by every wildcard
 * `lint` and by the aggregate `ci`, and both died at plan time on a shallow
 * pull-request checkout where `origin/main` does not exist. A job that wants
 * the reviews asks for them by name.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const Review: ReviewVerb;
/**
 * The verbs the aggregate `ci` command runs, in the order it aggregates them.
 *
 * A pipeline declaring exactly this set is the aggregate `ci` command, so the
 * renderer collapses it to one step. {@link Review} is not here and never
 * will be: `ci` is the unattended, hermetic verb, and a model call is neither.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const all: ReadonlyArray<Verb>;
/**
 * Plans and runs every verb over one pattern in a single invocation.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * // Runs `smithers-build ci '//packages/...'`
 * export const verb = Smithers.Verb.Ci
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const Ci: CiVerb;
/**
 * Schema for one verb a generated pipeline step may run, aggregate included.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const PipelineVerb: Schema.Union<readonly [Schema.Struct<{
    readonly name: Schema.Literal<"build">;
}>, Schema.Struct<{
    readonly name: Schema.Literal<"test">;
}>, Schema.Struct<{
    readonly name: Schema.Literal<"lint">;
}>, Schema.Struct<{
    readonly name: Schema.Literal<"docs">;
}>, Schema.Struct<{
    readonly name: Schema.Literal<"review">;
}>, Schema.Struct<{
    readonly name: Schema.Literal<"ci">;
}>]>;
/**
 * One verb a generated pipeline step may run, aggregate included.
 *
 * @category models
 * @since 0.1.0
 */
export type PipelineVerb = typeof PipelineVerb.Type;
/**
 * Checks whether a value is a pipeline verb.
 *
 * @category guards
 * @since 0.1.0
 */
export declare const isVerb: (value: unknown) => value is Verb;
/**
 * Checks whether a value is a verb a generated pipeline step may run.
 *
 * @category guards
 * @since 0.1.0
 */
export declare const isPipelineVerb: (value: unknown) => value is PipelineVerb;
/**
 * The CLI subcommand one pipeline verb names.
 *
 * @category accessors
 * @since 0.1.0
 */
export declare const command: (verb: PipelineVerb) => string;
/**
 * The target kind one verb selects.
 *
 * The return type is what keeps this module and {@link Target.Kind} from
 * drifting: a verb whose name is not a kind the CLI has would not typecheck
 * here.
 *
 * @category accessors
 * @since 0.1.0
 */
export declare const kind: (verb: Verb) => Target.Kind;
