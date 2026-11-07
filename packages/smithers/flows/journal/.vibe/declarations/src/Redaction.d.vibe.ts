/**
 * Payload redaction for durable journal writes.
 *
 * The journal is permanent and broadly readable: every entry is replayed to
 * sync subscribers and to time-travel consumers. A secret that reaches
 * `payload_json` is therefore not a transient leak, so redaction happens once,
 * on the journal write path, rather than at each reader.
 *
 * Redaction is an **observability** concern and is confined to journal events
 * and export/display surfaces. It is deliberately not applied to executable
 * state, `flows_runs.state_json`, attempt checkpoints, errors, outcomes, and
 * cache results, because those are decoded and re-entered on resume: a
 * placeholder there resumes the flow with the wrong data, and replacing a
 * non-string value with a placeholder string makes the persisted state fail
 * schema decode outright, leaving the run undrivable (issue #72). A value
 * that must never reach durable executable state is a `Redacted` field in the
 * caller's own schema, not a name-suffix guess made at the storage seam.
 *
 * The rule set is a best-effort textual net over credential shapes seen in
 * real bug reports, plus structural redaction by sensitive field name. It is
 * finite, so a value that must never persist belongs in a `Redacted` field of
 * the caller's own schema. See https://journal.smithers.sh/concepts/redaction/
 * for the rule set and how to replace it.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
/**
 * A textual redaction rule.
 *
 * `replace` is the substitution for a matched span; when omitted the whole
 * match is replaced by the placeholder.
 *
 * `rewrite`, when set, rewrites the text itself instead. It is for a rule
 * whose extent is not regular: where a credential's value ends depends on
 * quotes, escapes and brackets a regular expression cannot count. `pattern`
 * then names what the rule looks for, and text `pattern` does not match is
 * left unchanged without calling `rewrite`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Rule {
    readonly id: string;
    readonly pattern: RegExp;
    readonly replace?: string | undefined;
    readonly rewrite?: ((text: string) => string) | undefined;
}
/**
 * The placeholder written in place of a redacted value.
 *
 * @since 0.1.0
 * @category constants
 */
export declare const placeholder = "[REDACTED]";
/**
 * Best-effort textual rules for credential shapes observed in real reports.
 * Every replacement reaches a fixed point so replaying or exporting an entry
 * cannot mutate it again.
 *
 * @since 0.1.0
 * @category constants
 */
export declare const defaultRules: ReadonlyArray<Rule>;
/**
 * The rules for a diagnostic: {@link defaultRules} and the spellings too broad
 * for a durable row.
 *
 * A log line, a stderr message, and an error handed to a remote caller are
 * read once, so a false positive costs a word of context. A journal row is
 * permanent, so the same false positive destroys data. These rules sit on the
 * diagnostic side of that line: an authorization header in any scheme, bare
 * URL userinfo (`https://token@host`), a signed query parameter, and the value
 * of a `-p` flag, which is a password to `mysql` and `sshpass` and a path to
 * `mkdir`. A path, a port and a lowercase word attached to `-p` (`-print`,
 * `-path`) are left alone.
 *
 * @since 1.0.0
 * @category constants
 */
export declare const diagnosticRules: ReadonlyArray<Rule>;
/**
 * Redacts one diagnostic value with {@link diagnosticRules}: a log line, a
 * stderr message, an error handed back to a caller.
 *
 * Every diagnostic path shares this one function, and it runs on the value
 * before anything renders or bounds it. Redacting a rendering line by line, or
 * after a bound, is how a secret escaped: `util.inspect` splits a long string
 * over several lines, and a bound cuts a quoted value before its closing
 * quote. A value past {@link maxDepth} is named rather than thrown.
 *
 * @since 1.0.0
 * @category redaction
 */
export declare const redactDiagnostic: (value: unknown) => unknown;
/**
 * Whether a field name names a credential.
 *
 * Case and separators are ignored, so `api_key`, `apiKey`, and `x-api-key` are
 * all recognised, one trailing plural `s` is stripped so `credentials` reads as
 * `credential`, and a trailing `key` counts where it is a word of its own or
 * where the word before it names a secret.
 *
 * The rule is a suffix test, not a substring test. `tokenizer`, `secretary`,
 * `monkey`, and `idempotencyKey` are ordinary field names, and replacing their
 * values would destroy data in a permanent row without protecting anything.
 * That is the one place this rule is deliberately narrower than
 * `packages/smithers/src/Bug.ts`'s substring form, which can afford the false
 * positives because its output is a single report an operator reads once.
 *
 * @since 0.1.0
 * @category predicates
 */
