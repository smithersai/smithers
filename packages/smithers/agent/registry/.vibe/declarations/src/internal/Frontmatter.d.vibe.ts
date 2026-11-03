/**
 * YAML frontmatter parsing for markdown flow sources. Split out so the
 * fence handling for BOM, CRLF, and an unterminated document is stated once and
 * tested directly.
 *
 * @since 0.1.0
 */
import type * as Schema from "effect/Schema";
import type { DiscoveryWarning } from "../Descriptor.vibe";
/**
 * Separates a leading YAML frontmatter document from its markdown body.
 *
 * @since 0.1.0
 * @category parsing
 */
export { splitFrontmatter as split } from "@smthrs/core/Markdown";
/**
 * Returns whether a source prefix contains all leading frontmatter metadata.
 *
 * @since 0.1.0
 * @category predicates
 */
export declare const isMetadataComplete: (text: string) => boolean;
/**
 * Parses a leading YAML frontmatter document without allowing malformed input
 * to interrupt discovery. The returned record has a null prototype, and every
 * object and array in its graph is frozen. An inherited field can therefore
 * never be observed as frontmatter metadata.
 *
 * @since 0.1.0
 * @category parsing
 */
export declare const parse: (options: {
    readonly text: string;
    readonly path: string;
}) => {
    readonly fields: Record<string, Schema.Json>;
    readonly warnings: ReadonlyArray<DiscoveryWarning>;
};
