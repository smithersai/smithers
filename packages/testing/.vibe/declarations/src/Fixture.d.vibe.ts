/**
 * Recorded-model fixture values and their portable decoder.
 *
 * @since 0.0.0
 */
import type { Effect } from "effect";
import { Schema } from "effect";
import type { ModelErrorLike, ModelEventLike, ModelRequestLike, RecordedRequestLike } from "./ModelLike.vibe";
/**
 * One recorded model invocation.
 *
 * `model` is the model the exchange was recorded against, and it is the same
 * value as `request.modelId`: every recorder in this package writes it from
 * the projected request. It is stored separately because `RecordedModel`
 * matches a call by request SHAPE, with `modelId` erased, so `model` is what
 * answers "was this recorded against the model now asking?" once the shape has
 * already matched. {@link canonicalRequestDigest} itself erases nothing:
 * `CachedModel` keys on the whole canonical request, `modelId` included. The
 * two agreeing is a decoding rule, not a convention: see {@link Fixture}.
 *
 * @category models
 * @since 0.0.0
 */
export interface RecordedCall {
    readonly request: RecordedRequestLike;
    readonly model: string;
    readonly events: ReadonlyArray<ModelEventLike>;
    readonly failure?: ModelErrorLike | undefined;
}
/**
 * A portable recording of model calls.
 *
 * This interface and the {@link Fixture} schema below share one name and are
 * one contract. `decode` is typed by this interface rather than by
 * `typeof Fixture.Type`, so nothing in the compiler stops the two from
 * drifting as long as they stay structurally assignable in the one direction
 * a signature happens to use. `test/FixtureSchema.test.ts` holds them
 * together: it asserts the decoded value is a `Fixture`, and it compares the
 * key set of every level of both shapes, so a field added to one and not the
 * other fails `tsc`.
 *
 * The schema is narrower than the interface in exactly one place, deliberately:
 * a tool's `parameters` is `Record<string, unknown>` here, mirroring
 * `@smthrs/model`'s tool shape, and `Record<string, Json>` in the schema,
 * because a fixture is written to a file and read back.
 *
 * @category models
 * @since 0.0.0
 */
export interface Fixture {
    readonly calls: ReadonlyArray<RecordedCall>;
}
/**
 * The JSON schema for a recorded-model fixture. The nested request, message,
 * tool, and params shapes mirror `/model/ModelRequest` structurally (the
 * provider-neutral types are owned by `ModelLike`), so an invalid fixture
 * fails decoding. A call whose `model` disagrees with its own
 * `request.modelId` fails decoding too: see {@link RecordedCall}.
 *
 * This schema and the {@link Fixture} interface above are one contract, held
 * together by `test/FixtureSchema.test.ts`.
 *
 * @category schemas
 * @since 0.0.0
 */
export declare const Fixture: Schema.Struct<{
    readonly calls: Schema.$Array<Schema.Struct<{
        readonly request: Schema.Struct<{
            readonly modelId: Schema.String;
            readonly system: Schema.$Array<Schema.Struct<{
                readonly type: Schema.Literal<"text">;
                readonly text: Schema.String;
            }>>;
            readonly messages: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
                readonly role: Schema.Literal<"user">;
                readonly content: Schema.$Array<Schema.Struct<{
                    readonly type: Schema.Literal<"text">;
                    readonly text: Schema.String;
                }>>;
            }>, Schema.Struct<{
                readonly role: Schema.Literal<"assistant">;
                readonly content: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
                    readonly type: Schema.Literal<"text">;
                    readonly text: Schema.String;
                }>, Schema.Struct<{
                    readonly type: Schema.Literal<"thinking">;
                    readonly text: Schema.String;
                    readonly signature: Schema.optional<Schema.String>;
                }>, Schema.Struct<{
                    readonly type: Schema.Literal<"tool-call">;
                    readonly id: Schema.String;
                    readonly name: Schema.String;
                    readonly arguments: Schema.String;
                }>]>>;
                readonly stopReason: Schema.Literals<readonly ["stop", "length", "tool-calls", "content-filter", "error", "aborted", "unknown"]>;
                readonly responseId: Schema.optional<Schema.String>;
                readonly itemIds: Schema.optional<Schema.$Array<Schema.String>>;
            }>, Schema.Struct<{
                readonly role: Schema.Literal<"tool">;
                readonly content: Schema.$Array<Schema.Struct<{
                    readonly type: Schema.Literal<"tool-result">;
                    readonly toolCallId: Schema.String;
                    readonly content: Schema.String;
                    readonly addedToolNames: Schema.$Array<Schema.String>;
                }>>;
            }>]>>;
            readonly tools: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly description: Schema.String;
                readonly parameters: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
                readonly deferred: Schema.optional<Schema.Boolean>;
                readonly loader: Schema.optional<Schema.Boolean>;
            }>>;
            readonly params: Schema.Struct<{
                readonly maxTokens: Schema.optional<Schema.Number>;
                readonly temperature: Schema.optional<Schema.Number>;
                readonly topP: Schema.optional<Schema.Number>;
                readonly topK: Schema.optional<Schema.Number>;
                readonly stopSequences: Schema.optional<Schema.$Array<Schema.String>>;
                readonly thinkingBudget: Schema.optional<Schema.Number>;
                readonly reasoningEffort: Schema.optional<Schema.Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>;
            }>;
            readonly toolChoice: Schema.optional<Schema.Literal<"none">>;
            readonly serverTools: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly type: Schema.Literal<"web_search">;
                readonly allowedDomains: Schema.optionalKey<Schema.$Array<Schema.String>>;
            }>>>;
        }>;
        readonly model: Schema.String;
        readonly events: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
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
            readonly delayMillis: Schema.Number;
            readonly elapsedMs: Schema.optional<Schema.Number>;
            readonly httpStatus: Schema.optional<Schema.Number>;
        }>, Schema.Struct<{
            readonly type: Schema.Literal<"settle">;
            readonly stopReason: Schema.Literals<readonly ["stop", "length", "tool-calls", "content-filter", "error", "aborted", "unknown"]>;
            readonly responseId: Schema.optional<Schema.String>;
            readonly servedTier: Schema.optional<Schema.String>;
            readonly timing: Schema.optional<Schema.Struct<{
                readonly startedAt: Schema.optional<Schema.Number>;
                readonly attempts: Schema.optional<Schema.Int>;
                readonly requestBytes: Schema.optional<Schema.Number>;
                readonly preparedMs: Schema.optional<Schema.Number>;
                readonly signedMs: Schema.optional<Schema.Number>;
                readonly sentMs: Schema.optional<Schema.Number>;
                readonly headersMs: Schema.optional<Schema.Number>;
                readonly firstEventMs: Schema.optional<Schema.Number>;
                readonly firstThinkingMs: Schema.optional<Schema.Number>;
                readonly firstOutputMs: Schema.optional<Schema.Number>;
                readonly lastOutputMs: Schema.optional<Schema.Number>;
                readonly completedMs: Schema.optional<Schema.Number>;
                readonly closedMs: Schema.optional<Schema.Number>;
                readonly failedTries: Schema.optional<Schema.$Array<Schema.Struct<{
                    readonly sentMs: Schema.optional<Schema.Number>;
                    readonly failedMs: Schema.Number;
                    readonly code: Schema.String;
                    readonly httpStatus: Schema.optional<Schema.Number>;
                }>>>;
            }>>;
            readonly sessionId: Schema.optional<Schema.String>;
            readonly itemIds: Schema.optional<Schema.$Array<Schema.String>>;
        }>]>>;
        readonly failure: Schema.optional<Schema.Struct<{
            readonly code: Schema.Literals<readonly ["invalid_request", "context_overflow", "no_route", "authentication", "rate_limited", "quota_exceeded", "out_of_credit", "content_policy", "provider_internal", "transport", "call_timeout", "invalid_provider_output", "unknown"]>;
            readonly message: Schema.String;
            readonly path: Schema.optional<Schema.String>;
            readonly retryAfterMillis: Schema.optional<Schema.Number>;
            readonly resetAtEpochMillis: Schema.optional<Schema.Number>;
            readonly resetSource: Schema.optional<Schema.String>;
            readonly quotaScope: Schema.optional<Schema.Literals<readonly ["model", "account"]>>;
            readonly providerCode: Schema.optional<Schema.String>;
            readonly requestId: Schema.optional<Schema.String>;
            readonly httpStatus: Schema.optional<Schema.Number>;
        }>>;
    }>>;
}>;
/**
 * Decodes a checked-in recorded-model fixture.
 *
 * @category decoders
 * @since 0.0.0
 */