export declare const isSensitiveKey: (key: string) => boolean;
/**
 * Maximum number of container edges traversed from a redaction root.
 *
 * Journal event schemas never approach 256 nested containers. This bound is
 * far above practical payloads while keeping traversal safely below Node's
 * call-stack limit for hostile input.
 *
 * @since 1.0.0
 * @category constants
 */
export declare const maxDepth = 256;
declare const RedactionDepthError_base: Schema.Class<RedactionDepthError, Schema.TaggedStruct<"@smthrs/journal/RedactionDepthError", {
    readonly code: Schema.Literal<"depth_exceeded">;
    readonly maxDepth: Schema.Number;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A payload nested deeper than {@link maxDepth}, under `onTooDeep: "throw"`.
 * `code` is always `depth_exceeded`; `maxDepth` is the bound that was crossed.
 *
 * @since 1.0.0
 * @category errors
 */
export declare class RedactionDepthError extends RedactionDepthError_base {
    readonly name = "RedactionDepthError";
}
/**
 * Options for {@link redact}.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
    readonly rules?: ReadonlyArray<Rule> | undefined;
    /**
     * What a value nested past {@link maxDepth} does.
     *
     * `"throw"`, the default, is the journal's contract: a payload that deep is a
     * caller bug, and a durable row quietly truncated to a marker is worse than a
     * refused write. `"name"` is what a LOGGER wants, because a throw there is
     * caught one frame up and replaces EVERY argument on the line with
     * `[Unrenderable]`, so one deep member would cost the operator the whole line.
     */
    readonly onTooDeep?: "throw" | "name" | undefined;
}
/**
 * How many bytes a view may hold, and how many own members {@link redact} reads
 * off it, before it stops reading them.
 *
 * Enumerating a view's own properties materialises one pair per byte, so the
 * walk costs the buffer's size even though the rendering does not. Both halves
 * of the bound carry load, and neither is a bound on its own. A size alone is
 * not, because `byteLength` was read as an ordinary property and an ordinary
 * property can be shadowed: a pooled chunk that reports the bytes it has used
 * rather than the bytes it holds is a plain pattern, not an adversarial one,
 * and a 4 MB chunk reporting 12 walked one property per byte anyway. A count
 * alone is not, because a caller can hang a million properties on a ten-byte
 * view. So the size is read from the value's own internal slot, where nothing
 * a caller writes can answer for it, and the members are counted as they are
 * walked.
 *
 * @since 0.1.0
 * @category redaction
 */
export declare const binaryWalkLimit = 65536;
/**
 * The key {@link redact} files a binary view's size under.
 *
 * @since 0.1.0
 * @category redaction
 */
export declare const binaryMarker = "[Binary]";
/**
 * What {@link redact} writes in place of a function or a class object.
 *
 * @since 0.1.0
 * @category redaction
 */
export declare const functionMarker = "[Function]";
/**
 * What {@link redact} writes in place of a symbol.
 *
 * @since 0.1.0
 * @category redaction
 */
export declare const symbolMarker = "[Symbol]";
/**
 * What {@link redact} writes past {@link maxDepth} under `onTooDeep: "name"`.
 *
 * @since 0.1.0
 * @category redaction
 */
export declare const depthMarker = "[Deep]";
/**
 * Returns `value` with credentials removed.
 *
 * Objects and arrays are rebuilt: a field whose name {@link isSensitiveKey}
 * is replaced wholesale, every other string is run through the textual rules,
 * and a cycle is collapsed to `"[Circular]"` so the result always encodes.
 * A number, a boolean, `null` and `undefined` are returned untouched, because
 * redacting one destroys data without protecting anything. A function and a
 * symbol are NAMED, {@link functionMarker} and {@link symbolMarker}: a body, an
 * own property and a description are all text a renderer prints, and none of it
 * can be rewritten in place.
 *
 * Traversal accepts at most {@link maxDepth} container edges. A deeper value
 * throws by default, so the journal boundary can report a typed `invalid_event`
 * instead of overflowing the runtime stack. {@link Options.onTooDeep} set to
 * `"name"` writes {@link depthMarker} in its place instead, which is what a
 * logger wants.
 *
 * @since 0.1.0
 * @category redaction
 */
export declare const redact: (value: unknown, options?: Options) => unknown;
/**
 * A redaction function, as the journal consumes it.
 *
 * @since 0.1.0
 * @category models
 */
