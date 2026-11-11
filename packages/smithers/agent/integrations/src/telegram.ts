/**
 * The Telegram integration surface: receiving a bot's messages.
 *
 * A `getUpdates` long-poll source and the schemas of the messages it
 * delivers. Sending lives in `@smthrs/notifications` (`Channels`).
 *
 * @since 1.0.0
 */

/**
 * @category schemas
 * @since 1.0.0
 */
export * as Payload from "./telegram/Payload.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as Source from "./telegram/Source.ts"
