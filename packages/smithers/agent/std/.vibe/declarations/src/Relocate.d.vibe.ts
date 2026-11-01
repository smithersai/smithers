/**
 * What can be pointed at a checkpoint, and what cannot.
 *
 * {@link relocate} is the closed answer, and it is the half of the checkpoint
 * feature that tracks the flows rather than git: it knows that `bash` carries
 * its working directory in `cwd` and that `read`, `ls`, `grep` and `glob` carry
 * their subject in `path`, `path`, `root` and `root`. `Checkpoints` changes when
 * git does; this changes when one of those five input shapes does, which is why
 * it is a module of its own. `Relocate.test.ts` decodes every rewritten input
 * with the flow's own `Input` schema, so a renamed field fails there rather than
 * silently relocating nothing.
 *
 * `bash` names *where it runs*, so it is relocated by its `cwd` — into the
 * checkpoint, and into the same subdirectory of it the call asked for, because a
 * check declared in `tests/` that silently ran at the top would come back
 * failing for a reason nobody chose. `read`, `ls`, `grep` and `glob` name *what
 * they touch* relative to the workspace root, so they are relocated by prefixing
 * that root — and only when the path they name stays inside the tree, because an
 * absolute path in these runs is a container path the host cannot rebase and a
 * `..` path is the live tree under another name. Every other flow answers
 * `checkpoint_unsupported` through the harness, including `test`, which already
 * has `against: "base"` for exactly this question and would otherwise have two
 * mechanisms that can disagree.
 *
 * @since 1.0.0
 */
import type { Schema } from "effect";
import type { Materialized } from "./Checkpoints.ts";
/**
 * Why one input could not be pointed at a checkpoint.
 *
 * @category models
 * @since 1.0.0
 */
export type Relocation = {
    readonly _tag: "Relocated";
    readonly input: Schema.Json;
} | {
    readonly _tag: "UnsupportedFlow";
} | {
    readonly _tag: "AbsolutePath";
    readonly path: string;
} | {
    readonly _tag: "OutsideTree";
    readonly path: string;
};
/**
 * Rewrites one call's input so the call runs against a materialized checkpoint.
 *
 * Returns the rewritten input, or the reason there is none. A `bash` call runs
 * in the checkpoint's directory — from the *guest* side when it names a
 * container, because that is the path the container will be given — and keeps
 * whatever subdirectory it asked for: a check declared in `tests/` runs in the
 * checkpoint's `tests/`. A working directory the checkpoint holds no copy of,
 * such as somewhere else on the machine, becomes the checkpoint's own top,
 * because a tree is all this can offer and there is no subpath in it to keep.
 *
 * A reader takes the checkpoint's workspace-relative directory as the prefix of
 * what it names, because these flows resolve their subject against the
 * workspace root and the checkpoint is a directory under it.
 *
 * Two paths are refused rather than rewritten, and both for the same reason —
 * the host would otherwise hand back a reading of a tree the cell did not name.
 * An absolute path in these runs is a container path, and the host cannot know
 * which prefix of it names the tree. A relative path that climbs past the
 * checkpoint with `..` names the live tree, exactly the tree the reading was
 * taken to avoid.
 *
 * @category conversions
 * @since 1.0.0
 */
export declare const relocate: (flow: string, input: Schema.Json, materialized: Materialized) => Relocation;
