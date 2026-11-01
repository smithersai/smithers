/**
 * Static filesystem declaration vocabulary shared by planning and execution.
 *
 * Declared paths use `/` as their canonical separator and normalize Unicode
 * to NFC. Workspace-relative paths reject C0 controls (U+0000 through U+001F)
 * and DEL (U+007F), which name nothing a supported filesystem can open. C1
 * controls (U+0080 through U+009F) remain accepted because those bytes are
 * legal in a POSIX file name.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
/**
 * How strictly a declared file set is enforced at the boundary.
 *
 * `hard` rejects undeclared access. `expected` records access for validation
 * after execution without requiring the sandbox to reject it immediately.
 *
 * This is the ONE spelling of the pair. `Plan.NodeEffects.boundaryMode` is this
 * schema and so is `@smthrs/flow`'s `Action.BoundaryMode`; the literal used to
 * be written out in all three places.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const BoundaryMode: Schema.Literals<readonly ["hard", "expected"]>;
/**
 * The value form of {@link BoundaryMode}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type BoundaryMode = typeof BoundaryMode.Type;
/**
 * The canonical spelling of a declared path or pattern: every separator is
 * `/`, and Unicode is normalized to NFC.
 *
 * {@link workspaceRelative} accepts a backslash as a separator, so
 * `dist\same.js` and `dist/same.js` are two spellings of ONE workspace path.
 * Every exact-path comparison in this module goes through this form, because
 * comparing the raw spellings would let the separator alias defeat overlap
 * detection exactly as `.` segments and empty segments would.
 *
 * @category accessors
 * @since 0.1.0
 */
export declare const canonical: (path: string) => string;
/**
 * The {@link canonical} spelling with letter case folded away.
 *
 * A case-insensitive filesystem (default macOS APFS, Windows NTFS) opens
 * `src/A.ts` and `src/a.ts` as one file, so static overlap compares this form:
 * two declarations that differ only in case must serialize. Folding goes
 * through upper case because that mapping is context-free, so it folds each
 * character alone and commutes with splitting a path into segments.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export declare const folded: (path: string) => string;
/**
 * A non-empty workspace-relative path or pattern.
 *
 * Decoding fails with a `SchemaError` when {@link workspaceRelative} refuses
 * the string. A bare `Pattern` in a declaration names one literal path; only a
 * {@link Glob} gives `*` and `**` wildcard meaning.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Pattern: Schema.NonEmptyString;
/**
 * Whether a declared path or pattern stays inside the workspace and names it
 * one way only. Refuses absolute paths (POSIX and drive-letter), upward
 * traversal, and the aliasing forms — `.` segments, empty segments — that
 * would let two spellings of one file defeat exact-string overlap detection.
 *
 * C0 controls and DEL are refused as well.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const workspaceRelative: (pattern: string) => boolean;
/**
 * A Bazel-style file glob: the paths matching any `include` pattern and no
 * `exclude` pattern.
 *
 * In a pattern, `*` matches within one path segment and a `**` segment
 * matches zero or more whole segments. A trailing `**` needs its separator,
 * so `src/**` does not match `src` itself.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Glob: Schema.TaggedStruct<"Glob", {
    readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
    readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
}>;
/**
 * The value form of {@link Glob}.
 *
 * @category models
 * @since 0.1.0
 */
export type Glob = typeof Glob.Type;
/**
 * A directory output captured and replayed as one tree artifact.
 *
 * It covers `path` and every path beneath it, compared in {@link folded}
 * form.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const TreeArtifact: Schema.TaggedStruct<"TreeArtifact", {
    readonly path: Schema.NonEmptyString;
}>;
/**
 * The value form of {@link TreeArtifact}.
 *
 * @category models
 * @since 0.1.0
 */
export type TreeArtifact = typeof TreeArtifact.Type;
/**
 * One leaf declaration: a literal path, a {@link Glob}, or a
 * {@link TreeArtifact}. Write sets and filegroups hold entries.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Entry: Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
    readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
    readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
}>, Schema.TaggedStruct<"TreeArtifact", {
    readonly path: Schema.NonEmptyString;
}>]>;
/**
 * The value form of {@link Entry}.
 *
 * @category models
 * @since 0.1.0
 */
export type Entry = typeof Entry.Type;
/**
 * One leaf declaration valid in a read set: a literal path or a {@link Glob}.
 * A read set cannot name a {@link TreeArtifact}, which is an output form.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const ReadEntry: Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
    readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
    readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
}>]>;
/**
 * The value form of {@link ReadEntry}.
 *
 * @category models
 * @since 0.1.0
 */
export type ReadEntry = typeof ReadEntry.Type;
/**
 * A named, reusable list of {@link Entry} declarations.
 *
 * {@link expand} replaces a filegroup with its entries in place before any
 * overlap check or measurement, so the name never reaches the boundary.
 * Filegroups do not nest.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Filegroup: Schema.TaggedStruct<"Filegroup", {
    readonly name: Schema.NonEmptyString;
    readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
        readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
        readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
    }>, Schema.TaggedStruct<"TreeArtifact", {
        readonly path: Schema.NonEmptyString;
    }>]>>;
}>;
/**
 * The value form of {@link Filegroup}.
 *
 * @category models
 * @since 0.1.0
 */
export type Filegroup = typeof Filegroup.Type;
/**
 * A {@link Filegroup} restricted to {@link ReadEntry} declarations, for use
 * in a read set. It shares the `"Filegroup"` tag.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const ReadFilegroup: Schema.TaggedStruct<"Filegroup", {
    readonly name: Schema.NonEmptyString;
    readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
        readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
        readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
    }>]>>;
}>;
/**
 * The value form of {@link ReadFilegroup}.
 *
 * @category models
 * @since 0.1.0
 */
