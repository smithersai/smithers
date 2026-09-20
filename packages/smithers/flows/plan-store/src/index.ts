/**
 * The persisted plan: an append-only SQLite store and the migrations that own
 * its three tables.
 *
 * A `@smthrs/plan` plan is an inert value with no I/O of its own. This package
 * is where that value is kept, so the plan package stays a pure compiler and
 * only a caller that actually persists takes on `@smthrs/database`.
 *
 * Growth is append-only and the SQL enforces it. Driving a stored plan is
 * `@smthrs/engine-store`'s `PlanScheduler`.
 *
 * @since 0.1.0
 */

/**
 * @since 0.1.0
 * @category migrations
 */
export * as Migrations from "./Migrations.ts"

/**
 * @since 0.1.0
 * @category services
 */
export * as PlanStore from "./PlanStore.ts"
