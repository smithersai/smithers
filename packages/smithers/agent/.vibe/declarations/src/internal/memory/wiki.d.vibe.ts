/**
 * The wiki as `memory` reads it: the repository's page catalog, its skills,
 * and the dependency documentation a wiki refresh imported.
 *
 * - Pages are the `pages` of `.smithers/coding-project.json`, each read from
 *   its owning `document`.
 * - Skills are `.agents/skills/<name>/SKILL.md`, read where they live, so
 *   nothing is copied and nothing drifts.
 * - Dependency pages are the Markdown a wiki refresh imported under
 *   `.flows/wiki/deps/<name>/`, from the `docs` the workspace declares.
 * - Decisions pages are `.smithers/wiki/decisions/<item>.md`, the steering a
 *   person gave runs on one item, which `memory/mine` appends. They are
 *   pages; one the catalog already lists is read once, as its catalog page.
 *
 * Every read is best effort: a missing catalog is an empty wiki. A link, a
 * file a linked parent directory leads outside the root to, or a catalog
 * document outside the root or in a private tree, is never read.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
/**
 * One wiki candidate.
 *
 * @since 1.0.0
 * @private
 */
export interface Page {
    readonly kind: "page" | "skill" | "dep";
    readonly id: string;
    readonly title: string;
    readonly text: string;
    /** A page whose inputs no longer hash to the source; omitted as `stale`. */
    readonly stale?: boolean | undefined;
    /** The repository files the page explains, from its catalog spec. */
    readonly inputs?: ReadonlyArray<string> | undefined;
}
/**
 * The most of one page a candidate carries.
 *
 * @since 1.0.0
 * @private
 */
export declare const pageBytes: number;
/**
 * Where a wiki refresh imports declared dependency documentation.
 *
 * @since 1.0.0
 * @private
 */
export declare const depsDirectory = ".flows/wiki/deps";
/**
 * Where `memory/mine` appends each item's decisions page.
 *
 * @since 1.0.0
 * @private
 */
export declare const decisionsDirectory = ".smithers/wiki/decisions";
/**
 * Every catalog page, decisions page, skill and dependency page of `root`,
 * in that order.
 *
 * @since 1.0.0
 * @private
 */
export declare const catalog: (root: string) => Effect.Effect<Page[], import("effect/PlatformError").PlatformError, FileSystem.FileSystem | Path.Path>;
