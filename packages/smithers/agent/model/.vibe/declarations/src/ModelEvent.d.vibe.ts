/**
 * The normalized events one model call emits, and the fold that turns them
 * back into a single durable assistant message.
 *
 * Every protocol lowers its own wire vocabulary into these events, so a
 * consumer reads one stream shape whichever provider answered.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
import { AssistantMessage } from "./ModelRequest.ts";
/**
 * Token counts a provider reports for one request. Every field is
 * optional: providers disagree on which counters they expose, and a missing
 * count is not a zero count.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const Usage: Schema.Struct<{
    readonly inputTokens: Schema.optional<Schema.Number>;
    readonly outputTokens: Schema.optional<Schema.Number>;
    readonly reasoningTokens: Schema.optional<Schema.Number>;
    readonly cachedInputTokens: Schema.optional<Schema.Number>;
    readonly cacheWriteTokens: Schema.optional<Schema.Number>;
    readonly totalTokens: Schema.optional<Schema.Number>;
    /** The USD charge the provider itself reported for the call, when it reports one. */
    readonly costUsd: Schema.optional<Schema.Number>;
}> & {
    make: (input: Usage) => Usage;
};
/**
 * The decoded token counts of {@link Usage}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Usage = typeof Usage.Type;
/**
 * Opens a text part. Its `id` correlates the later deltas and end event
 * that belong to the same part.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const TextStart: Schema.Struct<{
    readonly type: Schema.Literal<"text-start">;
    readonly id: Schema.String;
}>;
/**
 * The decoded form of {@link TextStart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TextStart = typeof TextStart.Type;
/**
 * One incremental chunk of a text part's content.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const TextDelta: Schema.Struct<{
    readonly type: Schema.Literal<"text-delta">;
    readonly id: Schema.String;
    readonly text: Schema.String;
}>;
/**
 * The decoded form of {@link TextDelta}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TextDelta = typeof TextDelta.Type;
/**
 * Closes the text part opened by the matching {@link TextStart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const TextEnd: Schema.Struct<{
    readonly type: Schema.Literal<"text-end">;
    readonly id: Schema.String;
}>;
/**
 * The decoded form of {@link TextEnd}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TextEnd = typeof TextEnd.Type;
/**
 * Opens a reasoning part. `signature` carries the provider's attestation
 * for the block, which a later request must echo back verbatim.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ThinkingStart: Schema.Struct<{
    readonly type: Schema.Literal<"thinking-start">;
    readonly id: Schema.String;
    readonly signature: Schema.optional<Schema.String>;
}>;
/**
 * The decoded form of {@link ThinkingStart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ThinkingStart = typeof ThinkingStart.Type;
/**
 * One incremental chunk of a reasoning part's content.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ThinkingDelta: Schema.Struct<{
    readonly type: Schema.Literal<"thinking-delta">;
    readonly id: Schema.String;
    readonly text: Schema.String;
}>;
/**
 * The decoded form of {@link ThinkingDelta}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ThinkingDelta = typeof ThinkingDelta.Type;
/**
 * Closes the reasoning part opened by the matching {@link ThinkingStart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ThinkingEnd: Schema.Struct<{
    readonly type: Schema.Literal<"thinking-end">;
    readonly id: Schema.String;
}>;
/**
 * The decoded form of {@link ThinkingEnd}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ThinkingEnd = typeof ThinkingEnd.Type;
/**
 * Opens a tool call and names the tool. The arguments arrive as deltas.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ToolCallStart: Schema.Struct<{
    readonly type: Schema.Literal<"tool-call-start">;
    readonly id: Schema.String;
    readonly name: Schema.String;
}>;
/**
 * The decoded form of {@link ToolCallStart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolCallStart = typeof ToolCallStart.Type;
/**
 * One incremental chunk of a tool call's JSON argument text.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ToolCallDelta: Schema.Struct<{
    readonly type: Schema.Literal<"tool-call-delta">;
    readonly id: Schema.String;
    readonly arguments: Schema.String;
}>;
/**
 * The decoded form of {@link ToolCallDelta}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolCallDelta = typeof ToolCallDelta.Type;
/**
 * Closes a tool call. `arguments` repeats the complete argument text when
 * the provider sends it, which lets a consumer skip reassembling deltas.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ToolCallEnd: Schema.Struct<{
    readonly type: Schema.Literal<"tool-call-end">;
    readonly id: Schema.String;
    readonly arguments: Schema.optional<Schema.String>;
}>;
/**
 * The decoded form of {@link ToolCallEnd}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolCallEnd = typeof ToolCallEnd.Type;
/**
 * The result of an executed tool call, as reported by a harness. Tool output
 * is not part of the settled assistant message; it renders alongside the call
 * and feeds the next request's tool message.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ToolResult: Schema.Struct<{
    readonly type: Schema.Literal<"tool-result">;
    readonly id: Schema.String;
    readonly output: Schema.String;
    readonly isError: Schema.optional<Schema.Boolean>;
}>;
/**
 * The decoded form of {@link ToolResult}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolResult = typeof ToolResult.Type;
/**
 * Reports token counts mid-stream. The same counters as {@link Usage},
 * carried as a stream event.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const UsageEvent: Schema.Struct<{
    readonly type: Schema.Literal<"usage">;
    readonly inputTokens: Schema.optional<Schema.Number>;
    readonly outputTokens: Schema.optional<Schema.Number>;
    readonly reasoningTokens: Schema.optional<Schema.Number>;
    readonly cachedInputTokens: Schema.optional<Schema.Number>;
    readonly cacheWriteTokens: Schema.optional<Schema.Number>;
    readonly totalTokens: Schema.optional<Schema.Number>;
    readonly costUsd: Schema.optional<Schema.Number>;
}>;
/**
 * The decoded form of {@link UsageEvent}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type UsageEvent = typeof UsageEvent.Type;
/**
 * A bounded model-boundary retry, recorded so run reports can count transport recovery.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Retry: Schema.Struct<{
    readonly type: Schema.Literal<"retry">;
    readonly attempt: Schema.Int;
    readonly code: Schema.String;
    /**
     * Milliseconds the boundary waited before this attempt, as the retry
     * schedule decided it on the injected clock.
     *
     * Recording the count alone was not enough to tell a working backoff from a
     * broken one. Every retry of one sealed step is buffered and journaled
     * together when the step settles, so two retries carry the same journal
     * timestamp whether they were seconds apart or instantaneous — a wave report
     * reading those timestamps cannot see the schedule at all. The delay is
     * therefore stated by the event that took it. Zero is what a record written
     * before this field carried, and what an unscheduled retry means.
     */
    readonly delayMillis: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.Number>, never>;
    /**
     * Milliseconds the failed attempt ran before it failed. The journal stamps
     * every retry of one step with the same instant, so without this a report
     * cannot tell an attempt refused at once from one cut off after minutes.
     * Absent when the boundary that retried did not time the attempt.
     */
    readonly elapsedMs: Schema.optional<Schema.Number>;
    /** The HTTP status that failed the attempt, when a response carried one. */
    readonly httpStatus: Schema.optional<Schema.Number>;
}>;
/**
 * The decoded form of {@link Retry}.
 *
 * @category models
 * @since 0.1.0
 */
export type Retry = typeof Retry.Type;
/**
 * One HTTP try of a model call that failed and was tried again inside the
 * call. Offsets are whole milliseconds from the start of the call.
 *
 * @category models
 * @since 1.0.0
 */
export declare const FailedTry: Schema.Struct<{
    /** The try's request was handed to the HTTP client. */
    readonly sentMs: Schema.optional<Schema.Number>;
    /** The try failed. */
    readonly failedMs: Schema.Number;
    /** Why: a `ModelError` code, or the code of a kernel permission failure. */
    readonly code: Schema.String;
    /** The HTTP status that failed it, when a response carried one. */
    readonly httpStatus: Schema.optional<Schema.Number>;
}>;
/**
 * The decoded form of {@link FailedTry}.
 *
 * @category models
 * @since 1.0.0
 */
export type FailedTry = typeof FailedTry.Type;
/**
 * Where one model call's time went on the wire. Every offset is whole
 * milliseconds from the start of the call, read on Effect's `Clock`.
 *
 * Every field is optional: a stage the transport or the protocol cannot
 * observe is absent, and an absent stage is not a zero. A call with no
 * thinking has no `firstThinkingMs`; a model that is not an HTTP route (a
 * wrapped CLI) reports only the stages it sees.
 *
 * @category models
 * @since 1.0.0
 */
export declare const Timing: Schema.Struct<{
    /**
     * When the call started, in epoch milliseconds: the instant every offset
     * below counts from, so a report can place the call on a run's timeline.
     */
    readonly startedAt: Schema.optional<Schema.Number>;
    /** HTTP tries, including the one that was answered. */
    readonly attempts: Schema.optional<Schema.Int>;
    /** Bytes of the request body sent. */
    readonly requestBytes: Schema.optional<Schema.Number>;
    /** The request was validated and encoded to the bytes that are sent. */
    readonly preparedMs: Schema.optional<Schema.Number>;
    /** The credential was resolved and the request signed. */
    readonly signedMs: Schema.optional<Schema.Number>;
    /**
     * The answered try's request was handed to the HTTP client. The client does
     * not report the socket write, so the upload lies between this and
     * `headersMs`.
     */
    readonly sentMs: Schema.optional<Schema.Number>;
    /** The response status and headers arrived. */
    readonly headersMs: Schema.optional<Schema.Number>;
    /** The first stream event of any kind arrived. */
    readonly firstEventMs: Schema.optional<Schema.Number>;
    /** The first thinking event; absent when the call emitted none. */
    readonly firstThinkingMs: Schema.optional<Schema.Number>;
    /** The first text or tool-call delta; absent when the call emitted none. */
    readonly firstOutputMs: Schema.optional<Schema.Number>;
    /** The last text or tool-call delta; absent when the call emitted none. */
    readonly lastOutputMs: Schema.optional<Schema.Number>;
    /** The provider's terminal event: the one the settlement is read from. */
    readonly completedMs: Schema.optional<Schema.Number>;
    /** The response stream closed. */
    readonly closedMs: Schema.optional<Schema.Number>;
    /** The tries that failed before the answered one, oldest first. */
    readonly failedTries: Schema.optional<Schema.$Array<Schema.Struct<{
        /** The try's request was handed to the HTTP client. */
        readonly sentMs: Schema.optional<Schema.Number>;
        /** The try failed. */
        readonly failedMs: Schema.Number;
        /** Why: a `ModelError` code, or the code of a kernel permission failure. */
        readonly code: Schema.String;
        /** The HTTP status that failed it, when a response carried one. */
        readonly httpStatus: Schema.optional<Schema.Number>;
    }>>>;
}>;
/**
 * The decoded form of {@link Timing}.
 *
 * @category models
 * @since 1.0.0
 */
