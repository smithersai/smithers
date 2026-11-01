/**
 * The four messages between a generated view's frame and the page that shows
 * it, and the checks the page runs on every message the frame sends.
 *
 * | Method | Direction | What it does |
 * | --- | --- | --- |
 * | `ui/initialize` | frame to page, request | the frame's runtime asks once with the nonce the page wrote into it; the reply carries `{ html, theme, size }` and transfers a `MessagePort` |
 * | `ui/notifications/host-context-changed` | page to frame | new HTML or a new theme |
 * | `ui/notifications/size-changed` | frame to page | the content's height |
 * | `smithers/interaction` | frame to page | `{ event, arg?, values? }` from a real click or submit on a `data-event` element |
 *
 * Every message is JSON-RPC 2.0, and the names follow MCP Apps where the two
 * overlap. Only `ui/initialize` travels by `postMessage` on the window; every
 * later message uses the transferred port.
 *
 * {@link receive} is what the page runs on a message from the port. It
 * decodes the message, bounds it, refuses an event the view did not declare,
 * and admits at most {@link maxInteractionsPerSecond} interactions a second.
 *
 * @since 0.1.0
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Interactions from "./Interactions.vibe";
/**
 * The largest form values one interaction may carry, as UTF-8 JSON.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maxValuesBytes: number;
/**
 * The largest view state, as UTF-8 JSON.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maxStateBytes: number;
/**
 * The largest HTML one render may produce, in UTF-8 bytes.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maxHtmlBytes: number;
/**
 * How many interactions the page admits from one frame in any second.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maxInteractionsPerSecond = 10;
/**
 * The most form values one interaction may carry.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maxValues = 64;
/**
 * The shortest and tallest an `inline` view's frame may be, in CSS pixels.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const inlineHeight: {
    readonly min: 80;
    readonly max: 480;
};
/**
 * The tallest height a frame may report. A larger report is malformed.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maxReportedHeight = 1000000;
/**
 * Where a view shows: `inline` in the message, `full` on its own page.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Size: Schema.Literals<readonly ["inline", "full"]>;
/**
 * Where a view shows.
 *
 * @category models
 * @since 0.1.0
 */
export type Size = typeof Size.Type;
/**
 * The page's color theme, as the frame applies it.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Theme: Schema.Literals<readonly ["light", "dark"]>;
/**
 * The page's color theme.
 *
 * @category models
 * @since 0.1.0
 */
export type Theme = typeof Theme.Type;
/**
 * The per-mount secret the page writes into the frame's document. Only the
 * frame it wrote can answer with it.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Nonce: Schema.String;
/**
 * `ui/initialize`: the frame's first and only window message.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Initialize: Schema.Struct<{
    readonly jsonrpc: Schema.Literal<"2.0">;
    readonly id: Schema.Union<readonly [Schema.String, Schema.Int]>;
    readonly method: Schema.Literal<"ui/initialize">;
    readonly params: Schema.Struct<{
        readonly nonce: Schema.String;
    }>;
}>;
/**
 * `ui/initialize`.
 *
 * @category models
 * @since 0.1.0
 */
export type Initialize = typeof Initialize.Type;
/**
 * What the frame needs to show the view: the sanitized-on-arrival HTML, the
 * theme, and the size it shows at.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const HostContext: Schema.Struct<{
    readonly html: Schema.String;
    readonly theme: Schema.Literals<readonly ["light", "dark"]>;
    readonly size: Schema.Literals<readonly ["inline", "full"]>;
}>;
/**
 * What the frame needs to show the view.
 *
 * @category models
 * @since 0.1.0
 */
export type HostContext = typeof HostContext.Type;
/**
 * The page's answer to `ui/initialize`, posted with the port it transfers.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const InitializeResult: Schema.Struct<{
    readonly jsonrpc: Schema.Literal<"2.0">;
    readonly id: Schema.Union<readonly [Schema.String, Schema.Int]>;
    readonly result: Schema.Struct<{
        readonly html: Schema.String;
        readonly theme: Schema.Literals<readonly ["light", "dark"]>;
        readonly size: Schema.Literals<readonly ["inline", "full"]>;
    }>;
}>;
/**
 * The page's answer to `ui/initialize`.
 *
 * @category models
 * @since 0.1.0
 */
export type InitializeResult = typeof InitializeResult.Type;
/**
 * `ui/notifications/host-context-changed`: new HTML, a new theme, or both.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const HostContextChanged: Schema.Struct<{
    readonly jsonrpc: Schema.Literal<"2.0">;
    readonly method: Schema.Literal<"ui/notifications/host-context-changed">;
    readonly params: Schema.Struct<{
        readonly html: Schema.optionalKey<Schema.String>;
        readonly theme: Schema.optionalKey<Schema.Literals<readonly ["light", "dark"]>>;
    }>;
}>;
/**
 * `ui/notifications/host-context-changed`.
 *
 * @category models
 * @since 0.1.0
 */
