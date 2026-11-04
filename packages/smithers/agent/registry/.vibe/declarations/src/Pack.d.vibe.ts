/**
 * Workflow packs: a directory of flows with a manifest, a content address, and
 * a merge order.
 *
 * `Discovery` already answers "what flows are in this directory". A pack adds
 * the three things a shareable directory needs and a bare directory cannot
 * carry: a *name and version* so a descriptor can say where it came from, a
 * *content address* so a lock file can pin exactly the bytes that were
 * installed, and a *compatibility range* so a pack written against a newer
 * runtime is refused at load rather than halfway through a run.
 *
 * The old smithers verbs (`pack add | remove | list | update | eject`) are the
 * CLI half and are not here. This module is the runtime contract underneath
 * them. It holds one filesystem policy: every contributed source must remain
 * inside its pack root. Discovery requires a resolved confinement root before
 * reading descended directories or selected entry files.
 * Packs are third-party content, so callers cannot be trusted to have
 * validated manifest paths or symlink targets first.
 *
 * Precedence is `local` before `installed`, by name. That is the one rule the
 * old pack system had that a plain source list cannot express: two sources
 * merge first-found in scan order, so an installed pack listed first would win
 * a name a project pack defines. Here the origin decides, and the loser is
 * reported as a {@link module:Descriptor.DiscoveryWarning} naming both packs
 * rather than dropped silently.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DiscoveryWarning, FlowDescriptor, type Source } from "./Descriptor.vibe";
import type { RegistryError } from "./RegistryError.vibe";
/**
 * Where a pack was installed from, and therefore which one wins a name.
 *
 * `local` is a pack the project owns: checked in, or linked into the working
 * tree. `installed` is one a package manager or `pack add` put there. A local
 * flow shadows an installed flow of the same name, never the other way round.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Origin: Schema.Literals<readonly ["local", "installed"]>;
/**
 * Where a pack was installed from.
 *
 * @category models
 * @since 0.1.0
 */
export type Origin = typeof Origin.Type;
/**
 * The runtime range a pack declares it needs.
 *
 * Only `smithers` is named. A pack is a set of flow declarations, and the one
 * thing that can make them unloadable is the runtime that reads them.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Requires: Schema.Struct<{
    readonly smithers: Schema.String;
}>;
/**
 * The runtime range a pack declares it needs.
 *
 * @category models
 * @since 0.1.0
 */
export type Requires = typeof Requires.Type;
declare const Manifest_base: Schema.Class<Manifest, Schema.Struct<{
    readonly name: Schema.NonEmptyString;
    readonly version: Schema.NonEmptyString;
    readonly flows: Schema.$Array<Schema.NonEmptyString>;
    readonly skills: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
    readonly requires: Schema.optional<Schema.Struct<{
        readonly smithers: Schema.String;
    }>>;
}>, {}>;
/**
 * A pack manifest, as it is written in `pack.json`.
 *
 * `flows` and `skills` are directory paths relative to the pack root, each
 * scanned exactly the way an ordinary registry source is. They are paths and
 * not flow names on purpose: a manifest that listed names would have to be
 * re-edited every time a flow was added, and the digest would then not change
 * when one was.
 *
 * @category models
 * @since 0.1.0
 */
export declare class Manifest extends Manifest_base {
}
/**
 * One pack the host has decided to load, and where it came from.
 *
 * @category models
 * @since 0.1.0
 */
export interface Installed {
    readonly manifest: Manifest;
    /** The pack root. Every manifest path is resolved against it. */
    readonly dir: string;
    readonly origin: Origin;
    /**
     * The manifest diagnostics {@link read} produced, carried so a registry
     * built from this pack reports them from `registry.warnings()`. A host that
     * constructs an `Installed` by hand has none, so it is optional: spreading
     * `read`'s result and adding `origin` is what carries them across.
     */
    readonly warnings?: ReadonlyArray<DiscoveryWarning> | undefined;
}
/**
 * One file's contribution to a pack's content address.
 *
 * @category models
 * @since 0.1.0
 */
