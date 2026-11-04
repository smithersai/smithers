/**
 * A differential conformance kit for {@link Search} implementations.
 *
 * `Search` is a public extension seam: a host binds its own implementation and
 * every `grep` and `glob` call in the package goes through it. Two peers ship
 * here, and the contract they are held to used to live only in
 * `test/SearchConformance.test.ts` — a file `package.json` does not publish, so
 * a third-party peer had the seam and no way to prove it filled it. Worse, the
 * cases there are hand-picked: they pin the divergences somebody already
 * found. A literal `?` matched `fo` in one peer and `foo?` in the other for as
 * long as nobody thought to write that case down.
 *
 * This module is the other half. It generates a tree and a batch of calls from
 * a seed, runs them through two implementations, and reports every answer that
 * differs. Nothing here knows which peer is right: a divergence is the finding,
 * and the reference peer to compare against is the caller's choice —
 * `PortableSearch` is the obvious one, because it needs no external binary.
 *
 * The generator deliberately stays inside the ground both peers claim to
 * share: no symlinks, no unreadable directories, no CRLF, no NUL bytes, no
 * filename a shell would have to quote. Those are the cases the hand-written
 * table pins one by one, with an expected value that says which behaviour is
 * intended. A generator cannot say that; it can only say the two disagree.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Search from "./Search.vibe";
/**
 * One file the generated tree contains.
 *
 * @category models
 * @since 1.0.0
 */
export interface GeneratedFile {
    /** Path relative to the tree root, always with `/` separators. */
    readonly path: string;
    readonly content: string;
}
/**
 * A generated tree plus the calls to make against it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Plan {
    readonly seed: number;
    readonly root: string;
    readonly files: ReadonlyArray<GeneratedFile>;
    readonly grep: ReadonlyArray<Search.GrepInput>;
    readonly glob: ReadonlyArray<Search.GlobInput>;
}
/**
 * One call two implementations answered differently.
 *
 * `subject` and `reference` are the rendered answers, so a report names the
 * bytes that differ rather than saying only that they did.
 *
 * @category models
 * @since 1.0.0
 */
export interface Divergence {
    readonly call: "grep" | "glob";
    readonly input: Search.GrepInput | Search.GlobInput;
    readonly subject: string;
    readonly reference: string;
}
/**
 * Builds a reproducible tree and call batch from a seed.
 *
 * The same seed and root always produce the same plan, so a divergence a run
 * reports can be replayed exactly by rerunning that seed.
 *
 * @category generators
 * @since 1.0.0
 */
export declare const plan: (options: {
    readonly seed: number;
    readonly root: string;
    readonly files?: number | undefined;
    readonly calls?: number | undefined;
}) => Plan;
/**
 * Writes a plan's tree under its root.
 *
 * @category generators
 * @since 1.0.0
 */
export declare const materialize: (target: Plan) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
/**
 * Runs every call in a plan through two implementations and reports the
 * answers that differ.
 *
 * A failure is compared like any other answer: two peers that refuse the same
 * call with the same code agree, and one that refuses where the other answers
 * has diverged.
 *
 * @category conformance
 * @since 1.0.0
 */
export declare const compare: (options: {
    readonly plan: Plan;
    readonly subject: Search.Search;
    readonly reference: Search.Search;
}) => Effect.Effect<ReadonlyArray<Divergence>>;
/**
 * Renders divergences as the report a failing conformance run should print.
 *
 * @category conformance
 * @since 1.0.0
 */
export declare const report: (divergences: ReadonlyArray<Divergence>) => string;
