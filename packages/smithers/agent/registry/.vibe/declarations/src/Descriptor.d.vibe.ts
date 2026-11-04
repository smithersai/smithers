/**
 * Serializable flow-registry descriptors.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 * `EffectDeclaration` is the fully explicit discovery projection of
 * `packages/smithers/flows/core/src/Effects.ts`; placement literals are lowered by
 * `packages/smithers/flows/core/src/Markdown.ts` into `packages/smithers/flows/core/src/Placement.ts`
 * values. The adapter is implemented by `MarkdownFlow.toCoreFrontmatter`.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
/**
 * The reversibility tier declared by a flow.
 *
 * @category models
 * @since 0.1.0
 */
export declare const EffectTier: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
/**
 * The reversibility tier declared by a flow.
 *
 * @category models
 * @since 0.1.0
 */
export type EffectTier = typeof EffectTier.Type;
/**
 * The execution environment selected by a leading placement directive.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Placement: Schema.Literals<readonly ["client", "local", "sandbox", "remote"]>;
/**
 * The execution environment selected by a leading placement directive.
 *
 * @category models
 * @since 0.1.0
 */
export type Placement = typeof Placement.Type;
/**
 * The sandbox providers a flow may name, one per `@smthrs/sandbox` provider
 * module. A name outside this set refuses the flow at discovery, so a typo can
 * never quietly run a flow outside the sandbox its author asked for.
 *
 * @category models
 * @since 1.0.0
 */
export declare const SandboxProvider: Schema.Literals<readonly ["aws", "cloudflare", "command", "container", "daytona", "directory", "just-bash", "kubernetes", "microsandbox", "vercel"]>;
/**
 * The sandbox providers a flow may name.
 *
 * @category models
 * @since 1.0.0
 */
export type SandboxProvider = typeof SandboxProvider.Type;
/**
 * The sandbox a flow selects: the provider, plus the neutral network policy
 * and resource limits every `@smthrs/sandbox` provider accepts
 * (`Sandbox.NetworkPolicy`, `Sandbox.ResourceLimits`). `cpus` may be
 * fractional; `memoryMib` and `timeoutSecs` are positive safe integers.
 *
 * It is `@smthrs/core`'s `Markdown.SandboxSelection`, so the descriptor and
 * the lowered Markdown flow read one schema.
 *
 * @category models
 * @since 1.0.0
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
 * @since 1.0.0
 */
export type SandboxSelection = typeof SandboxSelection.Type;
/**
 * The canonical effect declaration shared with `/core`.
 *
 * @category models
 * @since 0.1.0
 */
export declare const EffectDeclaration: Schema.Struct<{
    readonly reads: Schema.$Array<Schema.String>;
    readonly writes: Schema.$Array<Schema.String>;
    readonly mode: Schema.Literals<readonly ["hermetic", "expected"]>;
    readonly onConflict: Schema.Literals<readonly ["serialize", "lane", "fail"]>;
    readonly tier: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
}>;
/**
 * The canonical effect declaration shared with `/core`.
 *
 * @category models
 * @since 0.1.0
 */
export type EffectDeclaration = typeof EffectDeclaration.Type;
declare const SchemaRefMarkdownArgs_base: Schema.Class<SchemaRefMarkdownArgs, Schema.TaggedStruct<"MarkdownArgs", {}>, {}>;
/**
 * The fixed `{ args: string }` input marker used by markdown flows.
 *
 * @category models
 * @since 0.1.0
 */
export declare class SchemaRefMarkdownArgs extends SchemaRefMarkdownArgs_base {
}
declare const SchemaRefMarkdownOutput_base: Schema.Class<SchemaRefMarkdownOutput, Schema.TaggedStruct<"MarkdownOutput", {}>, {}>;
/**
 * The fixed string output marker used by markdown flows.
 *
 * @category models
 * @since 0.1.0
 */