export declare const decode: (input: unknown) => Effect.Effect<Fixture, Schema.SchemaError>;
/**
 * The canonical JSON encoding of a request, and its replay identity.
 *
 * Re-derived locally from `/model`'s `CanonicalJson.stringify` algorithm:
 * object keys sort recursively, array order is retained, and non-JSON values
 * are rejected with a typed {@link FixtureEncodingError} naming the offending
 * path.
 *
 * It returns the canonical encoding rather than a fixed-length hash, and the
 * name is the one historical wart in this module. A fixture cache selects the
 * recorded call to replay by this value, so a hash collision would replay
 * another conversation's response as this one's; the package owns no
 * synchronous cryptographic hash, and a non-cryptographic one buys shorter
 * keys at the cost of a wrong answer nothing would detect. The cost that made
 * the length matter — re-encoding every recorded call on every lookup — is
 * paid once per fixture instead: see {@link index}.
 *
 * @category encoding
 * @since 0.0.0
 */
export declare const canonicalRequestDigest: (request: ModelRequestLike) => string;
/**
 * A digest-keyed index over a fixture's recorded calls, computed once.
 *
 * Both model doubles used to call {@link canonicalRequestDigest} for the
 * incoming request AND for every call already in the fixture, on every model
 * invocation: O(n) full re-encodings of complete conversations per call, and
 * O(n squared) per run, with every intermediate string retained long enough to
 * compare. The index is memoized on the fixture object, so a hundred-turn
 * agent fixture encodes its calls once.
 *
 * The memo is keyed by object identity. `FixtureStore` replaces the whole
 * fixture on every append rather than mutating it, so a recorded call is
 * visible to the next lookup; a caller that instead mutates a fixture's `calls`
 * in place would read a stale index. That replacement is also why the index
 * alone was not enough while a run was still recording: every append made a
 * fixture this memo had never seen, and the rebuild re-encoded every call
 * already recorded. {@link recordedDigest} carries those encodings across the
 * append.
 *
 * @category encoding
 * @since 0.0.0
 */
export declare const index: (fixture: Fixture) => ReadonlyMap<string, RecordedCall>;
/**
 * Projects a request onto the plain JSON data a fixture stores.
 *
 * The production `ModelRequest` is a `Schema.Class` whose messages, tools, and
 * params are class instances. A recorder that stored one verbatim would write a
 * fixture whose shape depends on the class, and {@link canonicalRequestDigest}
 * rejects any value that is not a plain object. This copy keeps the recorded
 * request, the decoded fixture, and the digest input the same value. The
 * provider cache hints are not copied: they never reach the model, and
 * `cacheKey` is keyed to the run, so storing either would make a fixture miss
 * on the next run of the same conversation.
 *
 * @category encoding
 * @since 0.0.0
 */
export declare const recordedRequest: (request: ModelRequestLike) => RecordedRequestLike;
