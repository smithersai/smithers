/**
 * TanStack DB as Effect: collections are scoped services checked by an Effect
 * `Schema`, changes and live query results are `Stream`s, and mutations are
 * typed Effects.
 *
 * @since 0.1.0
 */

/**
 * @category collections
 * @since 0.1.0
 */
export * as Collection from "./Collection.ts"

/**
 * @category queries
 * @since 0.1.0
 */
export * as LiveQuery from "./LiveQuery.ts"

/**
 * @category queries
 * @since 0.1.0
 */
export * as Query from "./Query.ts"

/**
 * @category persistence
 * @since 0.2.0
 */
export * as Persistence from "./Persistence.ts"

/**
 * @category writes
 * @since 0.2.0
 */
export * as Outbox from "./Outbox.ts"

/**
 * @category migrations
 * @since 0.3.0
 */
export * as Migrations from "./Migrations.ts"
