/**
 * Text operations used by a synchronous telemetry snapshot.
 * Tests decorate the real operations in one fiber without patching globals.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"

const encoder = new TextEncoder()

/**
 * Real text operations, shared by snapshots unless a fiber provides its own.
 *
 * @category internal
 * @since 1.0.0
 */
export const operations = {
  charCodeAt: (value: string, index: number): number => value.charCodeAt(index),
  encode: (value: string): Uint8Array<ArrayBuffer> => encoder.encode(value)
}

/**
 * Fiber-local text operations for measuring the work of a real snapshot.
 *
 * @category internal
 * @since 1.0.0
 */
export const TelemetryText = Context.Reference<typeof operations>("@smthrs/journal/TelemetryText", {
  defaultValue: () => operations
})