export type Redactor = (value: unknown) => unknown;
/**
 * Builds a redactor over a rule set.
 *
 * @since 0.1.0
 * @category constructors
 */
export declare const make: (options?: Options) => Redactor;
/**
 * Applies a redactor to an already-encoded JSON string, returning the
 * re-encoded result.
 *
 * For export and display surfaces that hold a column verbatim, a rendered
 * `state_json`, a support bundle, where the value is already encoded and must
 * not be decoded into the executable path. A string that does not parse is
 * returned untouched: validation is the caller's, and rejecting here would
 * turn a redaction concern into a schema error. Once parsing succeeds, a
 * throwing redactor or an encoding failure returns the valid JSON string
 * `"[REDACTED]"`; the original parsed text is never returned.
 *
 * @since 0.1.0
 * @category redaction
 */
export declare const redactJsonString: (json: string, redactor: Redactor) => string;
/**
 * Redacts a stream one line at a time.
 *
 * @since 1.0.0
 * @category models
 */
export interface LineRedactor {
    /**
     * Takes the rest of the current line, without its newline, and returns the
     * lines now safe to emit: none while a value is still open.
     */
    readonly line: (line: string) => ReadonlyArray<string>;
    /**
     * Takes part of a line whose newline has not arrived. A line longer than
     * {@link maxPartialLine} is never emitted: {@link omittedLine} stands for it.
     */
    readonly part: (text: string) => void;
    /** What {@link LineRedactor.flush} would emit now, without ending the stream: for a rendered snapshot. */
    readonly peek: () => ReadonlyArray<string>;
    /** Ends the stream and returns whatever is still held, redacted as one block. */
    readonly flush: () => ReadonlyArray<string>;
}
/**
 * Lines a {@link lineRedactor} holds for one open value. Past this, or past
 * 64 KiB, it stops holding: it emits what it held, redacted, and withholds
 * every later line until the stream ends, when one placeholder stands for
 * them. Dropping lines from the middle instead changed which brackets and
 * quotes were open, and released a later secret in clear.
 *
 * @since 1.0.0
 * @category constants
 */
export declare const maxHeldLines = 256;
/**
 * The longest line a {@link lineRedactor} reads whole. A longer line keeps
 * its first and last 16 KiB; its middle is scanned for what it leaves open
 * and dropped.
 *
 * @since 1.0.0
 * @category constants
 */
export declare const maxPartialLine: number;
/**
 * What a {@link lineRedactor} emits in place of a line longer than
 * {@link maxPartialLine}.
 *
 * @since 1.0.0
 * @category constants
 */
export declare const omittedLine = "[overlong line omitted]";
/**
 * A redactor for a stream that must be emitted line by line: a live build
 * log, a child's stderr.
 *
 * Redacting each line alone is the flaw that leaked a private key's body, and
 * the tail of every string `util.inspect` split over several lines: only the
 * line holding the name was redacted. This one asks the rules themselves
 * whether a line leaves a value open, by checking whether the value swallows
 * a probe placed on the next line, and holds lines until it closes. The held
 * block is then redacted whole, exactly as {@link redact} redacts a string.
 *
 * A line longer than {@link maxPartialLine} is read as its first and last
 * 16 KiB. Its middle is dropped, but a bracket, quote or key block the middle
 * leaves open would have opened a value the kept ends cannot show, so then
 * the rest of the stream is withheld. Such a line is never emitted, only
 * {@link omittedLine}, and neither is any block it was held in.
 *
 * Its state is bounded whatever the stream does: the line still arriving is
 * a 16 KiB head, a 16 KiB tail and at most 1024 open brackets or strings of
 * its middle, a middle nested deeper counting as one left open; the held
 * block is bounded by {@link maxHeldLines} and 64 KiB. Its cost is linear:
 * past the first 16 held lines the block is re-read only once it has grown
 * by half, on Node and on Bun alike (#3088).
 *
 * `rules` defaults to {@link diagnosticRules}. The array is read on every
 * line, so a caller may add a rule, a session secret, as the stream runs.
 *
 * @since 1.0.0
 * @category constructors
 */
export declare const lineRedactor: (rules?: ReadonlyArray<Rule>) => LineRedactor;
/**
 * The identity redactor, for a caller that persists payloads verbatim by
 * choice: a trusted single-tenant store, or a suite asserting on raw input.
 *
 * @since 0.1.0
 * @category constructors
 */
export declare const makeNoop: () => Redactor;
export {};
