/**
 * The one JSON rendering every durable agent failure goes through.
 * @since 1.0.0
 */
/**
 * Renders a failure into a value a `Schema.Unknown` JSON codec accepts.
 *
 * Every durable agent boundary needs the same conversion — the flow
 * settlement, the action's error channel, the budget's accounting failure —
 * and each one used to carry its own copy. The copies diverged: a native
 * `Error` nested in a cause kept its message through the settlement and became
 * `{}` through the other two, so the same provider refusal was legible in one
 * record and empty in the next. One renderer means one answer.
 *
 * Values already accepted by the JSON codec retain their identity. An OBJECT
 * the codec rejects is then round-tripped through JSON so its enumerable
 * refusal fields, `_tag` above all, survive while its prototype and stack do
 * not, and {@link replacer} carries an `Error`'s message across with them.
 * Anything else falls back to `Cause.pretty`. That order keeps typed failures
 * machine-readable without letting a cycle throw from a failure mapper, and a
 * defect stays a defect because callers map the failure channel only.
 *
 * The round trip is reserved for objects because `JSON.stringify` does not
 * refuse the non-JSON PRIMITIVES, it rewrites them: `Infinity` and `NaN` both
 * serialize to `null`, so a run that failed on an arithmetic result recorded
 * the same failure as one that failed with a literal `null`, and no reader
 * could tell them apart. `Cause.pretty` is no better on one, printing
 * `Error: null` for either, so a primitive is rendered directly.
 *
 * @category conversions
 * @since 1.0.0
 */
export declare const failureJson: (error: unknown) => unknown;