export type ReadFilegroup = typeof ReadFilegroup.Type;
/**
 * Any declaration accepted in a write set: an {@link Entry} or a
 * {@link Filegroup}.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Declaration: Schema.Union<readonly [Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
    readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
    readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
}>, Schema.TaggedStruct<"TreeArtifact", {
    readonly path: Schema.NonEmptyString;
}>]>, Schema.TaggedStruct<"Filegroup", {
    readonly name: Schema.NonEmptyString;
    readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
        readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
        readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
    }>, Schema.TaggedStruct<"TreeArtifact", {
        readonly path: Schema.NonEmptyString;
    }>]>>;
}>]>;
/**
 * The value form of {@link Declaration}.
 *
 * @category models
 * @since 0.1.0
 */
export type Declaration = typeof Declaration.Type;
/**
 * Any declaration accepted in a read set: a {@link ReadEntry} or a
 * {@link ReadFilegroup}.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const ReadDeclaration: Schema.Union<readonly [Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
    readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
    readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
}>]>, Schema.TaggedStruct<"Filegroup", {
    readonly name: Schema.NonEmptyString;
    readonly entries: Schema.$Array<Schema.Union<readonly [Schema.NonEmptyString, Schema.TaggedStruct<"Glob", {
        readonly include: Schema.NonEmptyArray<Schema.NonEmptyString>;
        readonly exclude: Schema.optional<Schema.$Array<Schema.NonEmptyString>>;
    }>]>>;
}>]>;
/**
 * The value form of {@link ReadDeclaration}.
 *
 * @category models
 * @since 0.1.0
 */
export type ReadDeclaration = typeof ReadDeclaration.Type;
/**
 * Creates a {@link Filegroup}. It does not validate `name` or `entries`;
 * decode through {@link Filegroup} when the input is untrusted.
 *
 * @param name - The filegroup name.
 * @param entries - The entries the filegroup expands to, in order.
 * @returns The filegroup value.
 * @category constructors
 * @since 0.1.0
 */
export declare const makeFilegroup: (name: string, entries: ReadonlyArray<Entry>) => Filegroup;
/**
 * Replaces each {@link Filegroup} with its entries, in place, and keeps every
 * other declaration as it is. Order is preserved and duplicates are kept.
 *
 * @param declarations - Write-set declarations, possibly holding filegroups.
 * @returns The flat list of entries.
 * @category accessors
 * @since 0.1.0
 */
export declare const expand: (declarations: ReadonlyArray<Declaration>) => ReadonlyArray<Entry>;
/**
 * {@link expand} for read sets: replaces each {@link ReadFilegroup} with its
 * entries, in place, preserving order and duplicates.
 *
 * @param declarations - Read-set declarations, possibly holding filegroups.
 * @returns The flat list of read entries.
 * @category accessors
 * @since 0.1.0
 */
export declare const expandReads: (declarations: ReadonlyArray<ReadDeclaration>) => ReadonlyArray<ReadEntry>;
/**
 * Whether a value carries the `"Glob"` tag. It checks only the tag, not the
 * patterns.
 *
 * @param value - Any value.
 * @returns `true` for an object whose `_tag` is `"Glob"`.
 * @category guards
 * @since 0.1.0
 */
export declare const isGlob: (value: unknown) => value is Glob;
/**
 * Whether a value carries the `"TreeArtifact"` tag. It checks only the tag,
 * not the path.
 *
 * @param value - Any value.
 * @returns `true` for an object whose `_tag` is `"TreeArtifact"`.
 * @category guards
 * @since 0.1.0
 */
export declare const isTreeArtifact: (value: unknown) => value is TreeArtifact;
/**
 * Whether `path` matches `pattern` under {@link Glob} wildcard rules.
 *
 * The pattern is read in its {@link canonical} spelling; the path is matched
 * as given, case-sensitively, with `/` as its only separator.
 *
 * @param pattern - A Bazel-style pattern such as `src/*.ts` or `docs/**`.
 * @param path - A workspace-relative path.
 * @returns `true` when the path matches.
 * @category predicates
 * @since 0.1.0
 */
export declare const matchesPattern: (pattern: string, path: string) => boolean;
/**
 * Whether `path` matches some `include` pattern of `glob` and no `exclude`
 * pattern, each tested with {@link matchesPattern}. Case-sensitive.
 *
 * @param glob - The glob to test.
 * @param path - A workspace-relative path.
 * @returns `true` when the glob selects the path.
 * @category predicates
 * @since 0.1.0
 */
export declare const matchesGlob: (glob: Glob, path: string) => boolean;
/**
 * Whether a canonical path is inside a declaration, case-sensitively.
 * Unlike {@link overlaps}, this predicate establishes replay authority.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export declare const contains: (entry: Entry, path: string) => boolean;
/**
 * Conservative static overlap. `true` may over-serialize; `false` proves that
 * no path can belong to both declarations.
 *
 * A plain string is a literal path, even when it contains `*` or `**`, as it
 * is at execution (sandbox admission, capture, removal, and replay); wildcard
 * matching belongs to a Glob.
 *
 * Exact paths and tree roots compare in their
 * {@link folded} form, so separator aliases, canonically equivalent Unicode
 * spellings, and spellings that differ only in letter case overlap. A Glob
 * against an exact path folds its includes and ignores exclusions: an excluded
 * spelling may alias an included spelling on another filesystem. {@link matchesGlob} itself stays case-sensitive and tests the path bytes it
 * is handed; its property suite pins a backslash inside a path segment as
 * literal text, so canonicalizing a measured path before matching is its
 * caller's decision, not this module's.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const overlaps: (left: Entry, right: Entry) => boolean;
