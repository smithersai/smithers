/**
 * Structured memory namespaces and tag-group matching.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
/**
 * Stable namespace lifetimes.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Kind: Schema.Literals<readonly ["flow", "agent", "user", "global"]>;
/**
 * Stable namespace lifetime.
 *
 * @category models
 * @since 0.1.0
 */
export type Kind = typeof Kind.Type;
/**
 * Structured memory namespace.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Namespace: Schema.Struct<{
    readonly kind: Schema.Literals<readonly ["flow", "agent", "user", "global"]>;
    readonly id: Schema.NonEmptyString;
}>;
/**
 * Structured memory namespace.
 *
 * @category models
 * @since 0.1.0
 */
export type Namespace = typeof Namespace.Type;
/**
 * Maximum number of tags accepted on one record or tag-group leaf.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const MAX_TAGS = 16;
/**
 * Maximum root-inclusive depth of one tag-group expression.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const MAX_TAG_GROUP_DEPTH = 8;
/**
 * Maximum number of expression nodes in one tag-group tree.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const MAX_TAG_GROUP_NODES = 64;
/**
 * Stable tag prefixes.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const TagPrefix: Schema.Literals<readonly ["branch:", "stream:", "source:", "scope:"]>;
/**
 * Stable tag prefix.
 *
 * @category models
 * @since 0.1.0
 */
export type TagPrefix = typeof TagPrefix.Type;
/**
 * A vocabulary-constrained memory tag.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Tag: Schema.TemplateLiteral<readonly [Schema.Literals<readonly ["branch:", "stream:", "source:", "scope:"]>, Schema.NonEmptyString]>;
/**
 * A vocabulary-constrained memory tag.
 *
 * @category models
 * @since 0.1.0
 */
export type Tag = typeof Tag.Type;
/**
 * A bounded collection of memory tags.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Tags: Schema.$Array<Schema.TemplateLiteral<readonly [Schema.Literals<readonly ["branch:", "stream:", "source:", "scope:"]>, Schema.NonEmptyString]>>;
/**
 * A bounded collection of memory tags.
 *
 * @category models
 * @since 0.1.0
 */
export type Tags = typeof Tags.Type;
/**
 * Tag comparison modes inherited from the Smithers memory contract.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const MatchMode: Schema.Literals<readonly ["any", "all", "any_strict", "all_strict", "exact"]>;
/**
 * Tag comparison mode.
 *
 * @category models
 * @since 0.1.0
 */
export type MatchMode = typeof MatchMode.Type;
/**
 * Recursive tag-group query expression.
 *
 * @category models
 * @since 0.1.0
 */
export type TagGroup = {
    readonly tags: Tags;
    readonly match?: MatchMode | undefined;
} | {
    readonly and: ReadonlyArray<TagGroup>;
} | {
    readonly or: ReadonlyArray<TagGroup>;
} | {
    readonly not: TagGroup;
};
/**
 * Recursive Schema for tag-group queries.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const TagGroup: Schema.compose<Schema.Codec<TagGroup, TagGroup, never, never>, Schema.declare<TagGroup, TagGroup>>;
/**
 * Evaluates a tag-group against a record's tags.
 *
 * Non-strict `any` and `all` preserve Smithers' wildcard behavior for
 * untagged records. Strict modes require the record to carry at least one tag.
 * Evaluation rides {@link walkTagGroup}, so it shares one budget rule with the
 * schema and returns `false` for an undecoded expression that is malformed or
 * exceeds {@link MAX_TAG_GROUP_DEPTH} or {@link MAX_TAG_GROUP_NODES}, keeping
 * the boolean signature used by store consumers without exposing a defect.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const matches: (tagGroup: TagGroup, tags: ReadonlyArray<string>) => boolean;
