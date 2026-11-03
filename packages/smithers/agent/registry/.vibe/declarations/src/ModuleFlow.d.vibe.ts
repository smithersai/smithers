/**
 * Module flows: a `flow.ts` whose default export is `Flow.make("<tag>", { ... })`,
 * read from its source text without importing it.
 *
 * Discovery reads every module entry through {@link fromModule}, and a host
 * that holds a flow's source somewhere other than a file system (a database
 * row, an editor buffer) reads it the same way. Nothing here evaluates the
 * module: the description, schemas, calls, capabilities, effects, placement
 * and tag come from the literal declaration, and the body is recorded by the
 * digest of its bytes.
 *
 * @since 1.0.0-rc.16
 */
import * as Option from "effect/Option";
import { DiscoveryWarning, FlowDescriptor, type ModuleImport, type Provenance } from "./Descriptor.vibe";
/**
 * Parameters used to derive a descriptor from already-read module text.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface FromModuleOptions {
    /** The module's source, or a prefix of it that holds the whole default declaration. */
    readonly text: string;
    /** SHA-256 of the complete source when the supplied text is a prefix; else the text's own digest. */
    readonly contentDigest?: string | undefined;
    readonly path: string;
    readonly naming: "path" | "frontmatter";
    /** The path-derived name, which a path-named source answers to. */
    readonly name: Option.Option<string>;
    /** The entry's directory name, which a frontmatter-named source answers to. */
    readonly dirBasename: string;
    readonly provenance: Provenance;
    /** What the module loads beside itself, recorded on its body when any. */
    readonly imports?: ReadonlyArray<ModuleImport> | undefined;
    readonly hostImports?: ReadonlyArray<string> | undefined;
}
/**
 * The metadata result of module flow discovery: the descriptor, the tag the
 * declaration names, and what the reader warned about.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface FromModuleResult {
    readonly descriptor: Option.Option<FlowDescriptor>;
    /**
     * The string literal `Flow.make` takes as its tag. `None` for a record
     * declaration, or a tag the reader cannot evaluate without running the module.
     */
    readonly tag: Option.Option<string>;
    readonly warnings: ReadonlyArray<DiscoveryWarning>;
}
/**
 * Derives a module flow descriptor from its source text without importing it.
 * A declaration without a literal description has no descriptor.
 *
 * @category constructors
 * @since 1.0.0-rc.16
 */
export declare const fromModule: (options: FromModuleOptions) => FromModuleResult;
