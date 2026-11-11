/**
 * Display text shared by version probes and account signals.
 *
 * @since 0.1.0
 */

/** ANSI CSI and OSC sequences, then any remaining C0/C1 control or bidi override. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this strips.
const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
// eslint-disable-next-line no-control-regex -- control characters are exactly what this strips.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * Strip terminal escape sequences, control characters and bidi overrides,
 * then trim whitespace. Callers bound the result for their display field.
 *
 * @category detection
 * @since 0.1.0
 */
export const sanitizeDisplayText = (value: string): string =>
  value.replace(ESCAPE_SEQUENCE, "").replace(CONTROL, "").trim()
