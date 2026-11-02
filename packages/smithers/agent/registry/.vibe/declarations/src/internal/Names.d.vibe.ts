/**
 * Flow naming: how a discovered source path becomes the owned flow name a
 * registry entry is addressed by.
 *
 * @since 0.1.0
 */
import * as Option from "effect/Option";
import type { DiscoveryWarning } from "../../../../src/Descriptor.ts";
/**
 * Derives an owned flow name from directory segments relative to its source root.
 *
 * @since 0.1.0
 * @category naming
 */
export declare const deriveFromPath: (segments: ReadonlyArray<string>) => Option.Option<string>;
/**
 * Derives a foreign skill name from frontmatter, with the directory name as a
 * compatibility fallback.
 *
 * @since 0.1.0
 * @category naming
 */
export declare const deriveFromFrontmatter: (options: {
    readonly fields: Record<string, unknown>;
    readonly dirBasename: string;
    readonly path: string;
}) => {
    readonly name: string;
    readonly warnings: ReadonlyArray<DiscoveryWarning>;
};