export declare class SchemaRefMarkdownOutput extends SchemaRefMarkdownOutput_base {
}
declare const SchemaRefModule_base: Schema.Class<SchemaRefModule, Schema.TaggedStruct<"Module", {
    readonly path: Schema.String;
    readonly field: Schema.Literals<readonly ["input", "output"]>;
    readonly document: Schema.optionalKey<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, {}>;
/**
 * A schema field on a module's default `Flow.make` value. Discovery records
 * the field location without evaluating the module.
 * A proven literal payload may also carry display metadata; execution still
 * loads and decodes the schema at this location.
 *
 * @category models
 * @since 0.1.0
 */
export declare class SchemaRefModule extends SchemaRefModule_base {
}
declare const SchemaRefNone_base: Schema.Class<SchemaRefNone, Schema.TaggedStruct<"None", {}>, {}>;
/**
 * A flow with no declared input or output schema.
 *
 * @category models
 * @since 0.1.0
 */
export declare class SchemaRefNone extends SchemaRefNone_base {
}
declare const SchemaRefInline_base: Schema.Class<SchemaRefInline, Schema.TaggedStruct<"Inline", {
    readonly document: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, {}>;
/**
 * A schema carried by value, as a JSON Schema document.
 *
 * The other three variants are *locators*: they say where a schema lives so
 * discovery can record it without evaluating the module that defines it. A
 * host that binds a declaration it already holds — `@smthrs/harness`'s
 * `FlowBinding` — has the schema itself and nothing to locate, and a locator
 * pointing at a synthetic `binding://` path is unreadable by anything
 * downstream. That is what left `ctx.flows` describing every standard flow by
 * name, tier, and prose alone: a cell had to guess `command` versus `cmd`,
 * then discover `reads` and `writes` one rejected frame at a time.
 *
 * The document is `Schema.toJsonSchemaDocument` output, kept as plain JSON so
 * a descriptor stays serializable and comparable.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare class SchemaRefInline extends SchemaRefInline_base {
}
/**
 * Input metadata available without evaluating a repository module.
 * @category accessors
 * @since 1.0.0
 */
export declare const inputDocument: (ref: SchemaRef | undefined) => Schema.Json | undefined;
/**
 * A serializable locator for a flow input or output schema.
 *
 * @category models
 * @since 0.1.0
 */
export declare const SchemaRef: Schema.Union<readonly [typeof SchemaRefMarkdownArgs, typeof SchemaRefMarkdownOutput, typeof SchemaRefModule, typeof SchemaRefNone, typeof SchemaRefInline]>;
/**
 * A serializable locator for a flow input or output schema.
 *
 * @category models
 * @since 0.1.0
 */
export type SchemaRef = typeof SchemaRef.Type;
declare const BodyRefMarkdown_base: Schema.Class<BodyRefMarkdown, Schema.TaggedStruct<"Markdown", {
    readonly path: Schema.String;
    readonly baseDirectory: Schema.String;
    /**
     * SHA-256 of the complete source bytes measured during discovery.
     *
     * Optional only so descriptors journaled before rc.0 still decode. Every
     * current discovery and executable-binding constructor supplies it.
     * Registry.loadBody and Executable.fromDescriptor refuse it when absent.
     */
    readonly contentDigest: Schema.optional<Schema.String>;
}>, {}>;
/**
 * A markdown body stored at a source path.
 *
 * @category models
 * @since 0.1.0
 */
export declare class BodyRefMarkdown extends BodyRefMarkdown_base {
}
declare const ModuleImport_base: Schema.Class<ModuleImport, Schema.Struct<{
    readonly path: Schema.String;
    readonly contentDigest: Schema.optional<Schema.String>;
}>, {}>;
/**
 * One module a flow's entry file loads from beside itself.
 *
 * `path` is the module's location relative to the entry file's directory, with
 * `/` separators, which is what the loader resolves a relative specifier
 * against and is therefore stable wherever the project is checked out.
 *
 * `contentDigest` is absent for a specifier discovery could not pin, and `path`
 * then carries the reason instead of a location: a specifier that resolves to
 * no file, a module that could not be read, a load whose target is computed
 * or made through a renamed loader, a mapping the walk does not follow, or a
 * closure past its bound. Such an entry is not a location and
 * must not be treated as one; it exists so the refusal can say what stopped it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare class ModuleImport extends ModuleImport_base {
}
declare const BodyRefModule_base: Schema.Class<BodyRefModule, Schema.TaggedStruct<"Module", {
    readonly path: Schema.String;
    /** The module declares a typed prompt rather than a graph body. */
    readonly prompt: Schema.optional<Schema.Literal<true>>;
    /**
     * SHA-256 of the complete module source bytes measured during discovery.
     * Optional for older journaled descriptors to decode; Registry.loadBody and
     * Executable.fromDescriptor refuse an absent digest with body_unavailable.
     *
     * It measures the ENTRY FILE. What the entry loads from beside itself is
     * {@link BodyRefModule.imports}.
     */
    readonly contentDigest: Schema.optional<Schema.String>;
    /**
     * Every module the entry reaches through relative specifiers, and through
     * bare specifiers a loader maps onto project files (package.json `imports`,
     * tsconfig `paths` or `baseUrl`), sorted by path.
     *
     * ABSENT means the entry loads nothing from beside itself, which is why it is
     * optional rather than an empty array: a module with no relative imports
     * hashes exactly as it did before this field existed, so its approvals and
     * its recorded step keys do not move.
     *
     * It rides {@link executionDigest} through the ordinary schema encoding, so a
     * changed sibling is a changed executable identity and cannot reuse an
     * approval granted for the old one.
     */
    readonly imports: Schema.optional<Schema.$Array<typeof ModuleImport>>;
    /**
     * Builtins, native addon paths and external package specifiers in the static
     * project closure.
     * They run with host authority beyond guarded capabilities. Packages are
     * listed conservatively; this is no native dependency audit or confinement.
     * Included in executionDigest, absent for modules with no host imports.
     */
    readonly hostImports: Schema.optional<Schema.$Array<Schema.String>>;
}>, {}>;
/**
 * A module body stored at a source path.
 *
 * @category models
 * @since 0.1.0
 */
export declare class BodyRefModule extends BodyRefModule_base {
}
/**
 * A serializable locator and content address for a flow body, which is loaded
 * only on demand.
 *
 * @category models
 * @since 0.1.0
 */
export declare const BodyRef: Schema.Union<readonly [typeof BodyRefMarkdown, typeof BodyRefModule]>;
/**
 * A serializable locator and content address for a flow body, which is loaded
 * only on demand.
 *
 * @category models
 * @since 0.1.0
 */
export type BodyRef = typeof BodyRef.Type;
declare const FlowBodyPrompt_base: Schema.Class<FlowBodyPrompt, Schema.TaggedStruct<"Prompt", {
    readonly text: Schema.String;
    readonly baseDirectory: Schema.String;
}>, {}>;
/**
 * A loaded markdown prompt body.
 *
 * @category models
 * @since 0.1.0
 */
export declare class FlowBodyPrompt extends FlowBodyPrompt_base {
}
declare const FlowBodyModule_base: Schema.Class<FlowBodyModule, Schema.TaggedStruct<"Module", {
    readonly path: Schema.String;
}>, {}>;
/**
 * A loaded module flow body.
 *
 * @category models
 * @since 0.1.0
 */
export declare class FlowBodyModule extends FlowBodyModule_base {
}
/**
 * The body returned after an entry is loaded on demand.
 *
 * @category models
 * @since 0.1.0
 */
export declare const FlowBody: Schema.Union<readonly [typeof FlowBodyPrompt, typeof FlowBodyModule]>;
/**
 * The body returned after an entry is loaded on demand.
 *
 * @category models
 * @since 0.1.0
 */
export type FlowBody = typeof FlowBody.Type;
/**
 * The pack a descriptor was discovered in, when it came from one.
 *
 * `origin` is what decided a name collision: a `local` pack shadows an
 * `installed` one, so an operator reading a descriptor can tell which half of
 * the merge it survived.
 *
 * @category models
 * @since 0.1.0
 */
export declare const PackRef: Schema.Struct<{
    readonly name: Schema.NonEmptyString;
    readonly version: Schema.NonEmptyString;
    readonly origin: Schema.Literals<readonly ["local", "installed"]>;
}>;
/**
 * The pack a descriptor was discovered in.
 *
 * @category models
 * @since 0.1.0
 */
export type PackRef = typeof PackRef.Type;
declare const Provenance_base: Schema.Class<Provenance, Schema.Struct<{
    readonly source: Schema.String;
    readonly root: Schema.String;
    readonly pack: Schema.optional<Schema.Struct<{
        readonly name: Schema.NonEmptyString;
        readonly version: Schema.NonEmptyString;
        readonly origin: Schema.Literals<readonly ["local", "installed"]>;
    }>>;
}>, {}>;
/**
 * Opaque source information retained with each discovered entry.
 *
 * `pack` is absent for a descriptor discovered from a plain source, which is
 * every source the single-source registry scans. It is present only when a
 * pack manifest named the directory the entry was found in.
 *
 * @category models
 * @since 0.1.0
 */
export declare class Provenance extends Provenance_base {
}
/**
 * Where a project keeps its flows, relative to the project root (mvp.md M-49).
 * Every consumer derives the location from this constant.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const projectFlowsDirectory = ".smithers/flows";
/**
 * Where a project kept its flows before M-49, relative to the project root.
 * Discovery never loads it; see {@link retiredRootMessage}.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const retiredProjectFlowsDirectory = "flows";
/**
 * The one `retired_root` warning a scan reports when its retired root still
 * holds flow entries.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const retiredRootMessage = "Flows in flows/ are not loaded; move them to .smithers/flows/.";
/**
 * Registry source configuration. `source` is opaque caller-supplied metadata.
 *
 * @category models
 * @since 0.1.0
 */
export interface Source {
    readonly source: string;
    readonly root: string;
    readonly naming: "path" | "frontmatter";
    readonly system?: boolean | undefined;
    /** Repository dependency root; discovery binds its lockfiles without importing code. */
    readonly lockfileRoot?: string | undefined;
    /** A missing root produces an empty scan; other root failures still fail. */
    readonly optionalRoot?: boolean | undefined;
    /** Pack root whose real path must resolve and bound discovery. */
    readonly confinementRoot?: string | undefined;
    /**
     * A directory this source's flows moved out of. Entries there never load;
     * if any exist, the scan reports one `retired_root` warning naming it.
     */
    readonly retiredRoot?: string | undefined;
}
/**
 * Stable codes for non-fatal source-discovery diagnostics.
 *
 * @category models
 * @since 0.1.0
 */
export declare const DiscoveryWarningCode: Schema.Literals<readonly ["missing_description", "invalid_description", "missing_name", "invalid_name", "directory_name_mismatch", "name_field_ignored", "unknown_frontmatter_key", "unknown_pack_key", "invalid_allowed_tools", "invalid_capabilities", "invalid_budget", "invalid_deadline", "unprojectable_authority", "invalid_model_invocation", "invalid_model", "invalid_placement", "invalid_sandbox", "invalid_compatibility", "invalid_license", "invalid_metadata", "non_serializable_frontmatter", "invalid_effect_declaration", "invalid_effect_tier", "unsupported_input_schema", "unsupported_module_metadata", "multiple_entry_files", "duplicate_name", "frontmatter_parse_error", "root_level_entry", "shadowed", "symlink_cycle", "outside_root", "max_depth_exceeded", "entry_too_large", "unreadable", "retired_root"]>;
/**
 * Stable codes for non-fatal source-discovery diagnostics.
 *
 * @category models
 * @since 0.1.0
 */
export type DiscoveryWarningCode = typeof DiscoveryWarningCode.Type;
declare const DiscoveryWarning_base: Schema.Class<DiscoveryWarning, Schema.Struct<{
    readonly code: Schema.Literals<readonly ["missing_description", "invalid_description", "missing_name", "invalid_name", "directory_name_mismatch", "name_field_ignored", "unknown_frontmatter_key", "unknown_pack_key", "invalid_allowed_tools", "invalid_capabilities", "invalid_budget", "invalid_deadline", "unprojectable_authority", "invalid_model_invocation", "invalid_model", "invalid_placement", "invalid_sandbox", "invalid_compatibility", "invalid_license", "invalid_metadata", "non_serializable_frontmatter", "invalid_effect_declaration", "invalid_effect_tier", "unsupported_input_schema", "unsupported_module_metadata", "multiple_entry_files", "duplicate_name", "frontmatter_parse_error", "root_level_entry", "shadowed", "symlink_cycle", "outside_root", "max_depth_exceeded", "entry_too_large", "unreadable", "retired_root"]>;
    readonly path: Schema.String;
    readonly name: Schema.optional<Schema.String>;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Defect>;
}>, {}>;
/**
 * A non-fatal source-discovery diagnostic.
 *
 * @category models
 * @since 0.1.0
 */
export declare class DiscoveryWarning extends DiscoveryWarning_base {
}
/**
 * A positive safe-integer control-plane budget ceiling.
 *
 * Tokens are indivisible, and millisecond envelopes use the same finite,
 * lossless representation so both fields survive durable JSON unchanged.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const BudgetCeiling: Schema.Int;
/**
 * A positive safe-integer control-plane budget ceiling.
 *
 * @category models
 * @since 0.1.0
 */
export type BudgetCeiling = typeof BudgetCeiling.Type;
/**
 * A positive, finite control-plane dollar ceiling.
 *
 * Dollars are divisible, so unlike {@link BudgetCeiling} a fraction is a
 * ceiling: `0.5` is fifty cents.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const UsdCeiling: Schema.Finite;
/**
 * A positive, finite control-plane dollar ceiling.
 *
 * @category models
 * @since 1.0.0
 */
export type UsdCeiling = typeof UsdCeiling.Type;
/**
 * What a run does when a model call would exceed one of its ceilings.
 *
 * `fail` fails the call, `warn` journals a warning and makes it,
 * `skip-remaining` refuses it and every later call in the run, and `park`
 * suspends the run until an operator approves a raised ceiling.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export declare const BudgetOnExceeded: Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>;
/**
 * What a run does when a model call would exceed one of its ceilings.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type BudgetOnExceeded = typeof BudgetOnExceeded.Type;
/**
 * The tokens, milliseconds and dollars a flow declares that a control plane
 * should approve for one of its runs, what exceeding them does, and the
 * wall-clock deadline the run settles by.
 *
 * Tokens and milliseconds are positive safe integers; `usd` is a positive,
 * finite dollar amount. Every field is projected into a control-plane
 * `Envelope.budget` without reinterpretation, and `@smthrs/agent` enforces
 * them at the model boundary.
 *
 * `deadline` is milliseconds of wall-clock time counted from the run's first
 * start, a positive safe integer read from the frontmatter's top-level
 * `deadline`. Expiry fails the run with `Flow.DeadlineExceeded` whatever
 * `onExceeded` says; `onExceeded` governs the ceilings only.
 *
 * An absent field is not a zero. It is the absence of that ceiling, which is
 * what {@link budgetUnbounded} spells out for a flow that declares none.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const FlowBudget: Schema.Struct<{
    readonly tokens: Schema.optional<Schema.Int>;
    readonly milliseconds: Schema.optional<Schema.Int>;
    readonly usd: Schema.optional<Schema.Finite>;
    readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
    readonly deadline: Schema.optional<Schema.Int>;
}>;
/**
 * The tokens, milliseconds and dollars a flow declares.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type FlowBudget = typeof FlowBudget.Type;
/**
 * Reads a run deadline as whole milliseconds: a duration such as
 * `30 minutes`, or a count of milliseconds as a number or numeric string.
 * Answers `undefined` for anything that is not a positive safe integer of
 * milliseconds, so a caller decides how to report it.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const deadlineMillis: (value: unknown) => number | undefined;
/**
 * The budget of a flow that declares none: no token ceiling and no latency
 * ceiling.
 *
 * It is a named value rather than a `{}` written at each host for the reason
 * `@smthrs/agent`'s `Budget.layerUnbounded` is a named layer rather than an
 * omitted service: giving up spending enforcement is a decision, and a reader
 * has to be able to see that a host made it. A host that projects this into an
 * envelope has decided the flow may spend what it likes.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const budgetUnbounded: FlowBudget;
/**
 * A flow's declared activity, independent of its effect envelope or a plan's
 * required coverage. Absence means unknown; `other` explicitly claims none
 * of the four named activities.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const FlowActivity: Schema.Literals<readonly ["reads", "writes", "checks", "tests", "other"]>;
/**
 * A flow's declared activity.
 * @category models
 * @since 1.0.0-rc.0
 */
export type FlowActivity = typeof FlowActivity.Type;
/**
 * Serializable call presentation. Verbs describe the recorded settlement;
 * subject and result select known input and output shapes. Result formats
 * read measured fields only, never infer counts or diffs from input. An
 * unsupported result stays available as raw output in the call details.
 *
 * These display hints grant no authority and are excluded from declaration,
 * execution and model-prompt identities.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const CallPresentation: Schema.Struct<{
    readonly verb: Schema.Struct<{
        readonly pending: Schema.String;
        readonly success: Schema.String;
        readonly failure: Schema.String;
    }>;
    readonly subject: Schema.Literals<readonly ["path", "command", "patch", "selection", "pattern", "none"]>;
    readonly result: Schema.Literals<readonly ["text", "read", "write", "edit", "patch", "tests", "command", "matches", "paths", "entries", "none"]>;
}>;
/**
 * Serializable call presentation.
 * @category models
 * @since 1.0.0-rc.0
 */
export type CallPresentation = typeof CallPresentation.Type;
/**
 * One model seat or an ordered, non-empty fallback list.
 * @category schemas
 * @since 1.0.0
 */
export declare const ModelSelection: Schema.Union<readonly [Schema.String, Schema.NonEmptyArray<Schema.String>]>;
/**
 * One primary seat or an ordered primary and fallback list.
 *
 * @category models
 * @since 1.0.0
 */
export type ModelSelection = typeof ModelSelection.Type;
declare const FlowDescriptor_base: Schema.Class<FlowDescriptor, Schema.Struct<{
    readonly name: Schema.String;
    readonly description: Schema.String;
    readonly body: Schema.Union<readonly [typeof BodyRefMarkdown, typeof BodyRefModule]>;
    readonly input: Schema.Union<readonly [typeof SchemaRefMarkdownArgs, typeof SchemaRefMarkdownOutput, typeof SchemaRefModule, typeof SchemaRefNone, typeof SchemaRefInline]>;
    readonly output: Schema.Union<readonly [typeof SchemaRefMarkdownArgs, typeof SchemaRefMarkdownOutput, typeof SchemaRefModule, typeof SchemaRefNone, typeof SchemaRefInline]>;
    readonly model: Schema.Option<Schema.Union<readonly [Schema.String, Schema.NonEmptyArray<Schema.String>]>>;
    readonly flows: Schema.$Array<Schema.String>;
    readonly capabilities: Schema.$Array<Schema.String>;
    readonly effects: Schema.Struct<{
        readonly reads: Schema.$Array<Schema.String>;
        readonly writes: Schema.$Array<Schema.String>;
        readonly mode: Schema.Literals<readonly ["hermetic", "expected"]>;
        readonly onConflict: Schema.Literals<readonly ["serialize", "lane", "fail"]>;
        readonly tier: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
    }>;
    readonly placement: Schema.Option<Schema.Literals<readonly ["client", "local", "sandbox", "remote"]>>;
    readonly sandbox: Schema.optionalKey<Schema.Struct<{
        readonly provider: Schema.Literals<readonly ["aws", "cloudflare", "command", "container", "daytona", "directory", "just-bash", "kubernetes", "microsandbox", "vercel"]>;
        readonly network: Schema.optionalKey<Schema.Union<readonly [Schema.Literals<readonly ["none", "open"]>, Schema.Struct<{
            readonly allow: Schema.$Array<Schema.String>;
        }>]>>;
        readonly cpus: Schema.optionalKey<Schema.Finite>;
        readonly memoryMib: Schema.optionalKey<Schema.Int>;
        readonly timeoutSecs: Schema.optionalKey<Schema.Int>;
    }>>;
    readonly modelInvocable: Schema.Boolean;
    readonly budget: Schema.optional<Schema.Struct<{
        readonly tokens: Schema.optional<Schema.Int>;
        readonly milliseconds: Schema.optional<Schema.Int>;
        readonly usd: Schema.optional<Schema.Finite>;
        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
        readonly deadline: Schema.optional<Schema.Int>;
    }>>;
    readonly activity: Schema.optional<Schema.Literals<readonly ["reads", "writes", "checks", "tests", "other"]>>;
    readonly presentation: Schema.optional<Schema.Struct<{
        readonly verb: Schema.Struct<{
            readonly pending: Schema.String;
            readonly success: Schema.String;
            readonly failure: Schema.String;
        }>;
        readonly subject: Schema.Literals<readonly ["path", "command", "patch", "selection", "pattern", "none"]>;
        readonly result: Schema.Literals<readonly ["text", "read", "write", "edit", "patch", "tests", "command", "matches", "paths", "entries", "none"]>;
    }>>;
    readonly path: Schema.String;
    readonly frontmatter: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly provenance: typeof Provenance;
    /** Snapshot-compatible lockfile identity; root is relative to provenance.root.
     * Optional so historical descriptors retain their original identity. */
    readonly lockfiles: Schema.optional<Schema.Struct<{
        readonly root: Schema.String;
        readonly digest: Schema.String;
    }>>;
}>, {}>;
/**
 * The discovered metadata for one flow, excluding its unloaded body content.
 *
 * `budget` is absent for a flow that declares none, and {@link budgetOf} is how
 * a host reads it, so the absence is answered with {@link budgetUnbounded}
 * rather than with an empty object nobody named.
 *
 * @category models
 * @since 0.1.0
 */
export declare class FlowDescriptor extends FlowDescriptor_base {
}
/**
 * The executable identity a host binds into a reviewed plan.
 *
 * Includes the complete source digest and all executable metadata, so changing
 * the model, parameters, body location, or authority cannot reuse an approval.
 * A descriptor without measured source bytes has no executable identity; it
 * may still be displayed, but a prompt executor must refuse to run it.
 *
 * Locations are measured from the descriptor's own `provenance.root`: every
 * path it records under that root is hashed relative to it, and the root is
 * not hashed. The same bytes discovered under two roots (two checkouts, two
 * lanes, two hosts' state directories) are one identity, so a plan prepared on
 * one host runs its checks on another; a changed byte, a file moved within the
 * root, or any changed metadata is another identity. A path outside the root
 * is hashed as recorded.
 *
 * The answer is memoized on descriptor identity. A host maps this over every
 * descriptor it lists, and one call encodes the descriptor, canonicalizes the
 * result, and hashes it; a registry hands out frozen copies, so identity is
 * what the value cannot change behind. A descriptor a caller mutates after
 * asking for its digest keeps the first answer, which is what mutating a value
 * a registry already copied does everywhere else.
 *
 * @category hashing
 * @since 1.0.0
 */
export declare const executionDigest: (descriptor: FlowDescriptor) => string | undefined;
/**
 * The canonical digest of one flow's complete declaration.
 *
 * This is the single declaration identity for `FlowDescriptor`, owned by the
 * package that owns the type. `@smthrs/chain` keys its catalog entries with it
 * and `@smthrs/harness` folds it into every call identity, so one declaration
 * is one number everywhere and adding a descriptor field is one edit here
 * rather than a field two packages must each remember.
 *
 * Display-only `activity` and `presentation` are excluded, so enriching a
 * descriptor cannot invalidate call replay or a cached prompt. Within
 * `provenance`, `pack` is excluded: it describes where discovery found the
 * declaration, not what the call depends on.
 *
 * `capabilities` is sorted because a set is what it means; every other array is
 * hashed in declaration order, because order is part of what was declared.
 * `Option` and optional fields hash as `null` when absent so an omitted field
 * and a field that is present and null are one value, which is what they are
 * once the descriptor has crossed JSON.
 *
 * `BodyRef.contentDigest` is the source identity discovery or `FlowBinding.make`
 * measured. It makes an in-place body edit material even when the locator is
 * unchanged. Measured `lockfiles` bind both the relative root and digest;
 * descriptors without this optional identity retain their historical digest.
 *
 * Unlike {@link executionDigest} this is always defined: it identifies what was
 * declared, not whether the source bytes were measured, so a descriptor with no
 * `contentDigest` still has a declaration identity to key against.
 *
 * @category hashing
 * @since 1.0.0-rc.0
 */
export declare const declarationDigest: (descriptor: FlowDescriptor) => string;
/**
 * The budget one descriptor declared, or {@link budgetUnbounded}.
 *
 * Every host that builds an envelope goes through this rather than reading the
 * field, so "this flow declared nothing" is stated once and answered the same
 * way everywhere.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export declare const budgetOf: (descriptor: FlowDescriptor) => FlowBudget;
declare const SourceScan_base: Schema.Class<SourceScan, Schema.Struct<{
    readonly entries: Schema.$Array<typeof FlowDescriptor>;
    readonly warnings: Schema.$Array<typeof DiscoveryWarning>;
}>, {}>;
/**
 * The result of scanning one source.
 *
 * @category models
 * @since 0.1.0
 */
export declare class SourceScan extends SourceScan_base {
}
export {};