export type HostContextChanged = typeof HostContextChanged.Type;
/**
 * `ui/notifications/size-changed`: the content's height in CSS pixels.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const SizeChanged: Schema.Struct<{
    readonly jsonrpc: Schema.Literal<"2.0">;
    readonly method: Schema.Literal<"ui/notifications/size-changed">;
    readonly params: Schema.Struct<{
        readonly height: Schema.Number;
    }>;
}>;
/**
 * `ui/notifications/size-changed`.
 *
 * @category models
 * @since 0.1.0
 */
export type SizeChanged = typeof SizeChanged.Type;
/**
 * One form value an interaction carries.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Value: Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean]>;
/**
 * The form values an interaction carries, by field name.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Values: Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean]>>;
/**
 * The form values an interaction carries.
 *
 * @category models
 * @since 0.1.0
 */
export type Values = typeof Values.Type;
/**
 * `smithers/interaction`: a real click or submit on a `data-event` element.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Interaction: Schema.Struct<{
    readonly jsonrpc: Schema.Literal<"2.0">;
    readonly method: Schema.Literal<"smithers/interaction">;
    readonly params: Schema.Struct<{
        readonly event: Schema.String;
        readonly arg: Schema.optionalKey<Schema.String>;
        readonly values: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean]>>>;
    }>;
}>;
/**
 * `smithers/interaction`.
 *
 * @category models
 * @since 0.1.0
 */
export type Interaction = typeof Interaction.Type;
/**
 * Every message the frame sends over its port.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const FrameMessage: Schema.Union<readonly [Schema.Struct<{
    readonly jsonrpc: Schema.Literal<"2.0">;
    readonly method: Schema.Literal<"ui/notifications/size-changed">;
    readonly params: Schema.Struct<{
        readonly height: Schema.Number;
    }>;
}>, Schema.Struct<{
    readonly jsonrpc: Schema.Literal<"2.0">;
    readonly method: Schema.Literal<"smithers/interaction">;
    readonly params: Schema.Struct<{
        readonly event: Schema.String;
        readonly arg: Schema.optionalKey<Schema.String>;
        readonly values: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean]>>>;
    }>;
}>]>;
/**
 * Every message the frame sends over its port.
 *
 * @category models
 * @since 0.1.0
 */
export type FrameMessage = typeof FrameMessage.Type;
/**
 * Why the page refused a message:
 *
 * - `wrong_source`: a window message that did not come from this mount's frame
 *   with its nonce;
 * - `malformed`: not one of the bridge's messages;
 * - `too_large`: form values over {@link maxValuesBytes};
 * - `undeclared`: an event the view did not declare;
 * - `rate_limited`: more than {@link maxInteractionsPerSecond} interactions in
 *   one second.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Refusal: Schema.Literals<readonly ["wrong_source", "malformed", "too_large", "undeclared", "rate_limited"]>;
/**
 * Why the page refused a message.
 *
 * @category models
 * @since 0.1.0
 */
export type Refusal = typeof Refusal.Type;
/**
 * What the page does with one message from the frame.
 *
 * @category models
 * @since 0.1.0
 */
export type Verdict = {
    readonly _tag: "Resize";
    readonly height: number;
} | {
    readonly _tag: "State";
    readonly event: Interactions.Event;
} | {
    readonly _tag: "Message";
    readonly event: Interactions.Event;
    readonly label: string;
    readonly values: Values;
} | {
    readonly _tag: "Refused";
    readonly reason: Refusal;
};
/**
 * The times, in milliseconds, of the interactions admitted in the last
 * second. Start with an empty array.
 *
 * @category models
 * @since 0.1.0
 */
export type RateWindow = ReadonlyArray<number>;
/**
 * Decides what to do with one message from a frame's port.
 *
 * `now` is the page's clock in milliseconds. The returned `window` replaces
 * the one passed in. A refused interaction does not count against the rate.
 *
 * @category receiving
 * @since 0.1.0
 */
export declare const receive: (input: {
    readonly message: unknown;
    readonly declared: Interactions.Declared;
    readonly window: RateWindow;
    readonly now: number;
}) => {
    readonly verdict: Verdict;
    readonly window: RateWindow;
};
/**
 * Checks the frame's `ui/initialize`: it must decode and carry `nonce`. The
 * caller checks the other half, that the message came from this mount's
 * frame (`event.source === iframe.contentWindow`); an opaque `null` origin is
 * never identity.
 *
 * @category receiving
 * @since 0.1.0
 */
export declare const acceptInitialize: (message: unknown, nonce: string) => Option.Option<Initialize>;
/**
 * The reply to an accepted `ui/initialize`.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const initializeResult: (initialize: Initialize, context: HostContext) => InitializeResult;
/**
 * A `ui/notifications/host-context-changed` notification.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const hostContextChanged: (params: HostContextChanged["params"]) => HostContextChanged;
/**
 * The height an `inline` frame takes for a reported content height: clamped
 * to {@link inlineHeight}.
 *
 * @category sizing
 * @since 0.1.0
 */
export declare const inlineFrameHeight: (reported: number) => number;
