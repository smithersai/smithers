/**
 * The security-review macro: one declaration, two model-review targets.
 *
 * A package declares the security checks an agent must perform on it, each a
 * named threat and the concrete, falsifiable things to inspect. The macro
 * renders those checks into an LlmLint rubric, always appends the built-in
 * `general` check that sweeps for every vulnerability class the named checks
 * miss, and returns two targets over the same rubric:
 *
 * - `security` reviews the files changed against `origin/main`. It is the cheap
 *   advisory review that `smthrs review '//...'` plans; the aggregate `ci`
 *   verb never plans a review.
 * - `securityAudit` reviews every included file, whether or not it changed
 *   (LlmLint scope `all`). It is manual: a bare wildcard skips it,
 *   and `smthrs review '//packages/x/...:securityAudit'` audits a whole
 *   package subtree, nested packages included.
 *
 * The prompt frames the run as what it is: an authorized defensive review of
 * the repository owner's own code. Findings name the flaw, the attacker
 * precondition, the location, and the fix, never a weaponized exploit.
 *
 * @since 1.0.0
 */
import * as Input from "../../../src/Input.ts";
import { Finding, LlmLint, Reproduction, type ReviewBudget } from "../../../src/LlmLint.ts";
import type { Engine } from "./ModelEngine.vibe";
import * as Target from "../../../src/Target.ts";
/**
 * The model a `claude` security review runs on when the caller names none.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const defaultClaudeModel = "claude-opus-5-5";
/**
 * The model a `codex` security review runs on when the caller names none.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const defaultCodexModel = "gpt-6-sol";
/**
 * One security check a reviewer performs on a package.
 *
 * `id` is kebab-case and unique within the declaration; every finding names
 * it. `threat` says who could do what to whose data or system. `lookFor` lists
 * concrete, falsifiable things to inspect. `paths` are package-relative globs
 * (or `//` workspace-rooted) the check focuses on; omitted, it applies to every
 * reviewed file.
 *
 * @category models
 * @since 1.0.0
 */
export interface Check {
    readonly id: string;
    readonly title: string;
    readonly threat: string;
    readonly lookFor: ReadonlyArray<string>;
    readonly paths?: ReadonlyArray<string> | undefined;
}
/**
 * A trust boundary's actors, assumptions and ordered cross-package execution path.
 * Path entries use the same file glob syntax as include. Every path is reviewed
 * and supplied as context in every batch; cwd records ownership, not scope.
 *
 * @category models
 * @since 1.0.0
 */
export interface Boundary {
    readonly id: string;
    readonly actors: ReadonlyArray<string>;
    readonly assets: ReadonlyArray<string>;
    readonly entryPoints: ReadonlyArray<string>;
    readonly identityTransformations: ReadonlyArray<string>;
    readonly enforcementPoints: ReadonlyArray<string>;
    readonly deploymentAssumptions: ReadonlyArray<string>;
    readonly path: {
        readonly caller: ReadonlyArray<string>;
        readonly authorization: ReadonlyArray<string>;
        readonly service: ReadonlyArray<string>;
        readonly storageOrEgress: ReadonlyArray<string>;
    };
}
/**
 * The built-in check every security review ends with.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const generalCheck: Check;
/**
 * The framing every security review prompt starts with.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const securityPrompt: string;
/**
 * Renders the rubric for a list of checks whose `paths` are already
 * workspace-relative, the built-in general check included.
 *
 * @category rendering
 * @since 1.0.0
 */
export declare const renderRubric: (checks: ReadonlyArray<Check>) => string;
/**
 * Options for {@link SecurityReview}.
 *
 * `cwd` is the workspace-relative package directory. `include` defaults to
 * `src/**`; patterns are package-relative unless they start with `//`.
 * `context` files are read into every batch whether or not they changed.
 * `engine` defaults to `claude` on {@link defaultClaudeModel}; `codex`
 * defaults to {@link defaultCodexModel}. `base` is the diff review's base,
 * `origin/main` by default. `batchSize` (default 4) caps changed files per
 * model call in the diff review and `auditBatchSize` (default 8) in the full
 * audit. Related files share a call and carry their unchanged callers and
 * dependencies; `contextTokens` is the model's context window each call fits.
 * `required` makes both targets fail on an empty selection or a missing model
 * executable, and `budget` caps their aggregate model calls, prompt tokens and
 * wall-clock time.
 *
 * `workspaceRoot` is the absolute workspace root the declaration is checked
 * against. It defaults to the root derived from the declaring `PACKAGE.ts`
 * and `cwd`. When a root is known, every `context` entry must match at least
 * one file, and every check path must match at least one file that an
 * `include` or `context` glob also matches; otherwise the declaration throws.
 * Outside a `PACKAGE.ts` with no `workspaceRoot`, the paths are not checked.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
    readonly cwd: string;
    readonly checks: ReadonlyArray<Check>;
    readonly boundaries?: ReadonlyArray<Boundary> | undefined;
    readonly include?: ReadonlyArray<Input.Glob | string> | undefined;
    readonly context?: ReadonlyArray<Input.Glob | string> | undefined;
    readonly deps?: ReadonlyArray<Target.AnyTarget> | undefined;
    readonly engine?: Engine | undefined;
    readonly model?: string | undefined;
    readonly base?: string | undefined;
    readonly batchSize?: number | undefined;
    readonly auditBatchSize?: number | undefined;
    readonly contextTokens?: number | undefined;
    readonly required?: boolean | undefined;
    readonly budget?: ReviewBudget | undefined;
    readonly summary?: string | undefined;
    readonly workspaceRoot?: string | undefined;
}
/**
 * The two targets {@link SecurityReview} returns.
 *
 * @category models
 * @since 1.0.0
 */
export interface SecurityTargets {
    readonly security: ReturnType<typeof LlmLint>;
    readonly securityAudit: ReturnType<typeof LlmLint>;
}
/**
 * Declares a package's security review: the `security` diff review and the
 * manual `securityAudit` full audit, both over the declared checks plus the
 * built-in `general` check. Spread the result into the package's targets.
 *
 * The call validates the checks and their paths against the workspace (see
 * {@link Options}) and returns declarations; it runs no review.
 * A blocking release recommendation fails the target, including suspected
 * high or critical impact. Model assertions cannot confirm a finding.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const securityReview = Smithers.SecurityReview({
 *   cwd: "packages/example",
 *   checks: [{
 *     id: "upload-path-traversal",
 *     title: "Upload paths stay inside the upload root",
 *     threat: "An authenticated user writes files outside their upload directory.",
 *     lookFor: ["A request-supplied file name joined to the root without normalizing and prefix-checking."],
 *     paths: ["src/upload/**"]
 *   }]
 * })
 *
 * export const Package = Smithers.Package({ targets: { ...securityReview } })
 * ```
 *
 * @category macros
 * @since 1.0.0
 */
export declare const SecurityReview: (options: Options) => SecurityTargets;
/**
 * Records a trusted host's controlled reproduction. The host must actually run
 * the command against the immutable revision and retain its execution evidence.
 * Never pass model output here: this attestation boundary does not execute commands.
 * Confirmation does not change impact or release advice.
 *
 * @category verification
 * @since 1.0.0
 */
export declare const confirmFinding: (finding: Finding, receipt: typeof Reproduction.Type) => Finding;