export type Timing = typeof Timing.Type;
/**
 * Ends the stream and states why. A stream without one was interrupted.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const Settle: Schema.Struct<{
    readonly type: Schema.Literal<"settle">;
    readonly stopReason: Schema.Literals<readonly ["stop", "length", "tool-calls", "content-filter", "error", "aborted", "unknown"]>;
    readonly responseId: Schema.optional<Schema.String>;
    /** The service tier that served the call, as the provider reported it. */
    readonly servedTier: Schema.optional<Schema.String>;
    /** Where the call's time went on the wire; absent on a record written before it was measured. */
    readonly timing: Schema.optional<Schema.Struct<{
        /**
         * When the call started, in epoch milliseconds: the instant every offset
         * below counts from, so a report can place the call on a run's timeline.
         */
        readonly startedAt: Schema.optional<Schema.Number>;
        /** HTTP tries, including the one that was answered. */
        readonly attempts: Schema.optional<Schema.Int>;
        /** Bytes of the request body sent. */
        readonly requestBytes: Schema.optional<Schema.Number>;
        /** The request was validated and encoded to the bytes that are sent. */
        readonly preparedMs: Schema.optional<Schema.Number>;
        /** The credential was resolved and the request signed. */
        readonly signedMs: Schema.optional<Schema.Number>;
        /**
         * The answered try's request was handed to the HTTP client. The client does
         * not report the socket write, so the upload lies between this and
         * `headersMs`.
         */
        readonly sentMs: Schema.optional<Schema.Number>;
        /** The response status and headers arrived. */
        readonly headersMs: Schema.optional<Schema.Number>;
        /** The first stream event of any kind arrived. */
        readonly firstEventMs: Schema.optional<Schema.Number>;
        /** The first thinking event; absent when the call emitted none. */
        readonly firstThinkingMs: Schema.optional<Schema.Number>;
        /** The first text or tool-call delta; absent when the call emitted none. */
        readonly firstOutputMs: Schema.optional<Schema.Number>;
        /** The last text or tool-call delta; absent when the call emitted none. */
        readonly lastOutputMs: Schema.optional<Schema.Number>;
        /** The provider's terminal event: the one the settlement is read from. */
        readonly completedMs: Schema.optional<Schema.Number>;
        /** The response stream closed. */
        readonly closedMs: Schema.optional<Schema.Number>;
        /** The tries that failed before the answered one, oldest first. */
        readonly failedTries: Schema.optional<Schema.$Array<Schema.Struct<{
            /** The try's request was handed to the HTTP client. */
            readonly sentMs: Schema.optional<Schema.Number>;
            /** The try failed. */
            readonly failedMs: Schema.Number;
            /** Why: a `ModelError` code, or the code of a kernel permission failure. */
            readonly code: Schema.String;
            /** The HTTP status that failed it, when a response carried one. */
            readonly httpStatus: Schema.optional<Schema.Number>;
        }>>>;
    }>>;
    /** The vendor session that answered, for a seat that is a wrapped CLI: `claude --resume <sessionId>`. */
    readonly sessionId: Schema.optional<Schema.String>;
    /**
     * Stored provider reasoning items required for replay-safe continuation: a
     * provider that keeps reasoning server side answers the next request with
     * these ids rather than the text they stand for.
     */
    readonly itemIds: Schema.optional<Schema.$Array<Schema.String>>;
}>;
/**
 * The decoded form of {@link Settle}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Settle = typeof Settle.Type;
/**
 * Every event a model stream can emit, tagged by `type`, with a constructor
 * per member and {@link settledMessage} attached.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ModelEvent: Schema.Union<readonly [Schema.Struct<{
    readonly type: Schema.Literal<"text-start">;
    readonly id: Schema.String;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"text-delta">;
    readonly id: Schema.String;
    readonly text: Schema.String;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"text-end">;
    readonly id: Schema.String;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"thinking-start">;
    readonly id: Schema.String;
    readonly signature: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"thinking-delta">;
    readonly id: Schema.String;
    readonly text: Schema.String;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"thinking-end">;
    readonly id: Schema.String;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"tool-call-start">;
    readonly id: Schema.String;
    readonly name: Schema.String;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"tool-call-delta">;
    readonly id: Schema.String;
    readonly arguments: Schema.String;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"tool-call-end">;
    readonly id: Schema.String;
    readonly arguments: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"tool-result">;
    readonly id: Schema.String;
    readonly output: Schema.String;
    readonly isError: Schema.optional<Schema.Boolean>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"usage">;
    readonly inputTokens: Schema.optional<Schema.Number>;
    readonly outputTokens: Schema.optional<Schema.Number>;
    readonly reasoningTokens: Schema.optional<Schema.Number>;
    readonly cachedInputTokens: Schema.optional<Schema.Number>;
    readonly cacheWriteTokens: Schema.optional<Schema.Number>;
    readonly totalTokens: Schema.optional<Schema.Number>;
    readonly costUsd: Schema.optional<Schema.Number>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"retry">;
    readonly attempt: Schema.Int;
    readonly code: Schema.String;
    /**
     * Milliseconds the boundary waited before this attempt, as the retry
     * schedule decided it on the injected clock.
     *
     * Recording the count alone was not enough to tell a working backoff from a
     * broken one. Every retry of one sealed step is buffered and journaled
     * together when the step settles, so two retries carry the same journal
     * timestamp whether they were seconds apart or instantaneous — a wave report
     * reading those timestamps cannot see the schedule at all. The delay is
     * therefore stated by the event that took it. Zero is what a record written
     * before this field carried, and what an unscheduled retry means.
     */
    readonly delayMillis: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.Number>, never>;
    /**
     * Milliseconds the failed attempt ran before it failed. The journal stamps
     * every retry of one step with the same instant, so without this a report
     * cannot tell an attempt refused at once from one cut off after minutes.
     * Absent when the boundary that retried did not time the attempt.
     */
    readonly elapsedMs: Schema.optional<Schema.Number>;
    /** The HTTP status that failed the attempt, when a response carried one. */
    readonly httpStatus: Schema.optional<Schema.Number>;
}>, Schema.Struct<{
    readonly type: Schema.Literal<"settle">;
    readonly stopReason: Schema.Literals<readonly ["stop", "length", "tool-calls", "content-filter", "error", "aborted", "unknown"]>;
    readonly responseId: Schema.optional<Schema.String>;
    /** The service tier that served the call, as the provider reported it. */
    readonly servedTier: Schema.optional<Schema.String>;
    /** Where the call's time went on the wire; absent on a record written before it was measured. */
    readonly timing: Schema.optional<Schema.Struct<{
        /**
         * When the call started, in epoch milliseconds: the instant every offset
         * below counts from, so a report can place the call on a run's timeline.
         */
        readonly startedAt: Schema.optional<Schema.Number>;
        /** HTTP tries, including the one that was answered. */
        readonly attempts: Schema.optional<Schema.Int>;
        /** Bytes of the request body sent. */
        readonly requestBytes: Schema.optional<Schema.Number>;
        /** The request was validated and encoded to the bytes that are sent. */
        readonly preparedMs: Schema.optional<Schema.Number>;
        /** The credential was resolved and the request signed. */
        readonly signedMs: Schema.optional<Schema.Number>;
        /**
         * The answered try's request was handed to the HTTP client. The client does
         * not report the socket write, so the upload lies between this and
         * `headersMs`.
         */
        readonly sentMs: Schema.optional<Schema.Number>;
        /** The response status and headers arrived. */
        readonly headersMs: Schema.optional<Schema.Number>;
        /** The first stream event of any kind arrived. */
        readonly firstEventMs: Schema.optional<Schema.Number>;
        /** The first thinking event; absent when the call emitted none. */
        readonly firstThinkingMs: Schema.optional<Schema.Number>;
        /** The first text or tool-call delta; absent when the call emitted none. */
        readonly firstOutputMs: Schema.optional<Schema.Number>;
        /** The last text or tool-call delta; absent when the call emitted none. */
        readonly lastOutputMs: Schema.optional<Schema.Number>;
        /** The provider's terminal event: the one the settlement is read from. */
        readonly completedMs: Schema.optional<Schema.Number>;
        /** The response stream closed. */
        readonly closedMs: Schema.optional<Schema.Number>;
        /** The tries that failed before the answered one, oldest first. */
        readonly failedTries: Schema.optional<Schema.$Array<Schema.Struct<{
            /** The try's request was handed to the HTTP client. */
            readonly sentMs: Schema.optional<Schema.Number>;
            /** The try failed. */
            readonly failedMs: Schema.Number;
            /** Why: a `ModelError` code, or the code of a kernel permission failure. */
            readonly code: Schema.String;
            /** The HTTP status that failed it, when a response carried one. */
            readonly httpStatus: Schema.optional<Schema.Number>;
        }>>>;
    }>>;
    /** The vendor session that answered, for a seat that is a wrapped CLI: `claude --resume <sessionId>`. */
    readonly sessionId: Schema.optional<Schema.String>;
    /**
     * Stored provider reasoning items required for replay-safe continuation: a
     * provider that keeps reasoning server side answers the next request with
     * these ids rather than the text they stand for.
     */
    readonly itemIds: Schema.optional<Schema.$Array<Schema.String>>;
}>]> & {
    readonly tag: "type";
    readonly discriminants: readonly ["text-start", "text-delta", "text-end", "thinking-start", "thinking-delta", "thinking-end", "tool-call-start", "tool-call-delta", "tool-call-end", "tool-result", "usage", "retry", "settle"];
    readonly cases: {
        retry: Schema.Struct<{
            readonly type: Schema.Literal<"retry">;
            readonly attempt: Schema.Int;
            readonly code: Schema.String;
            /**
             * Milliseconds the boundary waited before this attempt, as the retry
             * schedule decided it on the injected clock.
             *
             * Recording the count alone was not enough to tell a working backoff from a
             * broken one. Every retry of one sealed step is buffered and journaled
             * together when the step settles, so two retries carry the same journal
             * timestamp whether they were seconds apart or instantaneous — a wave report
             * reading those timestamps cannot see the schedule at all. The delay is
             * therefore stated by the event that took it. Zero is what a record written
             * before this field carried, and what an unscheduled retry means.
             */
            readonly delayMillis: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.Number>, never>;
            /**
             * Milliseconds the failed attempt ran before it failed. The journal stamps
             * every retry of one step with the same instant, so without this a report
             * cannot tell an attempt refused at once from one cut off after minutes.
             * Absent when the boundary that retried did not time the attempt.
             */
            readonly elapsedMs: Schema.optional<Schema.Number>;
            /** The HTTP status that failed the attempt, when a response carried one. */
            readonly httpStatus: Schema.optional<Schema.Number>;
        }>;
        settle: Schema.Struct<{
            readonly type: Schema.Literal<"settle">;
            readonly stopReason: Schema.Literals<readonly ["stop", "length", "tool-calls", "content-filter", "error", "aborted", "unknown"]>;
            readonly responseId: Schema.optional<Schema.String>;
            /** The service tier that served the call, as the provider reported it. */
            readonly servedTier: Schema.optional<Schema.String>;
            /** Where the call's time went on the wire; absent on a record written before it was measured. */
            readonly timing: Schema.optional<Schema.Struct<{
                /**
                 * When the call started, in epoch milliseconds: the instant every offset
                 * below counts from, so a report can place the call on a run's timeline.
                 */
                readonly startedAt: Schema.optional<Schema.Number>;
                /** HTTP tries, including the one that was answered. */
                readonly attempts: Schema.optional<Schema.Int>;
                /** Bytes of the request body sent. */
                readonly requestBytes: Schema.optional<Schema.Number>;
                /** The request was validated and encoded to the bytes that are sent. */
                readonly preparedMs: Schema.optional<Schema.Number>;
                /** The credential was resolved and the request signed. */
                readonly signedMs: Schema.optional<Schema.Number>;
                /**
                 * The answered try's request was handed to the HTTP client. The client does
                 * not report the socket write, so the upload lies between this and
                 * `headersMs`.
                 */
                readonly sentMs: Schema.optional<Schema.Number>;
                /** The response status and headers arrived. */
                readonly headersMs: Schema.optional<Schema.Number>;
                /** The first stream event of any kind arrived. */
                readonly firstEventMs: Schema.optional<Schema.Number>;
                /** The first thinking event; absent when the call emitted none. */
                readonly firstThinkingMs: Schema.optional<Schema.Number>;
                /** The first text or tool-call delta; absent when the call emitted none. */
                readonly firstOutputMs: Schema.optional<Schema.Number>;
                /** The last text or tool-call delta; absent when the call emitted none. */
                readonly lastOutputMs: Schema.optional<Schema.Number>;
                /** The provider's terminal event: the one the settlement is read from. */
                readonly completedMs: Schema.optional<Schema.Number>;
                /** The response stream closed. */
                readonly closedMs: Schema.optional<Schema.Number>;
                /** The tries that failed before the answered one, oldest first. */
                readonly failedTries: Schema.optional<Schema.$Array<Schema.Struct<{
                    /** The try's request was handed to the HTTP client. */
                    readonly sentMs: Schema.optional<Schema.Number>;
                    /** The try failed. */
                    readonly failedMs: Schema.Number;
                    /** Why: a `ModelError` code, or the code of a kernel permission failure. */
                    readonly code: Schema.String;
                    /** The HTTP status that failed it, when a response carried one. */
                    readonly httpStatus: Schema.optional<Schema.Number>;
                }>>>;
            }>>;
            /** The vendor session that answered, for a seat that is a wrapped CLI: `claude --resume <sessionId>`. */
            readonly sessionId: Schema.optional<Schema.String>;
            /**
             * Stored provider reasoning items required for replay-safe continuation: a
             * provider that keeps reasoning server side answers the next request with
             * these ids rather than the text they stand for.
             */
            readonly itemIds: Schema.optional<Schema.$Array<Schema.String>>;
        }>;
        "text-delta": Schema.Struct<{
            readonly type: Schema.Literal<"text-delta">;
            readonly id: Schema.String;
            readonly text: Schema.String;
        }>;
        "text-end": Schema.Struct<{
            readonly type: Schema.Literal<"text-end">;
            readonly id: Schema.String;
        }>;
        "text-start": Schema.Struct<{
            readonly type: Schema.Literal<"text-start">;
            readonly id: Schema.String;
        }>;
        "thinking-delta": Schema.Struct<{
            readonly type: Schema.Literal<"thinking-delta">;
            readonly id: Schema.String;
            readonly text: Schema.String;
        }>;
        "thinking-end": Schema.Struct<{
            readonly type: Schema.Literal<"thinking-end">;
            readonly id: Schema.String;
        }>;
        "thinking-start": Schema.Struct<{
            readonly type: Schema.Literal<"thinking-start">;
            readonly id: Schema.String;
            readonly signature: Schema.optional<Schema.String>;
        }>;
        "tool-call-delta": Schema.Struct<{
            readonly type: Schema.Literal<"tool-call-delta">;
            readonly id: Schema.String;
            readonly arguments: Schema.String;
        }>;
        "tool-call-end": Schema.Struct<{
            readonly type: Schema.Literal<"tool-call-end">;
            readonly id: Schema.String;
            readonly arguments: Schema.optional<Schema.String>;
        }>;
        "tool-call-start": Schema.Struct<{
            readonly type: Schema.Literal<"tool-call-start">;
            readonly id: Schema.String;
            readonly name: Schema.String;
        }>;
        "tool-result": Schema.Struct<{
            readonly type: Schema.Literal<"tool-result">;
            readonly id: Schema.String;
            readonly output: Schema.String;
            readonly isError: Schema.optional<Schema.Boolean>;
        }>;
        usage: Schema.Struct<{
            readonly type: Schema.Literal<"usage">;
            readonly inputTokens: Schema.optional<Schema.Number>;
            readonly outputTokens: Schema.optional<Schema.Number>;
            readonly reasoningTokens: Schema.optional<Schema.Number>;
            readonly cachedInputTokens: Schema.optional<Schema.Number>;
            readonly cacheWriteTokens: Schema.optional<Schema.Number>;
            readonly totalTokens: Schema.optional<Schema.Number>;
            readonly costUsd: Schema.optional<Schema.Number>;
        }>;
    };
    readonly isAnyOf: <const Keys>(keys: readonly Keys[]) => (value: {
        readonly type: "text-start";
        readonly id: string;
    } | {
        readonly type: "text-delta";
        readonly id: string;
        readonly text: string;
    } | {
        readonly type: "text-end";
        readonly id: string;
    } | {
        readonly type: "thinking-delta";
        readonly id: string;
        readonly text: string;
    } | {
        readonly type: "thinking-end";
        readonly id: string;
    } | {
        readonly type: "tool-call-start";
        readonly id: string;
        readonly name: string;
    } | {
        readonly type: "tool-call-delta";
        readonly id: string;
        readonly arguments: string;
    } | {
        readonly type: "thinking-start";
        readonly id: string;
        readonly signature?: string | undefined;
    } | {
        readonly type: "tool-call-end";
        readonly id: string;
        readonly arguments?: string | undefined;
    } | {
        readonly type: "tool-result";
        readonly id: string;
        readonly output: string;
        readonly isError?: boolean | undefined;
    } | {
        readonly type: "usage";
        readonly inputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
        readonly reasoningTokens?: number | undefined;
        readonly cachedInputTokens?: number | undefined;
        readonly cacheWriteTokens?: number | undefined;
        readonly totalTokens?: number | undefined;
        readonly costUsd?: number | undefined;
    } | {
        readonly type: "retry";
        readonly attempt: number;
        readonly code: string;
        readonly delayMillis: number;
        readonly elapsedMs?: number | undefined;
        readonly httpStatus?: number | undefined;
    } | {
        readonly type: "settle";
        readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
        readonly responseId?: string | undefined;
        readonly servedTier?: string | undefined;
        readonly timing?: {
            readonly startedAt?: number | undefined;
            readonly attempts?: number | undefined;
            readonly requestBytes?: number | undefined;
            readonly preparedMs?: number | undefined;
            readonly signedMs?: number | undefined;
            readonly sentMs?: number | undefined;
            readonly headersMs?: number | undefined;
            readonly firstEventMs?: number | undefined;
            readonly firstThinkingMs?: number | undefined;
            readonly firstOutputMs?: number | undefined;
            readonly lastOutputMs?: number | undefined;
            readonly completedMs?: number | undefined;
            readonly closedMs?: number | undefined;
            readonly failedTries?: readonly {
                readonly sentMs?: number | undefined;
                readonly failedMs: number;
                readonly code: string;
                readonly httpStatus?: number | undefined;
            }[] | undefined;
        } | undefined;
        readonly sessionId?: string | undefined;
        readonly itemIds?: readonly string[] | undefined;
    }) => value is Extract<{
        readonly type: "text-start";
        readonly id: string;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "text-delta";
        readonly id: string;
        readonly text: string;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "text-end";
        readonly id: string;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "thinking-delta";
        readonly id: string;
        readonly text: string;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "thinking-end";
        readonly id: string;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "tool-call-start";
        readonly id: string;
        readonly name: string;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "tool-call-delta";
        readonly id: string;
        readonly arguments: string;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "thinking-start";
        readonly id: string;
        readonly signature?: string | undefined;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "tool-call-end";
        readonly id: string;
        readonly arguments?: string | undefined;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "tool-result";
        readonly id: string;
        readonly output: string;
        readonly isError?: boolean | undefined;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "usage";
        readonly inputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
        readonly reasoningTokens?: number | undefined;
        readonly cachedInputTokens?: number | undefined;
        readonly cacheWriteTokens?: number | undefined;
        readonly totalTokens?: number | undefined;
        readonly costUsd?: number | undefined;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "retry";
        readonly attempt: number;
        readonly code: string;
        readonly delayMillis: number;
        readonly elapsedMs?: number | undefined;
        readonly httpStatus?: number | undefined;
    }, {
        readonly type: Keys;
    }> | Extract<{
        readonly type: "settle";
        readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
        readonly responseId?: string | undefined;
        readonly servedTier?: string | undefined;
        readonly timing?: {
            readonly startedAt?: number | undefined;
            readonly attempts?: number | undefined;
            readonly requestBytes?: number | undefined;
            readonly preparedMs?: number | undefined;
            readonly signedMs?: number | undefined;
            readonly sentMs?: number | undefined;
            readonly headersMs?: number | undefined;
            readonly firstEventMs?: number | undefined;
            readonly firstThinkingMs?: number | undefined;
            readonly firstOutputMs?: number | undefined;
            readonly lastOutputMs?: number | undefined;
            readonly completedMs?: number | undefined;
            readonly closedMs?: number | undefined;
            readonly failedTries?: readonly {
                readonly sentMs?: number | undefined;
                readonly failedMs: number;
                readonly code: string;
                readonly httpStatus?: number | undefined;
            }[] | undefined;
        } | undefined;
        readonly sessionId?: string | undefined;
        readonly itemIds?: readonly string[] | undefined;
    }, {
        readonly type: Keys;
    }>;
    readonly guards: {
        retry: (u: unknown) => u is {
            readonly type: "retry";
            readonly attempt: number;
            readonly code: string;
            readonly delayMillis: number;
            readonly elapsedMs?: number | undefined;
            readonly httpStatus?: number | undefined;
        };
        settle: (u: unknown) => u is {
            readonly type: "settle";
            readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
            readonly responseId?: string | undefined;
            readonly servedTier?: string | undefined;
            readonly timing?: {
                readonly startedAt?: number | undefined;
                readonly attempts?: number | undefined;
                readonly requestBytes?: number | undefined;
                readonly preparedMs?: number | undefined;
                readonly signedMs?: number | undefined;
                readonly sentMs?: number | undefined;
                readonly headersMs?: number | undefined;
                readonly firstEventMs?: number | undefined;
                readonly firstThinkingMs?: number | undefined;
                readonly firstOutputMs?: number | undefined;
                readonly lastOutputMs?: number | undefined;
                readonly completedMs?: number | undefined;
                readonly closedMs?: number | undefined;
                readonly failedTries?: readonly {
                    readonly sentMs?: number | undefined;
                    readonly failedMs: number;
                    readonly code: string;
                    readonly httpStatus?: number | undefined;
                }[] | undefined;
            } | undefined;
            readonly sessionId?: string | undefined;
            readonly itemIds?: readonly string[] | undefined;
        };
        "text-delta": (u: unknown) => u is {
            readonly type: "text-delta";
            readonly id: string;
            readonly text: string;
        };
        "text-end": (u: unknown) => u is {
            readonly type: "text-end";
            readonly id: string;
        };
        "text-start": (u: unknown) => u is {
            readonly type: "text-start";
            readonly id: string;
        };
        "thinking-delta": (u: unknown) => u is {
            readonly type: "thinking-delta";
            readonly id: string;
            readonly text: string;
        };
        "thinking-end": (u: unknown) => u is {
            readonly type: "thinking-end";
            readonly id: string;
        };
        "thinking-start": (u: unknown) => u is {
            readonly type: "thinking-start";
            readonly id: string;
            readonly signature?: string | undefined;
        };
        "tool-call-delta": (u: unknown) => u is {
            readonly type: "tool-call-delta";
            readonly id: string;
            readonly arguments: string;
        };
        "tool-call-end": (u: unknown) => u is {
            readonly type: "tool-call-end";
            readonly id: string;
            readonly arguments?: string | undefined;
        };
        "tool-call-start": (u: unknown) => u is {
            readonly type: "tool-call-start";
            readonly id: string;
            readonly name: string;
        };
        "tool-result": (u: unknown) => u is {
            readonly type: "tool-result";
            readonly id: string;
            readonly output: string;
            readonly isError?: boolean | undefined;
        };
        usage: (u: unknown) => u is {
            readonly type: "usage";
            readonly inputTokens?: number | undefined;
            readonly outputTokens?: number | undefined;
            readonly reasoningTokens?: number | undefined;
            readonly cachedInputTokens?: number | undefined;
            readonly cacheWriteTokens?: number | undefined;
            readonly totalTokens?: number | undefined;
            readonly costUsd?: number | undefined;
        };
    };
    readonly match: {
        <Handlers extends { [K in "retry" | "settle" | "text-delta" | "text-end" | "text-start" | "thinking-delta" | "thinking-end" | "thinking-start" | "tool-call-delta" | "tool-call-end" | "tool-call-start" | "tool-result" | "usage"]: (value: {
            readonly retry: Schema.Struct<{
                readonly type: Schema.Literal<"retry">;
                readonly attempt: Schema.Int;
                readonly code: Schema.String;
                /**
                 * Milliseconds the boundary waited before this attempt, as the retry
                 * schedule decided it on the injected clock.
                 *
                 * Recording the count alone was not enough to tell a working backoff from a
                 * broken one. Every retry of one sealed step is buffered and journaled
                 * together when the step settles, so two retries carry the same journal
                 * timestamp whether they were seconds apart or instantaneous — a wave report
                 * reading those timestamps cannot see the schedule at all. The delay is
                 * therefore stated by the event that took it. Zero is what a record written
                 * before this field carried, and what an unscheduled retry means.
                 */
                readonly delayMillis: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.Number>, never>;
                /**
                 * Milliseconds the failed attempt ran before it failed. The journal stamps
                 * every retry of one step with the same instant, so without this a report
                 * cannot tell an attempt refused at once from one cut off after minutes.
                 * Absent when the boundary that retried did not time the attempt.
                 */
                readonly elapsedMs: Schema.optional<Schema.Number>;
                /** The HTTP status that failed the attempt, when a response carried one. */
                readonly httpStatus: Schema.optional<Schema.Number>;
            }>;
            readonly settle: Schema.Struct<{
                readonly type: Schema.Literal<"settle">;
                readonly stopReason: Schema.Literals<readonly ["stop", "length", "tool-calls", "content-filter", "error", "aborted", "unknown"]>;
                readonly responseId: Schema.optional<Schema.String>;
                /** The service tier that served the call, as the provider reported it. */
                readonly servedTier: Schema.optional<Schema.String>;
                /** Where the call's time went on the wire; absent on a record written before it was measured. */
                readonly timing: Schema.optional<Schema.Struct<{
                    /**
                     * When the call started, in epoch milliseconds: the instant every offset
                     * below counts from, so a report can place the call on a run's timeline.
                     */
                    readonly startedAt: Schema.optional<Schema.Number>;
                    /** HTTP tries, including the one that was answered. */
                    readonly attempts: Schema.optional<Schema.Int>;
                    /** Bytes of the request body sent. */
                    readonly requestBytes: Schema.optional<Schema.Number>;
                    /** The request was validated and encoded to the bytes that are sent. */
                    readonly preparedMs: Schema.optional<Schema.Number>;
                    /** The credential was resolved and the request signed. */
                    readonly signedMs: Schema.optional<Schema.Number>;
                    /**
                     * The answered try's request was handed to the HTTP client. The client does
                     * not report the socket write, so the upload lies between this and
                     * `headersMs`.
                     */
                    readonly sentMs: Schema.optional<Schema.Number>;
                    /** The response status and headers arrived. */
                    readonly headersMs: Schema.optional<Schema.Number>;
                    /** The first stream event of any kind arrived. */
                    readonly firstEventMs: Schema.optional<Schema.Number>;
                    /** The first thinking event; absent when the call emitted none. */
                    readonly firstThinkingMs: Schema.optional<Schema.Number>;
                    /** The first text or tool-call delta; absent when the call emitted none. */
                    readonly firstOutputMs: Schema.optional<Schema.Number>;
                    /** The last text or tool-call delta; absent when the call emitted none. */
                    readonly lastOutputMs: Schema.optional<Schema.Number>;
                    /** The provider's terminal event: the one the settlement is read from. */
                    readonly completedMs: Schema.optional<Schema.Number>;
                    /** The response stream closed. */
                    readonly closedMs: Schema.optional<Schema.Number>;
                    /** The tries that failed before the answered one, oldest first. */
                    readonly failedTries: Schema.optional<Schema.$Array<Schema.Struct<{
                        /** The try's request was handed to the HTTP client. */
                        readonly sentMs: Schema.optional<Schema.Number>;
                        /** The try failed. */
                        readonly failedMs: Schema.Number;
                        /** Why: a `ModelError` code, or the code of a kernel permission failure. */
                        readonly code: Schema.String;
                        /** The HTTP status that failed it, when a response carried one. */
                        readonly httpStatus: Schema.optional<Schema.Number>;
                    }>>>;
                }>>;
                /** The vendor session that answered, for a seat that is a wrapped CLI: `claude --resume <sessionId>`. */
                readonly sessionId: Schema.optional<Schema.String>;
                /**
                 * Stored provider reasoning items required for replay-safe continuation: a
                 * provider that keeps reasoning server side answers the next request with
                 * these ids rather than the text they stand for.
                 */
                readonly itemIds: Schema.optional<Schema.$Array<Schema.String>>;
            }>;
            readonly "text-delta": Schema.Struct<{
                readonly type: Schema.Literal<"text-delta">;
                readonly id: Schema.String;
                readonly text: Schema.String;
            }>;
            readonly "text-end": Schema.Struct<{
                readonly type: Schema.Literal<"text-end">;
                readonly id: Schema.String;
            }>;
            readonly "text-start": Schema.Struct<{
                readonly type: Schema.Literal<"text-start">;
                readonly id: Schema.String;
            }>;
            readonly "thinking-delta": Schema.Struct<{
                readonly type: Schema.Literal<"thinking-delta">;
                readonly id: Schema.String;
                readonly text: Schema.String;
            }>;
            readonly "thinking-end": Schema.Struct<{
                readonly type: Schema.Literal<"thinking-end">;
                readonly id: Schema.String;
            }>;
            readonly "thinking-start": Schema.Struct<{
                readonly type: Schema.Literal<"thinking-start">;
                readonly id: Schema.String;
                readonly signature: Schema.optional<Schema.String>;
            }>;
            readonly "tool-call-delta": Schema.Struct<{
                readonly type: Schema.Literal<"tool-call-delta">;
                readonly id: Schema.String;
                readonly arguments: Schema.String;
            }>;
            readonly "tool-call-end": Schema.Struct<{
                readonly type: Schema.Literal<"tool-call-end">;
                readonly id: Schema.String;
                readonly arguments: Schema.optional<Schema.String>;
            }>;
            readonly "tool-call-start": Schema.Struct<{
                readonly type: Schema.Literal<"tool-call-start">;
                readonly id: Schema.String;
                readonly name: Schema.String;
            }>;
            readonly "tool-result": Schema.Struct<{
                readonly type: Schema.Literal<"tool-result">;
                readonly id: Schema.String;
                readonly output: Schema.String;
                readonly isError: Schema.optional<Schema.Boolean>;
            }>;
            readonly usage: Schema.Struct<{
                readonly type: Schema.Literal<"usage">;
                readonly inputTokens: Schema.optional<Schema.Number>;
                readonly outputTokens: Schema.optional<Schema.Number>;
                readonly reasoningTokens: Schema.optional<Schema.Number>;
                readonly cachedInputTokens: Schema.optional<Schema.Number>;
                readonly cacheWriteTokens: Schema.optional<Schema.Number>;
                readonly totalTokens: Schema.optional<Schema.Number>;
                readonly costUsd: Schema.optional<Schema.Number>;
            }>;
        }[K]["Type"]) => any; }>(value: {
            readonly type: "text-start";
            readonly id: string;
        } | {
            readonly type: "text-delta";
            readonly id: string;
            readonly text: string;
        } | {
            readonly type: "text-end";
            readonly id: string;
        } | {
            readonly type: "thinking-delta";
            readonly id: string;
            readonly text: string;
        } | {
            readonly type: "thinking-end";
            readonly id: string;
        } | {
            readonly type: "tool-call-start";
            readonly id: string;
            readonly name: string;
        } | {
            readonly type: "tool-call-delta";
            readonly id: string;
            readonly arguments: string;
        } | {
            readonly type: "thinking-start";
            readonly id: string;
            readonly signature?: string | undefined;
        } | {
            readonly type: "tool-call-end";
            readonly id: string;
            readonly arguments?: string | undefined;
        } | {
            readonly type: "tool-result";
            readonly id: string;
            readonly output: string;
            readonly isError?: boolean | undefined;
        } | {
            readonly type: "usage";
            readonly inputTokens?: number | undefined;
            readonly outputTokens?: number | undefined;
            readonly reasoningTokens?: number | undefined;
            readonly cachedInputTokens?: number | undefined;
            readonly cacheWriteTokens?: number | undefined;
            readonly totalTokens?: number | undefined;
            readonly costUsd?: number | undefined;
        } | {
            readonly type: "retry";
            readonly attempt: number;
            readonly code: string;
            readonly delayMillis: number;
            readonly elapsedMs?: number | undefined;
            readonly httpStatus?: number | undefined;
        } | {
            readonly type: "settle";
            readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
            readonly responseId?: string | undefined;
            readonly servedTier?: string | undefined;
            readonly timing?: {
                readonly startedAt?: number | undefined;
                readonly attempts?: number | undefined;
                readonly requestBytes?: number | undefined;
                readonly preparedMs?: number | undefined;
                readonly signedMs?: number | undefined;
                readonly sentMs?: number | undefined;
                readonly headersMs?: number | undefined;
                readonly firstEventMs?: number | undefined;
                readonly firstThinkingMs?: number | undefined;
                readonly firstOutputMs?: number | undefined;
                readonly lastOutputMs?: number | undefined;
                readonly completedMs?: number | undefined;
                readonly closedMs?: number | undefined;
                readonly failedTries?: readonly {
                    readonly sentMs?: number | undefined;
                    readonly failedMs: number;
                    readonly code: string;
                    readonly httpStatus?: number | undefined;
                }[] | undefined;
            } | undefined;
            readonly sessionId?: string | undefined;
            readonly itemIds?: readonly string[] | undefined;
        }, cases: Handlers): import("effect/Unify").Unify<ReturnType<Handlers["retry" | "settle" | "text-delta" | "text-end" | "text-start" | "thinking-delta" | "thinking-end" | "thinking-start" | "tool-call-delta" | "tool-call-end" | "tool-call-start" | "tool-result" | "usage"]>>;
        <Handlers extends { [K in "retry" | "settle" | "text-delta" | "text-end" | "text-start" | "thinking-delta" | "thinking-end" | "thinking-start" | "tool-call-delta" | "tool-call-end" | "tool-call-start" | "tool-result" | "usage"]: (value: {
            readonly retry: Schema.Struct<{
                readonly type: Schema.Literal<"retry">;
                readonly attempt: Schema.Int;
                readonly code: Schema.String;
                /**
                 * Milliseconds the boundary waited before this attempt, as the retry
                 * schedule decided it on the injected clock.
                 *
                 * Recording the count alone was not enough to tell a working backoff from a
                 * broken one. Every retry of one sealed step is buffered and journaled
                 * together when the step settles, so two retries carry the same journal
                 * timestamp whether they were seconds apart or instantaneous — a wave report
                 * reading those timestamps cannot see the schedule at all. The delay is
                 * therefore stated by the event that took it. Zero is what a record written
                 * before this field carried, and what an unscheduled retry means.
                 */
                readonly delayMillis: Schema.withDecodingDefaultKey<Schema.withConstructorDefault<Schema.Number>, never>;
                /**
                 * Milliseconds the failed attempt ran before it failed. The journal stamps
                 * every retry of one step with the same instant, so without this a report
                 * cannot tell an attempt refused at once from one cut off after minutes.
                 * Absent when the boundary that retried did not time the attempt.
                 */
                readonly elapsedMs: Schema.optional<Schema.Number>;
                /** The HTTP status that failed the attempt, when a response carried one. */
                readonly httpStatus: Schema.optional<Schema.Number>;
            }>;
            readonly settle: Schema.Struct<{
                readonly type: Schema.Literal<"settle">;
                readonly stopReason: Schema.Literals<readonly ["stop", "length", "tool-calls", "content-filter", "error", "aborted", "unknown"]>;
                readonly responseId: Schema.optional<Schema.String>;
                /** The service tier that served the call, as the provider reported it. */
                readonly servedTier: Schema.optional<Schema.String>;
                /** Where the call's time went on the wire; absent on a record written before it was measured. */
                readonly timing: Schema.optional<Schema.Struct<{
                    /**
                     * When the call started, in epoch milliseconds: the instant every offset
                     * below counts from, so a report can place the call on a run's timeline.
                     */
                    readonly startedAt: Schema.optional<Schema.Number>;
                    /** HTTP tries, including the one that was answered. */
                    readonly attempts: Schema.optional<Schema.Int>;
                    /** Bytes of the request body sent. */
                    readonly requestBytes: Schema.optional<Schema.Number>;
                    /** The request was validated and encoded to the bytes that are sent. */
                    readonly preparedMs: Schema.optional<Schema.Number>;
                    /** The credential was resolved and the request signed. */
                    readonly signedMs: Schema.optional<Schema.Number>;
                    /**
                     * The answered try's request was handed to the HTTP client. The client does
                     * not report the socket write, so the upload lies between this and
                     * `headersMs`.
                     */
                    readonly sentMs: Schema.optional<Schema.Number>;
                    /** The response status and headers arrived. */
                    readonly headersMs: Schema.optional<Schema.Number>;
                    /** The first stream event of any kind arrived. */
                    readonly firstEventMs: Schema.optional<Schema.Number>;
                    /** The first thinking event; absent when the call emitted none. */
                    readonly firstThinkingMs: Schema.optional<Schema.Number>;
                    /** The first text or tool-call delta; absent when the call emitted none. */
                    readonly firstOutputMs: Schema.optional<Schema.Number>;
                    /** The last text or tool-call delta; absent when the call emitted none. */
                    readonly lastOutputMs: Schema.optional<Schema.Number>;
                    /** The provider's terminal event: the one the settlement is read from. */
                    readonly completedMs: Schema.optional<Schema.Number>;
                    /** The response stream closed. */
                    readonly closedMs: Schema.optional<Schema.Number>;
                    /** The tries that failed before the answered one, oldest first. */
                    readonly failedTries: Schema.optional<Schema.$Array<Schema.Struct<{
                        /** The try's request was handed to the HTTP client. */
                        readonly sentMs: Schema.optional<Schema.Number>;
                        /** The try failed. */
                        readonly failedMs: Schema.Number;
                        /** Why: a `ModelError` code, or the code of a kernel permission failure. */
                        readonly code: Schema.String;
                        /** The HTTP status that failed it, when a response carried one. */
                        readonly httpStatus: Schema.optional<Schema.Number>;
                    }>>>;
                }>>;
                /** The vendor session that answered, for a seat that is a wrapped CLI: `claude --resume <sessionId>`. */
                readonly sessionId: Schema.optional<Schema.String>;
                /**
                 * Stored provider reasoning items required for replay-safe continuation: a
                 * provider that keeps reasoning server side answers the next request with
                 * these ids rather than the text they stand for.
                 */
                readonly itemIds: Schema.optional<Schema.$Array<Schema.String>>;
            }>;
            readonly "text-delta": Schema.Struct<{
                readonly type: Schema.Literal<"text-delta">;
                readonly id: Schema.String;
                readonly text: Schema.String;
            }>;
            readonly "text-end": Schema.Struct<{
                readonly type: Schema.Literal<"text-end">;
                readonly id: Schema.String;
            }>;
            readonly "text-start": Schema.Struct<{
                readonly type: Schema.Literal<"text-start">;
                readonly id: Schema.String;
            }>;
            readonly "thinking-delta": Schema.Struct<{
                readonly type: Schema.Literal<"thinking-delta">;
                readonly id: Schema.String;
                readonly text: Schema.String;
            }>;
            readonly "thinking-end": Schema.Struct<{
                readonly type: Schema.Literal<"thinking-end">;
                readonly id: Schema.String;
            }>;
            readonly "thinking-start": Schema.Struct<{
                readonly type: Schema.Literal<"thinking-start">;
                readonly id: Schema.String;
                readonly signature: Schema.optional<Schema.String>;
            }>;
            readonly "tool-call-delta": Schema.Struct<{
                readonly type: Schema.Literal<"tool-call-delta">;
                readonly id: Schema.String;
                readonly arguments: Schema.String;
            }>;
            readonly "tool-call-end": Schema.Struct<{
                readonly type: Schema.Literal<"tool-call-end">;
                readonly id: Schema.String;
                readonly arguments: Schema.optional<Schema.String>;
            }>;
            readonly "tool-call-start": Schema.Struct<{
                readonly type: Schema.Literal<"tool-call-start">;
                readonly id: Schema.String;
                readonly name: Schema.String;
            }>;
            readonly "tool-result": Schema.Struct<{
                readonly type: Schema.Literal<"tool-result">;
                readonly id: Schema.String;
                readonly output: Schema.String;
                readonly isError: Schema.optional<Schema.Boolean>;
            }>;
            readonly usage: Schema.Struct<{
                readonly type: Schema.Literal<"usage">;
                readonly inputTokens: Schema.optional<Schema.Number>;
                readonly outputTokens: Schema.optional<Schema.Number>;
                readonly reasoningTokens: Schema.optional<Schema.Number>;
                readonly cachedInputTokens: Schema.optional<Schema.Number>;
                readonly cacheWriteTokens: Schema.optional<Schema.Number>;
                readonly totalTokens: Schema.optional<Schema.Number>;
                readonly costUsd: Schema.optional<Schema.Number>;
            }>;
        }[K]["Type"]) => any; }>(cases: Handlers): (value: {
            readonly type: "text-start";
            readonly id: string;
        } | {
            readonly type: "text-delta";
            readonly id: string;
            readonly text: string;
        } | {
            readonly type: "text-end";
            readonly id: string;
        } | {
            readonly type: "thinking-delta";
            readonly id: string;
            readonly text: string;
        } | {
            readonly type: "thinking-end";
            readonly id: string;
        } | {
            readonly type: "tool-call-start";
            readonly id: string;
            readonly name: string;
        } | {
            readonly type: "tool-call-delta";
            readonly id: string;
            readonly arguments: string;
        } | {
            readonly type: "thinking-start";
            readonly id: string;
            readonly signature?: string | undefined;
        } | {
            readonly type: "tool-call-end";
            readonly id: string;
            readonly arguments?: string | undefined;
        } | {
            readonly type: "tool-result";
            readonly id: string;
            readonly output: string;
            readonly isError?: boolean | undefined;
        } | {
            readonly type: "usage";
            readonly inputTokens?: number | undefined;
            readonly outputTokens?: number | undefined;
            readonly reasoningTokens?: number | undefined;
            readonly cachedInputTokens?: number | undefined;
            readonly cacheWriteTokens?: number | undefined;
            readonly totalTokens?: number | undefined;
            readonly costUsd?: number | undefined;
        } | {
            readonly type: "retry";
            readonly attempt: number;
            readonly code: string;
            readonly delayMillis: number;
            readonly elapsedMs?: number | undefined;
            readonly httpStatus?: number | undefined;
        } | {
            readonly type: "settle";
            readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
            readonly responseId?: string | undefined;
            readonly servedTier?: string | undefined;
            readonly timing?: {
                readonly startedAt?: number | undefined;
                readonly attempts?: number | undefined;
                readonly requestBytes?: number | undefined;
                readonly preparedMs?: number | undefined;
                readonly signedMs?: number | undefined;
                readonly sentMs?: number | undefined;
                readonly headersMs?: number | undefined;
                readonly firstEventMs?: number | undefined;
                readonly firstThinkingMs?: number | undefined;
                readonly firstOutputMs?: number | undefined;
                readonly lastOutputMs?: number | undefined;
                readonly completedMs?: number | undefined;
                readonly closedMs?: number | undefined;
                readonly failedTries?: readonly {
                    readonly sentMs?: number | undefined;
                    readonly failedMs: number;
                    readonly code: string;
                    readonly httpStatus?: number | undefined;
                }[] | undefined;
            } | undefined;
            readonly sessionId?: string | undefined;
            readonly itemIds?: readonly string[] | undefined;
        }) => import("effect/Unify").Unify<ReturnType<Handlers["retry" | "settle" | "text-delta" | "text-end" | "text-start" | "thinking-delta" | "thinking-end" | "thinking-start" | "tool-call-delta" | "tool-call-end" | "tool-call-start" | "tool-result" | "usage"]>>;
    };
    readonly matchOrElse: {
        <Handlers, OrElse>(value: {
            readonly type: "text-start";
            readonly id: string;
        } | {
            readonly type: "text-delta";
            readonly id: string;
            readonly text: string;
        } | {
            readonly type: "text-end";
            readonly id: string;
        } | {
            readonly type: "thinking-delta";
            readonly id: string;
            readonly text: string;
        } | {
            readonly type: "thinking-end";
            readonly id: string;
        } | {
            readonly type: "tool-call-start";
            readonly id: string;
            readonly name: string;
        } | {
            readonly type: "tool-call-delta";
            readonly id: string;
            readonly arguments: string;
        } | {
            readonly type: "thinking-start";
            readonly id: string;
            readonly signature?: string | undefined;
        } | {
            readonly type: "tool-call-end";
            readonly id: string;
            readonly arguments?: string | undefined;
        } | {
            readonly type: "tool-result";
            readonly id: string;
            readonly output: string;
            readonly isError?: boolean | undefined;
        } | {
            readonly type: "usage";
            readonly inputTokens?: number | undefined;
            readonly outputTokens?: number | undefined;
            readonly reasoningTokens?: number | undefined;
            readonly cachedInputTokens?: number | undefined;
            readonly cacheWriteTokens?: number | undefined;
            readonly totalTokens?: number | undefined;
            readonly costUsd?: number | undefined;
        } | {
            readonly type: "retry";
            readonly attempt: number;
            readonly code: string;
            readonly delayMillis: number;
            readonly elapsedMs?: number | undefined;
            readonly httpStatus?: number | undefined;
        } | {
            readonly type: "settle";
            readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
            readonly responseId?: string | undefined;
            readonly servedTier?: string | undefined;
            readonly timing?: {
                readonly startedAt?: number | undefined;
                readonly attempts?: number | undefined;
                readonly requestBytes?: number | undefined;
                readonly preparedMs?: number | undefined;
                readonly signedMs?: number | undefined;
                readonly sentMs?: number | undefined;
                readonly headersMs?: number | undefined;
                readonly firstEventMs?: number | undefined;
                readonly firstThinkingMs?: number | undefined;
                readonly firstOutputMs?: number | undefined;
                readonly lastOutputMs?: number | undefined;
                readonly completedMs?: number | undefined;
                readonly closedMs?: number | undefined;
                readonly failedTries?: readonly {
                    readonly sentMs?: number | undefined;
                    readonly failedMs: number;
                    readonly code: string;
                    readonly httpStatus?: number | undefined;
                }[] | undefined;
            } | undefined;
            readonly sessionId?: string | undefined;
            readonly itemIds?: readonly string[] | undefined;
        }, cases: Handlers & {
            readonly retry?: (value: {
                readonly type: "retry";
                readonly attempt: number;
                readonly code: string;
                readonly delayMillis: number;
                readonly elapsedMs?: number | undefined;
                readonly httpStatus?: number | undefined;
            }) => any;
            readonly settle?: (value: {
                readonly type: "settle";
                readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
                readonly responseId?: string | undefined;
                readonly servedTier?: string | undefined;
                readonly timing?: {
                    readonly startedAt?: number | undefined;
                    readonly attempts?: number | undefined;
                    readonly requestBytes?: number | undefined;
                    readonly preparedMs?: number | undefined;
                    readonly signedMs?: number | undefined;
                    readonly sentMs?: number | undefined;
                    readonly headersMs?: number | undefined;
                    readonly firstEventMs?: number | undefined;
                    readonly firstThinkingMs?: number | undefined;
                    readonly firstOutputMs?: number | undefined;
                    readonly lastOutputMs?: number | undefined;
                    readonly completedMs?: number | undefined;
                    readonly closedMs?: number | undefined;
                    readonly failedTries?: readonly {
                        readonly sentMs?: number | undefined;
                        readonly failedMs: number;
                        readonly code: string;
                        readonly httpStatus?: number | undefined;
                    }[] | undefined;
                } | undefined;
                readonly sessionId?: string | undefined;
                readonly itemIds?: readonly string[] | undefined;
            }) => any;
            readonly "text-delta"?: (value: {
                readonly type: "text-delta";
                readonly id: string;
                readonly text: string;
            }) => any;
            readonly "text-end"?: (value: {
                readonly type: "text-end";
                readonly id: string;
            }) => any;
            readonly "text-start"?: (value: {
                readonly type: "text-start";
                readonly id: string;
            }) => any;
            readonly "thinking-delta"?: (value: {
                readonly type: "thinking-delta";
                readonly id: string;
                readonly text: string;
            }) => any;
            readonly "thinking-end"?: (value: {
                readonly type: "thinking-end";
                readonly id: string;
            }) => any;
            readonly "thinking-start"?: (value: {
                readonly type: "thinking-start";
                readonly id: string;
                readonly signature?: string | undefined;
            }) => any;
            readonly "tool-call-delta"?: (value: {
                readonly type: "tool-call-delta";
                readonly id: string;
                readonly arguments: string;
            }) => any;
            readonly "tool-call-end"?: (value: {
                readonly type: "tool-call-end";
                readonly id: string;
                readonly arguments?: string | undefined;
            }) => any;
            readonly "tool-call-start"?: (value: {
                readonly type: "tool-call-start";
                readonly id: string;
                readonly name: string;
            }) => any;
            readonly "tool-result"?: (value: {
                readonly type: "tool-result";
                readonly id: string;
                readonly output: string;
                readonly isError?: boolean | undefined;
            }) => any;
            readonly usage?: (value: {
                readonly type: "usage";
                readonly inputTokens?: number | undefined;
                readonly outputTokens?: number | undefined;
                readonly reasoningTokens?: number | undefined;
                readonly cachedInputTokens?: number | undefined;
                readonly cacheWriteTokens?: number | undefined;
                readonly totalTokens?: number | undefined;
                readonly costUsd?: number | undefined;
            }) => any;
        } & (Exclude<keyof Handlers, "retry" | "settle" | "text-delta" | "text-end" | "text-start" | "thinking-delta" | "thinking-end" | "thinking-start" | "tool-call-delta" | "tool-call-end" | "tool-call-start" | "tool-result" | "usage"> extends never ? unknown : never), orElse: OrElse & ((value: Exclude<{
            readonly type: "text-start";
            readonly id: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "text-delta";
            readonly id: string;
            readonly text: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "text-end";
            readonly id: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "thinking-delta";
            readonly id: string;
            readonly text: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "thinking-end";
            readonly id: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "tool-call-start";
            readonly id: string;
            readonly name: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "tool-call-delta";
            readonly id: string;
            readonly arguments: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "thinking-start";
            readonly id: string;
            readonly signature?: string | undefined;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "tool-call-end";
            readonly id: string;
            readonly arguments?: string | undefined;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "tool-result";
            readonly id: string;
            readonly output: string;
            readonly isError?: boolean | undefined;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "usage";
            readonly inputTokens?: number | undefined;
            readonly outputTokens?: number | undefined;
            readonly reasoningTokens?: number | undefined;
            readonly cachedInputTokens?: number | undefined;
            readonly cacheWriteTokens?: number | undefined;
            readonly totalTokens?: number | undefined;
            readonly costUsd?: number | undefined;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "retry";
            readonly attempt: number;
            readonly code: string;
            readonly delayMillis: number;
            readonly elapsedMs?: number | undefined;
            readonly httpStatus?: number | undefined;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "settle";
            readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
            readonly responseId?: string | undefined;
            readonly servedTier?: string | undefined;
            readonly timing?: {
                readonly startedAt?: number | undefined;
                readonly attempts?: number | undefined;
                readonly requestBytes?: number | undefined;
                readonly preparedMs?: number | undefined;
                readonly signedMs?: number | undefined;
                readonly sentMs?: number | undefined;
                readonly headersMs?: number | undefined;
                readonly firstEventMs?: number | undefined;
                readonly firstThinkingMs?: number | undefined;
                readonly firstOutputMs?: number | undefined;
                readonly lastOutputMs?: number | undefined;
                readonly completedMs?: number | undefined;
                readonly closedMs?: number | undefined;
                readonly failedTries?: readonly {
                    readonly sentMs?: number | undefined;
                    readonly failedMs: number;
                    readonly code: string;
                    readonly httpStatus?: number | undefined;
                }[] | undefined;
            } | undefined;
            readonly sessionId?: string | undefined;
            readonly itemIds?: readonly string[] | undefined;
        }, {
            readonly type: keyof Handlers;
        }>) => any)): import("effect/Unify").Unify<{ [K in keyof Handlers]-?: NonNullable<Handlers[K]> extends (...args: Array<any>) => infer R ? R : never; }[keyof Handlers] | (OrElse extends (...args: Array<any>) => infer R ? R : never)>;
        <Handlers, OrElse>(cases: Handlers & {
            readonly retry?: (value: {
                readonly type: "retry";
                readonly attempt: number;
                readonly code: string;
                readonly delayMillis: number;
                readonly elapsedMs?: number | undefined;
                readonly httpStatus?: number | undefined;
            }) => any;
            readonly settle?: (value: {
                readonly type: "settle";
                readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
                readonly responseId?: string | undefined;
                readonly servedTier?: string | undefined;
                readonly timing?: {
                    readonly startedAt?: number | undefined;
                    readonly attempts?: number | undefined;
                    readonly requestBytes?: number | undefined;
                    readonly preparedMs?: number | undefined;
                    readonly signedMs?: number | undefined;
                    readonly sentMs?: number | undefined;
                    readonly headersMs?: number | undefined;
                    readonly firstEventMs?: number | undefined;
                    readonly firstThinkingMs?: number | undefined;
                    readonly firstOutputMs?: number | undefined;
                    readonly lastOutputMs?: number | undefined;
                    readonly completedMs?: number | undefined;
                    readonly closedMs?: number | undefined;
                    readonly failedTries?: readonly {
                        readonly sentMs?: number | undefined;
                        readonly failedMs: number;
                        readonly code: string;
                        readonly httpStatus?: number | undefined;
                    }[] | undefined;
                } | undefined;
                readonly sessionId?: string | undefined;
                readonly itemIds?: readonly string[] | undefined;
            }) => any;
            readonly "text-delta"?: (value: {
                readonly type: "text-delta";
                readonly id: string;
                readonly text: string;
            }) => any;
            readonly "text-end"?: (value: {
                readonly type: "text-end";
                readonly id: string;
            }) => any;
            readonly "text-start"?: (value: {
                readonly type: "text-start";
                readonly id: string;
            }) => any;
            readonly "thinking-delta"?: (value: {
                readonly type: "thinking-delta";
                readonly id: string;
                readonly text: string;
            }) => any;
            readonly "thinking-end"?: (value: {
                readonly type: "thinking-end";
                readonly id: string;
            }) => any;
            readonly "thinking-start"?: (value: {
                readonly type: "thinking-start";
                readonly id: string;
                readonly signature?: string | undefined;
            }) => any;
            readonly "tool-call-delta"?: (value: {
                readonly type: "tool-call-delta";
                readonly id: string;
                readonly arguments: string;
            }) => any;
            readonly "tool-call-end"?: (value: {
                readonly type: "tool-call-end";
                readonly id: string;
                readonly arguments?: string | undefined;
            }) => any;
            readonly "tool-call-start"?: (value: {
                readonly type: "tool-call-start";
                readonly id: string;
                readonly name: string;
            }) => any;
            readonly "tool-result"?: (value: {
                readonly type: "tool-result";
                readonly id: string;
                readonly output: string;
                readonly isError?: boolean | undefined;
            }) => any;
            readonly usage?: (value: {
                readonly type: "usage";
                readonly inputTokens?: number | undefined;
                readonly outputTokens?: number | undefined;
                readonly reasoningTokens?: number | undefined;
                readonly cachedInputTokens?: number | undefined;
                readonly cacheWriteTokens?: number | undefined;
                readonly totalTokens?: number | undefined;
                readonly costUsd?: number | undefined;
            }) => any;
        } & (Exclude<keyof Handlers, "retry" | "settle" | "text-delta" | "text-end" | "text-start" | "thinking-delta" | "thinking-end" | "thinking-start" | "tool-call-delta" | "tool-call-end" | "tool-call-start" | "tool-result" | "usage"> extends never ? unknown : never), orElse: OrElse & ((value: Exclude<{
            readonly type: "text-start";
            readonly id: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "text-delta";
            readonly id: string;
            readonly text: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "text-end";
            readonly id: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "thinking-delta";
            readonly id: string;
            readonly text: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "thinking-end";
            readonly id: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "tool-call-start";
            readonly id: string;
            readonly name: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "tool-call-delta";
            readonly id: string;
            readonly arguments: string;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "thinking-start";
            readonly id: string;
            readonly signature?: string | undefined;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "tool-call-end";
            readonly id: string;
            readonly arguments?: string | undefined;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "tool-result";
            readonly id: string;
            readonly output: string;
            readonly isError?: boolean | undefined;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "usage";
            readonly inputTokens?: number | undefined;
            readonly outputTokens?: number | undefined;
            readonly reasoningTokens?: number | undefined;
            readonly cachedInputTokens?: number | undefined;
            readonly cacheWriteTokens?: number | undefined;
            readonly totalTokens?: number | undefined;
            readonly costUsd?: number | undefined;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "retry";
            readonly attempt: number;
            readonly code: string;
            readonly delayMillis: number;
            readonly elapsedMs?: number | undefined;
            readonly httpStatus?: number | undefined;
        }, {
            readonly type: keyof Handlers;
        }> | Exclude<{
            readonly type: "settle";
            readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
            readonly responseId?: string | undefined;
            readonly servedTier?: string | undefined;
            readonly timing?: {
                readonly startedAt?: number | undefined;
                readonly attempts?: number | undefined;
                readonly requestBytes?: number | undefined;
                readonly preparedMs?: number | undefined;
                readonly signedMs?: number | undefined;
                readonly sentMs?: number | undefined;
                readonly headersMs?: number | undefined;
                readonly firstEventMs?: number | undefined;
                readonly firstThinkingMs?: number | undefined;
                readonly firstOutputMs?: number | undefined;
                readonly lastOutputMs?: number | undefined;
                readonly completedMs?: number | undefined;
                readonly closedMs?: number | undefined;
                readonly failedTries?: readonly {
                    readonly sentMs?: number | undefined;
                    readonly failedMs: number;
                    readonly code: string;
                    readonly httpStatus?: number | undefined;
                }[] | undefined;
            } | undefined;
            readonly sessionId?: string | undefined;
            readonly itemIds?: readonly string[] | undefined;
        }, {
            readonly type: keyof Handlers;
        }>) => any)): (value: {
            readonly type: "text-start";
            readonly id: string;
        } | {
            readonly type: "text-delta";
            readonly id: string;
            readonly text: string;
        } | {
            readonly type: "text-end";
            readonly id: string;
        } | {
            readonly type: "thinking-delta";
            readonly id: string;
            readonly text: string;
        } | {
            readonly type: "thinking-end";
            readonly id: string;
        } | {
            readonly type: "tool-call-start";
            readonly id: string;
            readonly name: string;
        } | {
            readonly type: "tool-call-delta";
            readonly id: string;
            readonly arguments: string;
        } | {
            readonly type: "thinking-start";
            readonly id: string;
            readonly signature?: string | undefined;
        } | {
            readonly type: "tool-call-end";
            readonly id: string;
            readonly arguments?: string | undefined;
        } | {
            readonly type: "tool-result";
            readonly id: string;
            readonly output: string;
            readonly isError?: boolean | undefined;
        } | {
            readonly type: "usage";
            readonly inputTokens?: number | undefined;
            readonly outputTokens?: number | undefined;
            readonly reasoningTokens?: number | undefined;
            readonly cachedInputTokens?: number | undefined;
            readonly cacheWriteTokens?: number | undefined;
            readonly totalTokens?: number | undefined;
            readonly costUsd?: number | undefined;
        } | {
            readonly type: "retry";
            readonly attempt: number;
            readonly code: string;
            readonly delayMillis: number;
            readonly elapsedMs?: number | undefined;
            readonly httpStatus?: number | undefined;
        } | {
            readonly type: "settle";
            readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
            readonly responseId?: string | undefined;
            readonly servedTier?: string | undefined;
            readonly timing?: {
                readonly startedAt?: number | undefined;
                readonly attempts?: number | undefined;
                readonly requestBytes?: number | undefined;
                readonly preparedMs?: number | undefined;
                readonly signedMs?: number | undefined;
                readonly sentMs?: number | undefined;
                readonly headersMs?: number | undefined;
                readonly firstEventMs?: number | undefined;
                readonly firstThinkingMs?: number | undefined;
                readonly firstOutputMs?: number | undefined;
                readonly lastOutputMs?: number | undefined;
                readonly completedMs?: number | undefined;
                readonly closedMs?: number | undefined;
                readonly failedTries?: readonly {
                    readonly sentMs?: number | undefined;
                    readonly failedMs: number;
                    readonly code: string;
                    readonly httpStatus?: number | undefined;
                }[] | undefined;
            } | undefined;
            readonly sessionId?: string | undefined;
            readonly itemIds?: readonly string[] | undefined;
        }) => import("effect/Unify").Unify<{ [K in keyof Handlers]-?: NonNullable<Handlers[K]> extends (...args: Array<any>) => infer R ? R : never; }[keyof Handlers] | (OrElse extends (...args: Array<any>) => infer R ? R : never)>;
    };
} & {
    TextStart: (input: {
        readonly type: "text-start";
        readonly id: string;
    }, options?: Schema.MakeOptions) => {
        readonly type: "text-start";
        readonly id: string;
    };
    TextDelta: (input: {
        readonly type: "text-delta";
        readonly id: string;
        readonly text: string;
    }, options?: Schema.MakeOptions) => {
        readonly type: "text-delta";
        readonly id: string;
        readonly text: string;
    };
    TextEnd: (input: {
        readonly type: "text-end";
        readonly id: string;
    }, options?: Schema.MakeOptions) => {
        readonly type: "text-end";
        readonly id: string;
    };
    ThinkingStart: (input: {
        readonly type: "thinking-start";
        readonly id: string;
        readonly signature?: string | undefined;
    }, options?: Schema.MakeOptions) => {
        readonly type: "thinking-start";
        readonly id: string;
        readonly signature?: string | undefined;
    };
    ThinkingDelta: (input: {
        readonly type: "thinking-delta";
        readonly id: string;
        readonly text: string;
    }, options?: Schema.MakeOptions) => {
        readonly type: "thinking-delta";
        readonly id: string;
        readonly text: string;
    };
    ThinkingEnd: (input: {
        readonly type: "thinking-end";
        readonly id: string;
    }, options?: Schema.MakeOptions) => {
        readonly type: "thinking-end";
        readonly id: string;
    };
    ToolCallStart: (input: {
        readonly type: "tool-call-start";
        readonly id: string;
        readonly name: string;
    }, options?: Schema.MakeOptions) => {
        readonly type: "tool-call-start";
        readonly id: string;
        readonly name: string;
    };
    ToolCallDelta: (input: {
        readonly type: "tool-call-delta";
        readonly id: string;
        readonly arguments: string;
    }, options?: Schema.MakeOptions) => {
        readonly type: "tool-call-delta";
        readonly id: string;
        readonly arguments: string;
    };
    ToolCallEnd: (input: {
        readonly type: "tool-call-end";
        readonly id: string;
        readonly arguments?: string | undefined;
    }, options?: Schema.MakeOptions) => {
        readonly type: "tool-call-end";
        readonly id: string;
        readonly arguments?: string | undefined;
    };
    ToolResult: (input: {
        readonly type: "tool-result";
        readonly id: string;
        readonly output: string;
        readonly isError?: boolean | undefined;
    }, options?: Schema.MakeOptions) => {
        readonly type: "tool-result";
        readonly id: string;
        readonly output: string;
        readonly isError?: boolean | undefined;
    };
    Usage: (input: Usage) => UsageEvent;
    Retry: (input: {
        readonly type: "retry";
        readonly attempt: number;
        readonly code: string;
        readonly delayMillis?: number;
        readonly elapsedMs?: number | undefined;
        readonly httpStatus?: number | undefined;
    }, options?: Schema.MakeOptions) => {
        readonly type: "retry";
        readonly attempt: number;
        readonly code: string;
        readonly delayMillis: number;
        readonly elapsedMs?: number | undefined;
        readonly httpStatus?: number | undefined;
    };
    Settle: (input: {
        readonly type: "settle";
        readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
        readonly responseId?: string | undefined;
        readonly servedTier?: string | undefined;
        readonly timing?: {
            readonly startedAt?: number | undefined;
            readonly attempts?: number | undefined;
            readonly requestBytes?: number | undefined;
            readonly preparedMs?: number | undefined;
            readonly signedMs?: number | undefined;
            readonly sentMs?: number | undefined;
            readonly headersMs?: number | undefined;
            readonly firstEventMs?: number | undefined;
            readonly firstThinkingMs?: number | undefined;
            readonly firstOutputMs?: number | undefined;
            readonly lastOutputMs?: number | undefined;
            readonly completedMs?: number | undefined;
            readonly closedMs?: number | undefined;
            readonly failedTries?: readonly {
                readonly sentMs?: number | undefined;
                readonly failedMs: number;
                readonly code: string;
                readonly httpStatus?: number | undefined;
            }[] | undefined;
        } | undefined;
        readonly sessionId?: string | undefined;
        readonly itemIds?: readonly string[] | undefined;
    }, options?: Schema.MakeOptions) => {
        readonly type: "settle";
        readonly stopReason: "aborted" | "content-filter" | "error" | "length" | "stop" | "tool-calls" | "unknown";
        readonly responseId?: string | undefined;
        readonly servedTier?: string | undefined;
        readonly timing?: {
            readonly startedAt?: number | undefined;
            readonly attempts?: number | undefined;
            readonly requestBytes?: number | undefined;
            readonly preparedMs?: number | undefined;
            readonly signedMs?: number | undefined;
            readonly sentMs?: number | undefined;
            readonly headersMs?: number | undefined;
            readonly firstEventMs?: number | undefined;
            readonly firstThinkingMs?: number | undefined;
            readonly firstOutputMs?: number | undefined;
            readonly lastOutputMs?: number | undefined;
            readonly completedMs?: number | undefined;
            readonly closedMs?: number | undefined;
            readonly failedTries?: readonly {
                readonly sentMs?: number | undefined;
                readonly failedMs: number;
                readonly code: string;
                readonly httpStatus?: number | undefined;
            }[] | undefined;
        } | undefined;
        readonly sessionId?: string | undefined;
        readonly itemIds?: readonly string[] | undefined;
    };
    settledMessage: typeof settledMessage;
};
/**
 * The decoded form of {@link ModelEvent}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ModelEvent = typeof ModelEvent.Type;
/**
 * Folds a stream into the one durable assistant message. No settlement means
 * interruption, which is represented as an aborted message rather than an
 * exception so the transcript remains resumable.
 *
 * Two policies meet here on one condition, and the split is deliberate.
 * `ToolStream.end` refuses argument text that is not a JSON object with
 * `invalid_provider_output`, because a live stream that cannot say what the
 * model asked for must fail rather than execute a guess. This projection
 * preserves malformed text verbatim, because it folds a stream that has
 * already happened and the durable transcript must remain truthful. Built-in
 * protocols validate live completions before they emit `tool-call-end`; only
 * an aborted turn can retain partial text, and every built-in lowering omits
 * that turn from the next request. A consumer must still validate arguments
 * before executing a tool.
 *
 * @category destructors
 * @since 0.1.0
 * @slop
 */
export declare function settledMessage(events: Iterable<ModelEvent>): {
    readonly message: AssistantMessage;
    readonly usage: Usage;
};
