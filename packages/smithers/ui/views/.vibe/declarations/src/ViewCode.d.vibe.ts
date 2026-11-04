/**
 * Checks a generated view's TSX module before it runs, and compiles it.
 *
 * A renderer agent writes one module:
 *
 * ```tsx
 * import { Button, Card } from "@smthrs/ui"
 * import type { ViewProps } from "smithers:view"
 * export const interactions = { cell: { kind: "state" }, ask: { kind: "message", label: "Play" } }
 * export const reduce = (state: Board, event: { name: string; arg?: string }): Board => ...
 * export default function View({ props, state }: ViewProps<Board>) { ... }
 * ```
 *
 * {@link check} parses it with `@babel/parser`, refuses what a view may not
 * do, reads its `interactions` export, and compiles it with `sucrase` to the
 * CommonJS body `PresentationRealm` runs. It reports every problem it finds,
 * with a line and column, so a renderer can correct the module in one step.
 *
 * The checker is depth, not the boundary. The QuickJS realm has no network,
 * storage, clock or page to reach, and the frame's sanitizer and CSP stand
 * behind the HTML it produces.
 *
 * What it refuses:
 *
 * - more than {@link maxSourceBytes} of source, or text with a lone surrogate;
 * - imports other than `react`, `@smthrs/ui` (only the components the
 *   presentation bundle carries) and `smithers:view`;
 * - dynamic `import()`, `import.meta`, `require`, `export ... from`, and
 *   exports other than `default`, `interactions`, `reduce` and types;
 * - names that reach the network, storage, the page, a clock, randomness or
 *   code evaluation, such as `fetch`, `localStorage`, `document`, `location`,
 *   `top`, `parent`, `opener`, `setTimeout`, `Date`, `Math.random` and `eval`;
 * - properties such as `constructor`, `__proto__`, `prototype` and
 *   `dangerouslySetInnerHTML`;
 * - the elements `script`, `iframe`, `object`, `embed`, `link`, `meta`,
 *   `base`, `a`, `style` and others that load, navigate or run script;
 * - attributes such as `href`, `src` (outside a `data:image` `<img>`),
 *   `action`, `formAction`, `srcSet`, `xlink:href` and every `on*` handler;
 * - `javascript:` URLs and HTML comment tokens anywhere in the text;
 * - a `data-event` literal naming an event the module does not declare.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
/**
 * The largest module source, in UTF-8 bytes.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maxSourceBytes: number;
/**
 * The most problems one check reports.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maxProblems = 20;
/**
 * The modules a view may import.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const modules: readonly ["react", "@smthrs/ui", "smithers:view"];
/**
 * The values a view may import from `react`. Types may be imported freely.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const reactValues: ReadonlyArray<string>;
/**
 * The values a view may import from `smithers:view`. Its types, `ViewProps`
 * and `ViewEvent`, may be imported too.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const viewValues: ReadonlyArray<string>;
/**
 * One thing wrong with a module, with its 1-based line and 0-based column
 * when it has a place.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Problem: Schema.Struct<{
    readonly message: Schema.String;
    readonly line: Schema.optionalKey<Schema.Int>;
    readonly column: Schema.optionalKey<Schema.Int>;
}>;
/**
 * One thing wrong with a module.
 *
 * @category models
 * @since 0.1.0
 */
export type Problem = typeof Problem.Type;
/**
 * Why a module failed its check:
 *
 * - `too_large`: over {@link maxSourceBytes};
 * - `malformed_text`: a lone UTF-16 surrogate;
 * - `syntax`: it does not parse or compile as TSX;
 * - `refused`: it parses, but does something a view may not.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Reason: Schema.Literals<readonly ["too_large", "malformed_text", "syntax", "refused"]>;
declare const ViewCodeError_base: Schema.Class<ViewCodeError, Schema.TaggedStruct<"@smthrs/views/ViewCodeError", {
    readonly reason: Schema.Literals<readonly ["too_large", "malformed_text", "syntax", "refused"]>;
    readonly detail: Schema.Redacted<Schema.String>;
    readonly problems: Schema.Redacted<Schema.$Array<Schema.Struct<{
        readonly message: Schema.String;
        readonly line: Schema.optionalKey<Schema.Int>;
        readonly column: Schema.optionalKey<Schema.Int>;
    }>>>;
}>, import("effect/Cause").YieldableError>;
/**
 * The module failed its check.
 *
 * `detail`, one line per problem as `line:column: message`, and `problems`
 * are written for the renderer that wrote the module. They quote its
 * identifiers and text, which a model can fill with conversation content, so
 * both are redacted and print as `<redacted>`; read them with
 * `Redacted.value` for a correction prompt, never for a log, a span or a
 * metric. `message` names only the reason, so an ordinary span or log line
 * around a check carries no module content.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class ViewCodeError extends ViewCodeError_base {
    /** The reason as a sentence; never the module's words. */
    get message(): string;
}
declare const CheckedModule_base: Schema.Class<CheckedModule, Schema.Struct<{
    readonly source: Schema.String;
    readonly compiled: Schema.String;
    readonly digest: Schema.String;
    readonly interactions: Schema.$Record<Schema.String, Schema.Union<readonly [Schema.Struct<{
        readonly kind: Schema.Literal<"state">;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"message">;
        readonly label: Schema.String;
    }>]>>;
    readonly reduces: Schema.Boolean;
}>, {}>;
/**
 * A module that passed its check.
 *
 * - `source`: the TSX as written;
 * - `compiled`: the CommonJS body `PresentationRealm` evaluates;
 * - `digest`: the SHA-256 of `source`, as lowercase hex;
 * - `interactions`: the module's declared events;
 * - `reduces`: whether it exports `reduce`.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare class CheckedModule extends CheckedModule_base {
}
/**
 * What a check needs besides the source: the component names the
 * presentation bundle carries, which a module may import from `@smthrs/ui`.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckOptions {
    readonly components: ReadonlyArray<string>;
}
/**
 * Checks and compiles a view module.
 *
 * @category checking
 * @since 0.1.0
 */
export declare const check: (source: string, options: CheckOptions) => Effect.Effect<CheckedModule, ViewCodeError>;
export {};