export interface File {
    /** The path relative to the pack root, in the manifest's own vocabulary. */
    readonly path: string;
    readonly contents: string;
}
/**
 * Reads and decodes one pack's manifest.
 *
 * A pack whose manifest is missing, unparseable, or incomplete fails
 * `RegistryError { code: "invalid_pack" }` here rather than producing a
 * half-loaded registry: the manifest is what names the pack in every
 * descriptor's provenance, so there is nothing useful to do without it.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const read: (fs: FileSystem.FileSystem, path: Path.Path, dir: string) => Effect.Effect<{
    readonly manifest: Manifest;
    readonly dir: string;
    readonly warnings: ReadonlyArray<DiscoveryWarning>;
}, RegistryError>;
/**
 * The content address of one pack, as a lock file records it.
 *
 * The digest covers the manifest and every file measured by the CLI pack
 * verbs, each by its own content hash under a validated pack-relative path.
 * File contents are UTF-8 text; measuring binary resources is outside this
 * contract. Unsafe paths throw a `TypeError`. Duplicate paths are retained and
 * ordered by their content digest, so no input ordering can change the result.
 * Two installs of the same bytes therefore produce the same digest whatever
 * order the files were read in, and editing one flow body changes it.
 *
 * @category identity
 * @since 0.1.0
 */
export declare const digest: (manifest: Manifest, files: ReadonlyArray<File>) => string;
/**
 * Whether a runtime version satisfies a pack's declared range.
 *
 * The supported grammar is `*`, inclusive hyphen ranges, and whitespace-
 * separated conjunctions of bare, `=`, `>=`, `>`, `<=`, `<`, `^`, and `~`
 * comparators. Whitespace may separate an operator from its version. Versions
 * have one to three numeric components. As in npm, a partial version is a
 * range over its omitted components: `1.2` and `=1.2` accept any `1.2.x`, `~1`
 * and `^1` accept any `1.x`, `>1.2` starts at `1.3.0`, `<=1.2` ends before
 * it, and `>=1.2` and `<1.2` read `1.2.0`.
 * `x`, `*` components, and `||` unions are unreadable; only a standalone `*`
 * is accepted. An unreadable range returns false rather than being guessed.
 *
 * @category refinements
 * @since 0.1.0
 */
export declare const compatible: (range: string, runtimeVersion: string) => boolean;
/**
 * The registry sources one pack contributes, in manifest order.
 *
 * Every path in `flows` and `skills` becomes a confined source rooted inside
 * the pack, so a pack is discovered by exactly the pipeline a project
 * directory is. Lexical containment is always enforced. The pack root's real
 * path must resolve; a source must resolve inside it or not exist yet. Any
 * other `realPath` failure is refused.
 * `confinementRoot` carries the pack root into discovery so descended
 * directories and selected entry files receive the same real-path check.
 * This defense is repeated because callers may construct `Installed`
 * values without decoding a manifest. `source` carries the pack name, which
 * is what a `DiscoveryWarning` about a pack file reads back.
 *
 * @category conversions
 * @since 0.1.0
 */
export declare const sources: (pack: Installed, path: Path.Path) => Effect.Effect<ReadonlyArray<Source>, RegistryError, FileSystem.FileSystem>;
/**
 * Stamps a descriptor with the pack it was discovered in.
 *
 * @category conversions
 * @since 0.1.0
 */
export declare const attribute: (descriptor: FlowDescriptor, pack: Installed) => FlowDescriptor;
/**
 * One pack's scan, ready to merge.
 *
 * @category models
 * @since 0.1.0
 */
export interface Scan {
    readonly pack: Installed;
    readonly entries: ReadonlyArray<FlowDescriptor>;
    readonly warnings: ReadonlyArray<DiscoveryWarning>;
}
/**
 * Merges scanned packs into one descriptor set, local packs first.
 *
 * A name defined by more than one pack keeps the highest-precedence
 * definition and reports a `shadowed` warning naming both packs, so an
 * operator can see which pack lost and why rather than discovering it from a
 * flow that behaves unexpectedly. A name one pack defines twice, for example
 * under both `flows` and `skills`, keeps that pack's first definition and
 * reports `duplicate_name` instead.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const merge: (scans: ReadonlyArray<Scan>) => {
    readonly entries: ReadonlyArray<FlowDescriptor>;
    readonly warnings: ReadonlyArray<DiscoveryWarning>;
};
/**
 * Refuses a pack whose declared runtime range this runtime does not satisfy.
 * The grammar is the one documented by {@link compatible}. An unreadable
 * declaration fails `unreadable_pack_range`; a readable but unsatisfied one
 * fails `incompatible_pack`. The manifest path a failure names is spelled by
 * the caller's `Path` service, which is the one {@link read} and
 * {@link sources} already use.
 *
 * @category refinements
 * @since 0.1.0
 */
export declare const checkCompatible: (pack: Installed, path: Path.Path, runtimeVersion: string) => Effect.Effect<void, RegistryError>;
export {};
