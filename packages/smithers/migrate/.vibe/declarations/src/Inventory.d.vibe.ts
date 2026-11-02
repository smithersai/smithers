/**
 * The per-file construct inventory.
 *
 * `Detect` says which files matter. This module says what is in them: every
 * JSX element whose tag resolves to a Smithers 0.x component, every `ctx`
 * accessor, every agent constructor, every runtime call, and every named
 * import of the old facade. Each hit carries the props that are present,
 * because a prop is what raises a construct's class (`Mapping.classify`).
 *
 * Resolution is syntactic. A tag counts only when its identifier comes from an
 * old import or from destructuring a `createSmithers` factory, so a workflow
 * written against a foreign authoring API contributes nothing and is reported
 * as `unknown-authoring-api` instead of being mistranslated.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Detect from "../../../src/Detect.ts";
import * as Ts from "../../../src/internal/Ts.ts";
import type { MigrateError } from "../../../src/MigrateError.ts";
/**
 * One construct hit.
 *
 * `detail` carries source text, never a summary. `Mapping.snippet` builds a
 * rewrite out of it and emits nothing when a piece is missing, so a hit whose
 * detail is thin becomes a guided decision instead of an invented one.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface InventoryEntry {
    readonly file: string;
    readonly line: number;
    readonly column: number;
    /**
     * The catalog name, for example `Task`, `ctx.outputMaybe`, `createSmithers`.
     * A factory member is recorded under its catalog shape, `outputs.<key>`, with
     * the project's own key in `detail`.
     */
    readonly construct: string;
    /** Prop or argument names present at this hit, sorted. */
    readonly props: ReadonlyArray<string>;
    /**
     * Source text worth carrying into a mapping decision.
     *
     * Every JSX attribute that is present appears under its own prop name. The
     * scanner adds these captured keys where it can resolve them:
     *
     * - `children`: the element's children, verbatim.
     * - `childConstructs`: the catalog components inside the element's children,
     *   as `Construct:id` pairs, so a group's rewrite can name its own steps.
     * - `<prop>Constructs`: the catalog components inside one prop's value, for
     *   the props that take an element (`<Branch then={<Task id=\"ship\" />} />`).
     * - `payloadChain`: the zod chain the factory's `input` schema holds, which
     *   is a workflow's payload.
     * - `outputChain`: the zod chain the `output` prop resolves to.
     * - `agentModel`, `agentProvider`, `agentInstructions`: the model literal,
     *   the provider callee, and the instructions of the agent the `agent` prop
     *   resolves to.
     * - `promptText`: the text of the `.mdx` prompt the children render.
     * - `payloadFields`: the zod chain behind each value the step reads, as JSON,
     *   resolved through `deps` and the factory's `input` schema.
     * - `childPayloads`: for a group, the payload each named child step reads, as
     *   JSON of id to key to the source expression behind it (`ctx.input.topic`,
     *   `deps.research.summary`), or `null` for a child whose payload the scanner
     *   could not resolve. A group's rewrite threads values between its steps,
     *   and it may only do that from the expressions the source itself wrote.
     * - `childOutputs`: for a group, the zod chain each named child step declares
     *   as its `output`, as JSON of id to chain, or `null` where the scanner
     *   could not resolve it. The last one is the flow's success schema.
     * - `childAgents`: the ids of the named child steps that carry an `agent` or
     *   `fallbackAgent` prop, comma-joined. A flow with one of them can fail with
     *   `AgentAction.AgentFailure`; a flow without one cannot.
     * - `description`: for a `<Workflow>`, the `// smithers-description:` or
     *   `// smithers-display-name:` header the workflow file carries. It is the
     *   only prose 0.x records about a workflow, and the registry needs one.
     * - `key`, `member`: the factory member this hit reads.
     */
    readonly detail?: Readonly<Record<string, string>> | undefined;
}
/**
 * The names `createSmithers` destructures into. Anything else in the pattern is
 * project code and is left alone.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const factoryBindings: ReadonlyArray<string>;
/**
 * The names of local functions that hand back a `createSmithers` result.
 *
 * The old examples wrap the factory (`createExampleSmithers` in
 * `examples/_example-kit.js`), so a scanner that only knows the literal name
 * misses every component in every example. Collecting the wrappers first, from
 * the same file set, resolves them without evaluating anything.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export declare const factoryNames: (sources: ReadonlyMap<string, string>, parse?: typeof Ts.parse) => ReadonlySet<string>;
/**
 * Scans one file and returns its construct hits.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export declare const scanFile: (file: string, text: string, options: {
    readonly factories: ReadonlySet<string>;
    readonly parse?: typeof Ts.parse | undefined;
    /** The text of an `.mdx` prompt, by its import specifier. */
    readonly prompt?: ((specifier: string) => string | undefined) | undefined;
    /** The factory bindings one import specifier re-exports, by local name. */
    readonly reexports?: ((specifier: string) => ReadonlyMap<string, string> | undefined) | undefined;
    /**
     * The `smithers-*` header comments this file carries, by header name
     * without the prefix, as {@link module:Detect.WorkflowFile} records them.
     */
    readonly headers?: ReadonlyMap<string, string> | undefined;
}) => ReadonlyArray<InventoryEntry>;
/**
 * The zod schema chains declared in one file, by the name they are bound to.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export declare const zodChains: (file: string, text: string, parse?: typeof Ts.parse) => ReadonlyArray<{
    readonly name: string;
    readonly chain: string;
}>;
/**
 * The `.mdx` prompts one file imports, by the local component name.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export declare const mdxImports: (file: string, text: string, parse?: typeof Ts.parse) => ReadonlyArray<{
    readonly local: string;
    readonly specifier: string;
}>;
/**
 * The factory bindings each module re-exports, by module path without its
 * extension.
 *
 * A real 0.x pack does not call `createSmithers` in the workflow file. One
 * module calls it and re-exports the bindings (`export const { Workflow, Task,
 * outputs } = createSmithers(...)`), and every workflow imports them from
 * there. A scanner that only reads in-file destructuring records nothing for
 * such a pack.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export declare const factoryReexports: (sources: ReadonlyMap<string, string>, factories: ReadonlySet<string>, parse?: typeof Ts.parse) => ReadonlyMap<string, ReadonlyMap<string, string>>;
/**
 * Scans every file a migration touches and returns the inventory, sorted by
 * file then position so a report is stable.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export declare const scan: (detection: Detect.Detection, parse?: typeof Ts.parse) => Effect.Effect<ReadonlyArray<InventoryEntry>, MigrateError, FileSystem.FileSystem>;
