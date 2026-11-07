/**
 * A failure's code for a log line (docs/observability.md): `sql:<reason>` for a SQL failure, otherwise the `_tag` of an
 * `Error` when it has the shape of a failure class's name, otherwise `unknown`. Never its message, which can quote what someone
 * wrote or a provider's text, and never a `_tag` on a plain value or one of another shape, which can hold the same. It
 * never throws, whatever the failure's properties do: it is what a failure handler calls.
 */
export declare const codeOf: (error: unknown) => string;
