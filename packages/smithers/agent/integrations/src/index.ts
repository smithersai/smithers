/**
 * GitHub, Linear, Telegram, Slack, Google Calendar, Gmail, and X adapters over
 * the Smithers control plane.
 *
 * Import a provider through its own subpath (`@smthrs/integrations/github`)
 * when you only need one. This entry point is the aggregate.
 *
 * @since 1.0.0
 */

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Core from "./core.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as GitHub from "./github.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Linear from "./linear.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Telegram from "./telegram.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Gmail from "./gmail.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as GoogleCalendar from "./googlecalendar.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Slack from "./slack.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as X from "./x.ts"
