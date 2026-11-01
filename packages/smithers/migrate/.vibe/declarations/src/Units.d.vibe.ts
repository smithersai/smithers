/**
 * Partitions a scan into ordered migration units.
 *
 * A unit is one checkpoint, one agent frame, and one verification. Keeping
 * them small is what makes a failure recoverable: the tool restores the unit's
 * checkpoint, marks it failed, and carries on with the next one, so a project
 * never ends up half rewritten with no way back.
 *
 * The order is fixed. Dependencies first, so the new packages are installed
 * beside the old ones and every later unit can import them. Then one unit per
 * workflow, with each shared component or library attached to the first
 * workflow that needs it. Then one unit per integration. Then the project unit,
 * which removes the old packages, the JSX settings, and the old CLI scripts
 * once nothing depends on them.
 *
 * @since 1.0.0-rc.0
 */
import * as Schema from "effect/Schema";
import type { Detection, SpecifierContext } from "./Detect.ts";
import * as FlowNames from "./internal/FlowNames.ts";
import * as Ts from "./internal/Ts.ts";
import type { InventoryEntry } from "./Inventory.vibe";
import * as Mapping from "./Mapping.ts";
import type { PromptHint } from "./PromptHints.ts";
import type { ZodHint } from "./ZodSchemaHints.ts";
/**
 * What a unit migrates.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type UnitKind = "dependencies" | "workflow" | "integration" | "project";
/**
 * A repository-derived command: an executable and its literal arguments,
 * spawned with no shell in between.
 *
 * A path the scanner found on disk is an argument here, never a fragment of
 * a command line. `tsconfig; rm -rf .json` is a legal file name, and as an
 * argv element it is exactly that name and nothing more.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const ArgvCommand: Schema.Struct<{
    readonly _tag: Schema.Literal<"argv">;
    readonly executable: Schema.String;
    readonly args: Schema.$Array<Schema.String>;
}>;
/**
 * A repository-derived command whose arguments never pass through a shell.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ArgvCommand = typeof ArgvCommand.Type;
/**
 * One verification command.
 *
 * A structured command is derived from repository metadata and executes as a
 * literal argv. A bare string is reserved for an explicit operator override
 * (`--verify-*`) and deliberately keeps shell semantics: the operator typed
 * the line and is the one person allowed to.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const VerificationCommand: Schema.Union<readonly [Schema.String, Schema.Struct<{
    readonly _tag: Schema.Literal<"argv">;
    readonly executable: Schema.String;
    readonly args: Schema.$Array<Schema.String>;
}>]>;
/**
 * One structured or explicitly shell-backed verification command.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type VerificationCommand = typeof VerificationCommand.Type;
/**
 * Builds a structured command.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const argv: (executable: string, ...args: ReadonlyArray<string>) => ArgvCommand;
/**
 * The commands that verify one unit.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface VerifyCommands {
    readonly install: VerificationCommand | undefined;
    readonly format: VerificationCommand | undefined;
    readonly typecheck: ReadonlyArray<VerificationCommand>;
    readonly test: VerificationCommand | undefined;
    readonly discovery: {
        readonly flowsDir: string;
    };
    /**
     * What the derivation could not honor, so the report says which command
     * really ran. A `smithers.config.ts` test line that needs a shell is not run
     * as written: the tool runs no repository-authored shell syntax.
     */
    readonly notes: ReadonlyArray<UnitNote>;
}
/**
 * Something the plan itself could not settle, in the shape the report's
 * `unresolved` table takes.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface UnitNote {
    readonly construct: string;
    readonly reason: string;
    readonly file: string;
    readonly line: number;
    readonly suggestion: string;
}
/**
 * One migration unit.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface UnitPlan {
    readonly id: string;
    readonly kind: UnitKind;
    readonly sources: ReadonlyArray<string>;
    readonly targets: ReadonlyArray<string>;
    readonly constructs: ReadonlyArray<InventoryEntry>;
    readonly mapping: ReadonlyArray<Mapping.MappingRow>;
    readonly hints: {
        readonly zod: ReadonlyArray<ZodHint>;
        readonly prompt: ReadonlyArray<PromptHint>;
    };
    /** Distinct constructs in this unit that have no safe automatic translation. */
    readonly unsafe: ReadonlyArray<string>;
    /** What planning this unit could not settle. Reaches the report unresolved. */
    readonly notes: ReadonlyArray<UnitNote>;
    /**
     * What the project's manifests said about the names that exist in both
     * trees, so a check can tell an old import from a new one.
     */
    readonly specifiers: SpecifierContext;
    readonly verification: VerifyCommands;
}
/**
 * What {@link plan} reads. A `ScanResult` satisfies it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface PlanInput {
    readonly detection: Detection;
    readonly inventory: ReadonlyArray<InventoryEntry>;
    readonly hints: {
        readonly zod: ReadonlyArray<ZodHint>;
        readonly prompt: ReadonlyArray<PromptHint>;
    };
}
/**
 * Command overrides, from the CLI.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface CommandOverrides {
    readonly install?: string | undefined;
    readonly format?: string | undefined;
    readonly typecheck?: ReadonlyArray<string> | undefined;
    readonly test?: string | undefined;
}
/**
 * Options for {@link plan}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
    readonly flowsDir?: string | undefined;
    readonly commands?: CommandOverrides | undefined;
    /** Restrict the plan to these unit ids. */
    readonly units?: ReadonlyArray<string> | undefined;
}
/**
 * A repository-authored command line as an argv, when it is one.
 *
 * Only a line made of plain words qualifies: no quotes, no `$`, `;`, `|`,
 * `&`, redirections, globs, or newlines, and an executable that is not a
 * flag. Anything else would need a shell to mean what it says, and the tool
 * gives repository text no shell. The caller records what it did instead.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const simpleCommand: (line: string) => ArgvCommand | undefined;
/**
 * Where migrated flows are written, relative to the project root: the 1.0
 * project flows directory, `@smthrs/registry`'s
 * `Descriptor.projectFlowsDirectory` (mvp.md M-49). The core does not load the
 * optional registry at module load, so a test pins the two equal.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const defaultFlowsDir = ".smithers/flows";
/**
 * Derives the commands that verify a migrated project: install from the
 * lockfile, format from the formatter the project already configures,
 * typecheck once per `tsconfig.json`, and test from `smithers.config.ts`
 * `repoCommands.test` or the root `package.json` test script.
 *
 * Every derived command is an {@link ArgvCommand}: the executable and its
 * arguments are spawned as they are, so a file name the scanner read off the
 * disk can never become shell syntax. The formatter runs in check mode
 * (`dprint check`, `prettier --check .`) because a verification is a
 * question, and a formatter that rewrites the whole repository answers it by
 * editing files the unit does not own.
 *
 * Every one of them is overridable, because the tool must never invent a
 * command that runs the operator's code. An override is the operator's own
 * line and keeps its shell semantics.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export declare const verifyCommands: (detection: Detection, overrides?: CommandOverrides, flowsDir?: string) => VerifyCommands;
/**
 * The flow name a workflow file becomes, in registry path naming.
 *
 * A file under `.smithers/workflows/` keeps its position, so
 * `.smithers/workflows/pipelines/ci-fast.tsx` becomes `pipelines/ci-fast` and
 * lands at `.smithers/flows/pipelines/ci-fast/flow.ts`. Anything else keeps its own
 * directories, so `examples/hello.jsx` becomes `examples/hello` and
 * `src/wf/hello.tsx` becomes `src/wf/hello`.
 *
 * The directories are kept because the name is a unit id and a target path at
 * once. Collapsing to the basename gave two workflows in different directories
 * one id and one `flow.ts`: the second agent overwrote the first agent's flow,
 * one unit's outcome vanished from the report because `Report.withUnit`
 * replaces by id, and both units wrote the same artifact file. A root-level
 * file is unaffected, because it has no directories to keep.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export declare const flowName: typeof FlowNames.fromPath;
/**
 * Every unit id carried by more than one plan, with the sources behind it.
 *
 * {@link flowName} makes a collision rare rather than impossible: a project
 * holding both `.smithers/workflows/hello.tsx` and `hello.tsx` still names one
 * flow twice. A duplicate id cannot be caught downstream — the stale-plan gate
 * joins the ids into one string, so both strings carry the duplicate — so the
 * plan is checked here and the scan refuses.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export declare const duplicateIds: (units: ReadonlyArray<UnitPlan>) => ReadonlyArray<{
    readonly id: string;
    readonly sources: ReadonlyArray<string>;
}>;
/**
 * What the manifests decided about the specifiers that exist in both trees.
 *
 * Design 3.2 gates the import rules on 3.1: the bare name `smithers` and every
 * `@smthrs/<name>` that survived into 1.0 are old only where a manifest said
 * so, and a check that runs after the transform has to be told the same thing
 * the scan was.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export declare const specifierContext: (detection: Detection) => SpecifierContext;
/**
 * Orders workflow files so a workflow another one imports is migrated first.
 *
 * Design 5.2 asks for dependency order, not path order: a pack whose
 * `a-first.tsx` imports `./z-last.tsx` has to migrate `z-last` first, or the
 * unit that rewrites `a-first` has nothing to point its child-flow reference
 * at. The sort is a depth-first topological walk with a lexical tie-break, so
 * two independent workflows always come out in the same order, and a cycle
 * falls back to the lexical order of the files in it.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export declare const orderWorkflows: <A extends {
    readonly path: string;
}>(workflows: ReadonlyArray<A>, imports: ReadonlyArray<{
    readonly file: string;
    readonly specifier: string;
    readonly kind: string;
}>) => {
    readonly ordered: ReadonlyArray<A>;
    readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
};
/**
 * Plans the migration.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export declare const plan: (input: PlanInput, options?: Options, parse?: typeof Ts.parse) => ReadonlyArray<UnitPlan>;
