/**
 * The redacting logger: the journal's redaction rules applied to log output.
 *
 * The journal redacts on the write path, so a credential a cell logs or
 * returns never reaches a committed row (`./Redaction.ts`). The operator's
 * terminal was the other place the same credential surfaces: every built-in
 * Effect logger renders through the fiber's `Console`, so an action that hands
 * a token to `Effect.logInfo` wrote it to stderr in full and it reached
 * whatever collected that stream.
 *
 * This module closes that half with the SAME rules rather than a second rule
 * set. {@link wrap} does not re-implement redaction and does not re-format a
 * log line. It redacts the log event itself — the message, the cause, and the
 * log annotations — before the wrapped logger is handed it, and it hands that
 * logger a view of the fiber whose `Console` is a redacting console, so
 * whatever the logger renders for itself — a pretty line, a JSON document —
 * passes through `Redaction.redact` on its way to the stream as well.
 *
 * Both halves carry load. Most built-in loggers write through the fiber's
 * `Console`, which is what covers the pretty line, the `--json` document, and
 * the `.flows/logs/<runId>.log` stream. But a logger is free to read the event
 * instead of rendering it, and one in Effect's own default logger set does:
 * `Logger.tracerLogger` publishes the message as a span event name and
 * `Cause.pretty` of the cause as the span's `effect.cause` attribute, and
 * never reads `Console` at all. Redacting only the console would hide a
 * credential on stderr and export it in clear to whatever OTLP collector is
 * configured.
 *
 * Cost is bounded by the rules themselves: every alternation inside a
 * repetition in `Redaction.diagnosticRules` starts its branches with disjoint
 * characters, so each rule is linear in the length of the line and no input
 * backtracks catastrophically.
 *
 * One deliberate difference from the journal write path. `Redaction.redact`
 * rebuilds an object from its own enumerable entries, which is right for a row
 * that is about to be JSON-encoded and wrong for a terminal: an `Error` keeps
 * `message` and `stack` on non-enumerable properties, so rebuilding one prints
 * `{}` where the operator expected a failure. An `Error` is rebuilt as a plain
 * `Error` instead, carrying its name, message, stack and own members with the
 * rules applied. Its class is NOT preserved. A copy built on the original's
 * prototype inherits everything the prototype defines, an own-key walk sees
 * none of it, and each of `name`, `cause`, `toJSON`, `Symbol.toStringTag` and
 * `nodejs.util.inspect.custom` carried a credential out that way.
 *
 * @since 0.1.0
 */
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redaction from "./Redaction.vibe";
/**
 * Marks a logger this module already wrapped.
 *
 * Both the CLI and the durable runtime install {@link layer}, and a detached
 * `smithers run` is both at once. Wrapping twice would be correct but pay the
 * rules twice per line, so a wrapped logger is returned unchanged.
 *
 * @since 0.1.0
 * @category type ids
 */
export declare const TypeId: unique symbol;
/**
 * Whether {@link wrap} already wrapped this logger.
 *
 * @since 0.1.0
 * @category predicates
 */
export declare const isRedacted: (logger: Logger.Logger<any, any>) => boolean;
/**
 * Redacts one value on its way out of the logger.
 *
 * An `Error` is rebuilt as a plain `Error` whose name, message, stack and own
 * members are redacted, so a renderer that special-cases an `Error` still gets
 * one. Everything else goes through the journal's own rules, which rebuild a
 * value from its plain data: a `Date`, a `Map`, a class instance or a host
 * object therefore reaches the operator in that plain form rather than as
 * itself.
 *
 * That collapse is deliberate, and it now covers the `Error` too. An earlier
 * version rebuilt each value on its own prototype to keep the rendering
 * faithful. Three rounds of review found three ways that could kill the run it
 * was logging, because a host class keeps state a property walk cannot see and
 * a copy of one throws the moment a brand check reads it, and four more found
 * that the prototype an `Error` copy kept was itself the leak: everything it
 * defines is read by a renderer and seen by no own-key walk. A log line is not
 * worth a run, and the rendering it buys is cosmetic.
 *
 * @since 0.1.0
 * @category redaction
 */
export declare const redactArgument: (value: unknown, redactor: Redaction.Redactor) => unknown;
/**
 * A console that runs every value it is handed through `redactor` and then
 * delegates to `target`.
 *
 * @since 0.1.0
 * @category constructors
 */
export declare const redactingConsole: (target: Console.Console, redactor: Redaction.Redactor) => Console.Console;
/**
 * Returns `logger` with the journal's redaction rules over everything it
 * renders. A logger this module already wrapped is returned unchanged.
 *
 * @since 0.1.0
 * @category combinators
 */
export declare const wrap: <Message, Output>(logger: Logger.Logger<Message, Output>, options?: Redaction.Options) => Logger.Logger<Message, Output>;
/**
 * Replaces the active logger set with redacting wrappers of the same loggers.
 *
 * It composes over whatever loggers are already installed rather than
 * choosing one, so an operator keeps the FORMAT they had, meaning their own
 * logger and its layout, though a value inside a line is rendered from its
 * redacted plain data rather than as its own class, and a host that
 * installed its own logger keeps it too.
 *
 * @since 0.1.0
 * @category layers
 */
export declare const layer: (options?: Redaction.Options) => Layer.Layer<never>;
