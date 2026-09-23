/** The ECMAScript time-value range; anything outside it is not a date. */
const MAX_TIME_VALUE = 8.64e15;

/**
 * The `Date` for an epoch-millisecond timestamp, or `undefined` when the value
 * is absent, not finite, or outside the representable range.
 *
 * `new Date(NaN).toISOString()` throws `RangeError: Invalid time value`, so a
 * component that serializes a timestamp must go through this guard: one
 * malformed row omits its time instead of taking down the whole render.
 */
export function dateFromMs(timestampMs: number | undefined): Date | undefined {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return undefined;
  if (Math.abs(timestampMs) > MAX_TIME_VALUE) return undefined;
  return new Date(timestampMs);
}
