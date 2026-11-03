/**
 * Turn-boundary steering values and their source contract.
 *
 * Governing design: `../docs/concepts.md#notification-queue`.
 *
 * @since 0.1.0
 */
import * as ModelRequest from "@smthrs/model/ModelRequest";
import { Context, Effect, Layer, Schema } from "effect";
import type { HarnessError } from "../../../src/HarnessError.ts";
/**
 * The boundary at which a transcript insertion may be promoted.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Delivery = "steer" | "queue";
/**
 * A transcript insertion promoted at the next turn boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SteerInsert {
    readonly _tag: "Insert";
    readonly delivery: "steer";
    readonly admittedAt: number;
    readonly message: ModelRequest.Message;
}
/**
 * A transcript insertion promoted only when the run would otherwise go idle.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface QueueInsert {
    readonly _tag: "Insert";
    readonly delivery: "queue";
    readonly admittedAt: number;
    readonly message: ModelRequest.Message;
}
/**
 * A transcript insertion admitted for a future turn.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Insert = SteerInsert | QueueInsert;
/**
 * A model-seat change that applies only after the current turn closes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SeatChange {
    readonly _tag: "SeatChange";
    readonly delivery: "steer";
    readonly admittedAt: number;
    readonly seat: string;
}
/**
 * A thinking-level change that applies only after the current turn closes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ThinkingChange {
    readonly _tag: "ThinkingChange";
    readonly delivery: "steer";
    readonly admittedAt: number;
    readonly thinking: ModelRequest.ReasoningEffort;
}
/**
 * A serializable steering event.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Item = Insert | SeatChange | ThinkingChange;
/**
 * An immutable, FIFO queue of steering events.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Queue {
    readonly items: ReadonlyArray<Item>;
}
/**
 * The values promoted when a turn reaches its close boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Drain {
    /** Personal instructions among the inserts; absent means all inserts for legacy sources. */
    readonly instructions?: ReadonlyArray<ModelRequest.Message>;
    readonly inserts: ReadonlyArray<ModelRequest.Message>;
    /**
     * The host's own notes for this boundary, such as the time the run has left
     * ({@link withTimeLeft}). The model reads them after the supervisor's
     * messages and before the person's inserts. They are never a person's
     * instruction, never mark a frame as the person's, and never answer a park.
     */
    readonly notes?: ReadonlyArray<ModelRequest.Message>;
    readonly seatChanges: ReadonlyArray<SeatChange | ThinkingChange>;
    readonly remaining: Queue;
    readonly queued: boolean;
    /**
     * Whether this boundary had already drained, so the answer is the one it gave
     * the first time.
     *
     * This is what makes a parked run answerable. A park resumes by re-executing
     * its own frames, so it reaches the same boundary again and must be told the
     * same thing — and it must also be able to find out that a NEWER boundary is
     * the one an operator's answer is waiting at. A run walks its park's
     * boundaries until one reports `false`, which is the first one this run has
     * not consulted before.
     *
     * Host queue bookkeeping, like {@link Drain.remaining}, and deliberately not
     * part of {@link DrainRecord}: it says which attempt asked, not what the
     * boundary holds, and freezing it in a journaled value would tell every later
     * attempt it was the first.
     */
    readonly duplicate: boolean;
}
/**
 * The boundary a drain is being attempted at, and whether the run would go
 * idle if nothing were delivered. Followups are held back until it would.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface BoundaryInput {
    readonly boundary: string;
    readonly wouldIdle: boolean;
    /**
     * The agent session draining, as `CellTurn` names it. A boundary is unique
     * within one session; a source shared by several sessions of one run, such
     * as an action's retries and corrections, keeps their boundaries apart by
     * it. Absent from a caller that names no session.
     */
    readonly session?: string | undefined;
    /**
     * Set only at an honored park's boundary: why the run parked and what it
     * asked. A source that can reach a person may show them the question and
     * answer the drain with their reply; one that cannot ignores it.
     */
    readonly park?: {
        readonly reason: "waiting-input" | "waiting-event" | "waiting-quota";
        readonly message: string;
    } | undefined;
}
/**
 * The journaled record of one turn-boundary drain.
 *
 * A drain consumes host queue state, so it is a nondeterministic read: the
 * controller journals exactly this projection through `EngineLike.record`,
 * keyed on the frame and boundary, and a re-executed frame replays the record
 * instead of draining an already-drained queue. Everything the controller
 * folds into durable state is here; `remaining` is host queue bookkeeping and
 * deliberately is not.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export declare const DrainRecord: Schema.Struct<{
    /** Personal instructions; absent in legacy records whose inserts are personal messages. */
    readonly instructions: Schema.optional<Schema.$Array<Schema.Union<readonly [typeof ModelRequest.UserMessage, typeof ModelRequest.AssistantMessage, typeof ModelRequest.ToolMessage]> & {
        readonly tag: "role";
        readonly discriminants: readonly ["user", "assistant", "tool"];
        readonly cases: {
            assistant: typeof ModelRequest.AssistantMessage;
            tool: typeof ModelRequest.ToolMessage;
            user: typeof ModelRequest.UserMessage;
        };
        readonly isAnyOf: <const Keys>(keys: readonly Keys[]) => (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => value is Extract<ModelRequest.AssistantMessage, {
            readonly role: Keys;
        }> | Extract<ModelRequest.ToolMessage, {
            readonly role: Keys;
        }> | Extract<ModelRequest.UserMessage, {
            readonly role: Keys;
        }>;
        readonly guards: {
            assistant: (u: unknown) => u is ModelRequest.AssistantMessage;
            tool: (u: unknown) => u is ModelRequest.ToolMessage;
            user: (u: unknown) => u is ModelRequest.UserMessage;
        };
        readonly match: {
            <Handlers extends { [K in "assistant" | "tool" | "user"]: (value: {
                readonly assistant: typeof ModelRequest.AssistantMessage;
                readonly tool: typeof ModelRequest.ToolMessage;
                readonly user: typeof ModelRequest.UserMessage;
            }[K]["Type"]) => any; }>(value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage, cases: Handlers): import("effect/Unify").Unify<ReturnType<Handlers["assistant" | "tool" | "user"]>>;
            <Handlers extends { [K in "assistant" | "tool" | "user"]: (value: {
                readonly assistant: typeof ModelRequest.AssistantMessage;
                readonly tool: typeof ModelRequest.ToolMessage;
                readonly user: typeof ModelRequest.UserMessage;
            }[K]["Type"]) => any; }>(cases: Handlers): (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => import("effect/Unify").Unify<ReturnType<Handlers["assistant" | "tool" | "user"]>>;
        };
        readonly matchOrElse: {
            <Handlers, OrElse>(value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage, cases: Handlers & {
                readonly assistant?: (value: ModelRequest.AssistantMessage) => any;
                readonly tool?: (value: ModelRequest.ToolMessage) => any;
                readonly user?: (value: ModelRequest.UserMessage) => any;
            } & (Exclude<keyof Handlers, "assistant" | "tool" | "user"> extends never ? unknown : never), orElse: OrElse & ((value: Exclude<ModelRequest.AssistantMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.ToolMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.UserMessage, {
                readonly role: keyof Handlers;
            }>) => any)): import("effect/Unify").Unify<{ [K in keyof Handlers]-?: NonNullable<Handlers[K]> extends (...args: Array<any>) => infer R ? R : never; }[keyof Handlers] | (OrElse extends (...args: Array<any>) => infer R ? R : never)>;
            <Handlers, OrElse>(cases: Handlers & {
                readonly assistant?: (value: ModelRequest.AssistantMessage) => any;
                readonly tool?: (value: ModelRequest.ToolMessage) => any;
                readonly user?: (value: ModelRequest.UserMessage) => any;
            } & (Exclude<keyof Handlers, "assistant" | "tool" | "user"> extends never ? unknown : never), orElse: OrElse & ((value: Exclude<ModelRequest.AssistantMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.ToolMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.UserMessage, {
                readonly role: keyof Handlers;
            }>) => any)): (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => import("effect/Unify").Unify<{ [K in keyof Handlers]-?: NonNullable<Handlers[K]> extends (...args: Array<any>) => infer R ? R : never; }[keyof Handlers] | (OrElse extends (...args: Array<any>) => infer R ? R : never)>;
        };
    } & {
        make: (message: ModelRequest.Message) => ModelRequest.Message;
        user: (content: string | ModelRequest.TextPart | ReadonlyArray<ModelRequest.TextPart>) => ModelRequest.UserMessage;
        assistant: (content: string | ModelRequest.AssistantContentPart | ReadonlyArray<ModelRequest.AssistantContentPart>, options?: {
            readonly stopReason?: ModelRequest.StopReason | undefined;
            readonly responseId?: string | undefined;
            readonly itemIds?: ReadonlyArray<string> | undefined;
        }) => ModelRequest.AssistantMessage;
        tool: (content: ModelRequest.ToolResultPart | ReadonlyArray<ModelRequest.ToolResultPart>) => ModelRequest.ToolMessage;
    }>>;
    readonly inserts: Schema.$Array<Schema.Union<readonly [typeof ModelRequest.UserMessage, typeof ModelRequest.AssistantMessage, typeof ModelRequest.ToolMessage]> & {
        readonly tag: "role";
        readonly discriminants: readonly ["user", "assistant", "tool"];
        readonly cases: {
            assistant: typeof ModelRequest.AssistantMessage;
            tool: typeof ModelRequest.ToolMessage;
            user: typeof ModelRequest.UserMessage;
        };
        readonly isAnyOf: <const Keys>(keys: readonly Keys[]) => (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => value is Extract<ModelRequest.AssistantMessage, {
            readonly role: Keys;
        }> | Extract<ModelRequest.ToolMessage, {
            readonly role: Keys;
        }> | Extract<ModelRequest.UserMessage, {
            readonly role: Keys;
        }>;
        readonly guards: {
            assistant: (u: unknown) => u is ModelRequest.AssistantMessage;
            tool: (u: unknown) => u is ModelRequest.ToolMessage;
            user: (u: unknown) => u is ModelRequest.UserMessage;
        };
        readonly match: {
            <Handlers extends { [K in "assistant" | "tool" | "user"]: (value: {
                readonly assistant: typeof ModelRequest.AssistantMessage;
                readonly tool: typeof ModelRequest.ToolMessage;
                readonly user: typeof ModelRequest.UserMessage;
            }[K]["Type"]) => any; }>(value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage, cases: Handlers): import("effect/Unify").Unify<ReturnType<Handlers["assistant" | "tool" | "user"]>>;
            <Handlers extends { [K in "assistant" | "tool" | "user"]: (value: {
                readonly assistant: typeof ModelRequest.AssistantMessage;
                readonly tool: typeof ModelRequest.ToolMessage;
                readonly user: typeof ModelRequest.UserMessage;
            }[K]["Type"]) => any; }>(cases: Handlers): (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => import("effect/Unify").Unify<ReturnType<Handlers["assistant" | "tool" | "user"]>>;
        };
        readonly matchOrElse: {
            <Handlers, OrElse>(value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage, cases: Handlers & {
                readonly assistant?: (value: ModelRequest.AssistantMessage) => any;
                readonly tool?: (value: ModelRequest.ToolMessage) => any;
                readonly user?: (value: ModelRequest.UserMessage) => any;
            } & (Exclude<keyof Handlers, "assistant" | "tool" | "user"> extends never ? unknown : never), orElse: OrElse & ((value: Exclude<ModelRequest.AssistantMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.ToolMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.UserMessage, {
                readonly role: keyof Handlers;
            }>) => any)): import("effect/Unify").Unify<{ [K in keyof Handlers]-?: NonNullable<Handlers[K]> extends (...args: Array<any>) => infer R ? R : never; }[keyof Handlers] | (OrElse extends (...args: Array<any>) => infer R ? R : never)>;
            <Handlers, OrElse>(cases: Handlers & {
                readonly assistant?: (value: ModelRequest.AssistantMessage) => any;
                readonly tool?: (value: ModelRequest.ToolMessage) => any;
                readonly user?: (value: ModelRequest.UserMessage) => any;
            } & (Exclude<keyof Handlers, "assistant" | "tool" | "user"> extends never ? unknown : never), orElse: OrElse & ((value: Exclude<ModelRequest.AssistantMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.ToolMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.UserMessage, {
                readonly role: keyof Handlers;
            }>) => any)): (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => import("effect/Unify").Unify<{ [K in keyof Handlers]-?: NonNullable<Handlers[K]> extends (...args: Array<any>) => infer R ? R : never; }[keyof Handlers] | (OrElse extends (...args: Array<any>) => infer R ? R : never)>;
        };
    } & {
        make: (message: ModelRequest.Message) => ModelRequest.Message;
        user: (content: string | ModelRequest.TextPart | ReadonlyArray<ModelRequest.TextPart>) => ModelRequest.UserMessage;
        assistant: (content: string | ModelRequest.AssistantContentPart | ReadonlyArray<ModelRequest.AssistantContentPart>, options?: {
            readonly stopReason?: ModelRequest.StopReason | undefined;
            readonly responseId?: string | undefined;
            readonly itemIds?: ReadonlyArray<string> | undefined;
        }) => ModelRequest.AssistantMessage;
        tool: (content: ModelRequest.ToolResultPart | ReadonlyArray<ModelRequest.ToolResultPart>) => ModelRequest.ToolMessage;
    }>;
    readonly notes: Schema.optional<Schema.$Array<Schema.Union<readonly [typeof ModelRequest.UserMessage, typeof ModelRequest.AssistantMessage, typeof ModelRequest.ToolMessage]> & {
        readonly tag: "role";
        readonly discriminants: readonly ["user", "assistant", "tool"];
        readonly cases: {
            assistant: typeof ModelRequest.AssistantMessage;
            tool: typeof ModelRequest.ToolMessage;
            user: typeof ModelRequest.UserMessage;
        };
        readonly isAnyOf: <const Keys>(keys: readonly Keys[]) => (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => value is Extract<ModelRequest.AssistantMessage, {
            readonly role: Keys;
        }> | Extract<ModelRequest.ToolMessage, {
            readonly role: Keys;
        }> | Extract<ModelRequest.UserMessage, {
            readonly role: Keys;
        }>;
        readonly guards: {
            assistant: (u: unknown) => u is ModelRequest.AssistantMessage;
            tool: (u: unknown) => u is ModelRequest.ToolMessage;
            user: (u: unknown) => u is ModelRequest.UserMessage;
        };
        readonly match: {
            <Handlers extends { [K in "assistant" | "tool" | "user"]: (value: {
                readonly assistant: typeof ModelRequest.AssistantMessage;
                readonly tool: typeof ModelRequest.ToolMessage;
                readonly user: typeof ModelRequest.UserMessage;
            }[K]["Type"]) => any; }>(value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage, cases: Handlers): import("effect/Unify").Unify<ReturnType<Handlers["assistant" | "tool" | "user"]>>;
            <Handlers extends { [K in "assistant" | "tool" | "user"]: (value: {
                readonly assistant: typeof ModelRequest.AssistantMessage;
                readonly tool: typeof ModelRequest.ToolMessage;
                readonly user: typeof ModelRequest.UserMessage;
            }[K]["Type"]) => any; }>(cases: Handlers): (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => import("effect/Unify").Unify<ReturnType<Handlers["assistant" | "tool" | "user"]>>;
        };
        readonly matchOrElse: {
            <Handlers, OrElse>(value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage, cases: Handlers & {
                readonly assistant?: (value: ModelRequest.AssistantMessage) => any;
                readonly tool?: (value: ModelRequest.ToolMessage) => any;
                readonly user?: (value: ModelRequest.UserMessage) => any;
            } & (Exclude<keyof Handlers, "assistant" | "tool" | "user"> extends never ? unknown : never), orElse: OrElse & ((value: Exclude<ModelRequest.AssistantMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.ToolMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.UserMessage, {
                readonly role: keyof Handlers;
            }>) => any)): import("effect/Unify").Unify<{ [K in keyof Handlers]-?: NonNullable<Handlers[K]> extends (...args: Array<any>) => infer R ? R : never; }[keyof Handlers] | (OrElse extends (...args: Array<any>) => infer R ? R : never)>;
            <Handlers, OrElse>(cases: Handlers & {
                readonly assistant?: (value: ModelRequest.AssistantMessage) => any;
                readonly tool?: (value: ModelRequest.ToolMessage) => any;
                readonly user?: (value: ModelRequest.UserMessage) => any;
            } & (Exclude<keyof Handlers, "assistant" | "tool" | "user"> extends never ? unknown : never), orElse: OrElse & ((value: Exclude<ModelRequest.AssistantMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.ToolMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.UserMessage, {
                readonly role: keyof Handlers;
            }>) => any)): (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => import("effect/Unify").Unify<{ [K in keyof Handlers]-?: NonNullable<Handlers[K]> extends (...args: Array<any>) => infer R ? R : never; }[keyof Handlers] | (OrElse extends (...args: Array<any>) => infer R ? R : never)>;
        };
    } & {
        make: (message: ModelRequest.Message) => ModelRequest.Message;
        user: (content: string | ModelRequest.TextPart | ReadonlyArray<ModelRequest.TextPart>) => ModelRequest.UserMessage;
        assistant: (content: string | ModelRequest.AssistantContentPart | ReadonlyArray<ModelRequest.AssistantContentPart>, options?: {
            readonly stopReason?: ModelRequest.StopReason | undefined;
            readonly responseId?: string | undefined;
            readonly itemIds?: ReadonlyArray<string> | undefined;
        }) => ModelRequest.AssistantMessage;
        tool: (content: ModelRequest.ToolResultPart | ReadonlyArray<ModelRequest.ToolResultPart>) => ModelRequest.ToolMessage;
    }>>;
    readonly seatChanges: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
        readonly _tag: Schema.Literal<"SeatChange">;
        readonly delivery: Schema.Literal<"steer">;
        readonly admittedAt: Schema.Number;
        readonly seat: Schema.String;
    }>, Schema.Struct<{
        readonly _tag: Schema.Literal<"ThinkingChange">;
        readonly delivery: Schema.Literal<"steer">;
        readonly admittedAt: Schema.Number;
        readonly thinking: Schema.Literals<readonly ["none", "minimal", "low", "medium", "high", "xhigh", "max"]>;
    }>]>>;
    readonly queued: Schema.Boolean;
    /**
     * Messages the run's supervisor delivers at this boundary, kept apart from
     * `inserts` and their personal-instruction list: the model reads them,
     * and the completion brake's task never does. Absent from records written
     * before the supervisor had a field of its own, and from boundaries it
     * delivered nothing at.
     */
    readonly supervisor: Schema.optional<Schema.$Array<Schema.Union<readonly [typeof ModelRequest.UserMessage, typeof ModelRequest.AssistantMessage, typeof ModelRequest.ToolMessage]> & {
        readonly tag: "role";
        readonly discriminants: readonly ["user", "assistant", "tool"];
        readonly cases: {
            assistant: typeof ModelRequest.AssistantMessage;
            tool: typeof ModelRequest.ToolMessage;
            user: typeof ModelRequest.UserMessage;
        };
        readonly isAnyOf: <const Keys>(keys: readonly Keys[]) => (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => value is Extract<ModelRequest.AssistantMessage, {
            readonly role: Keys;
        }> | Extract<ModelRequest.ToolMessage, {
            readonly role: Keys;
        }> | Extract<ModelRequest.UserMessage, {
            readonly role: Keys;
        }>;
        readonly guards: {
            assistant: (u: unknown) => u is ModelRequest.AssistantMessage;
            tool: (u: unknown) => u is ModelRequest.ToolMessage;
            user: (u: unknown) => u is ModelRequest.UserMessage;
        };
        readonly match: {
            <Handlers extends { [K in "assistant" | "tool" | "user"]: (value: {
                readonly assistant: typeof ModelRequest.AssistantMessage;
                readonly tool: typeof ModelRequest.ToolMessage;
                readonly user: typeof ModelRequest.UserMessage;
            }[K]["Type"]) => any; }>(value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage, cases: Handlers): import("effect/Unify").Unify<ReturnType<Handlers["assistant" | "tool" | "user"]>>;
            <Handlers extends { [K in "assistant" | "tool" | "user"]: (value: {
                readonly assistant: typeof ModelRequest.AssistantMessage;
                readonly tool: typeof ModelRequest.ToolMessage;
                readonly user: typeof ModelRequest.UserMessage;
            }[K]["Type"]) => any; }>(cases: Handlers): (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => import("effect/Unify").Unify<ReturnType<Handlers["assistant" | "tool" | "user"]>>;
        };
        readonly matchOrElse: {
            <Handlers, OrElse>(value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage, cases: Handlers & {
                readonly assistant?: (value: ModelRequest.AssistantMessage) => any;
                readonly tool?: (value: ModelRequest.ToolMessage) => any;
                readonly user?: (value: ModelRequest.UserMessage) => any;
            } & (Exclude<keyof Handlers, "assistant" | "tool" | "user"> extends never ? unknown : never), orElse: OrElse & ((value: Exclude<ModelRequest.AssistantMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.ToolMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.UserMessage, {
                readonly role: keyof Handlers;
            }>) => any)): import("effect/Unify").Unify<{ [K in keyof Handlers]-?: NonNullable<Handlers[K]> extends (...args: Array<any>) => infer R ? R : never; }[keyof Handlers] | (OrElse extends (...args: Array<any>) => infer R ? R : never)>;
            <Handlers, OrElse>(cases: Handlers & {
                readonly assistant?: (value: ModelRequest.AssistantMessage) => any;
                readonly tool?: (value: ModelRequest.ToolMessage) => any;
                readonly user?: (value: ModelRequest.UserMessage) => any;
            } & (Exclude<keyof Handlers, "assistant" | "tool" | "user"> extends never ? unknown : never), orElse: OrElse & ((value: Exclude<ModelRequest.AssistantMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.ToolMessage, {
                readonly role: keyof Handlers;
            }> | Exclude<ModelRequest.UserMessage, {
                readonly role: keyof Handlers;
            }>) => any)): (value: ModelRequest.AssistantMessage | ModelRequest.ToolMessage | ModelRequest.UserMessage) => import("effect/Unify").Unify<{ [K in keyof Handlers]-?: NonNullable<Handlers[K]> extends (...args: Array<any>) => infer R ? R : never; }[keyof Handlers] | (OrElse extends (...args: Array<any>) => infer R ? R : never)>;
        };
    } & {
        make: (message: ModelRequest.Message) => ModelRequest.Message;
        user: (content: string | ModelRequest.TextPart | ReadonlyArray<ModelRequest.TextPart>) => ModelRequest.UserMessage;
        assistant: (content: string | ModelRequest.AssistantContentPart | ReadonlyArray<ModelRequest.AssistantContentPart>, options?: {
            readonly stopReason?: ModelRequest.StopReason | undefined;
            readonly responseId?: string | undefined;
            readonly itemIds?: ReadonlyArray<string> | undefined;
        }) => ModelRequest.AssistantMessage;
        tool: (content: ModelRequest.ToolResultPart | ReadonlyArray<ModelRequest.ToolResultPart>) => ModelRequest.ToolMessage;
    }>>;
    /**
     * Keys of the memory rows among `supervisor`, which the run has now been
     * shown. Absent from boundaries that delivered none.
     */
    readonly memory: Schema.optional<Schema.$Array<Schema.String>>;
    /** The monitor whose message leads `supervisor`, when one was delivered. */
    readonly monitor: Schema.optional<Schema.String>;
    /** Crossed monitors this boundary withheld, and why. Absent when none was. */
    readonly suppressed: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly reason: Schema.Literals<readonly ["streak", "cooldown", "limit", "slot"]>;
    }>>>;
    /**
     * The monitor ledger after this boundary gated a reading, which the run
     * carries into its next frame. Absent from boundaries that gated none.
     */
    readonly monitorLedger: Schema.optional<Schema.$Record<Schema.String, Schema.Struct<{
        readonly streak: Schema.Int;
        readonly delivered: Schema.Int;
        readonly lastFrame: Schema.Int;
    }>>>;
    /**
     * Jev's answers about transcript segments, by digest, which the run stores
     * for its next compaction. The model is not sent them. Absent from
     * boundaries that took none, as every boundary of a context at or under
     * `Compaction.judgedAbove` tokens does.
     */
    readonly marks: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly remove: Schema.Number;
        readonly keep: Schema.Number;
        readonly digest: Schema.String;
    }>>>;
    /**
     * The context triggers the delivered supervisor reading fired, which
     * compact the run at its next frame. Absent from boundaries that took none:
     * a reading of a context at or under `Compaction.judgedAbove` tokens
     * delivers none.
     */
    readonly compact: Schema.optional<Schema.$Array<Schema.Literals<readonly ["budget", "outdated_context", "irrelevant_context"]>>>;
}>;
/**
 * The journaled record of one turn-boundary drain.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type DrainRecord = typeof DrainRecord.Type;
/**
 * Projects a {@link Drain} into its journaled record.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export declare const drainRecord: (drain: Drain) => DrainRecord;
/**
 * Creates an empty immutable steering queue.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const empty: () => Queue;
/**
 * Appends an item without mutating the prior queue.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export declare const enqueue: (queue: Queue, item: Item) => Queue;
/**
 * Drains only items admitted at or before the turn's fixed cutoff.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export declare const drainAtClose: (queue: Queue, cutoff: number) => Drain;
/**
 * Source of a serializable steering-queue snapshot. Storage and persistence
 * promotion are deliberately supplied by the host.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Source {
    readonly read: () => Effect.Effect<Queue, HarnessError>;
    /**
     * Promotes what one boundary may deliver.
     *
     * A drain is IDEMPOTENT in its boundary string: a second drain at one
     * boundary promotes nothing and hands back exactly what the first one
     * promoted, with {@link Drain.duplicate} set. That is not an optimization, it
     * is the contract a resumed run depends on — a re-executed frame drains the
     * boundaries it already drained and must be told the same thing, or it
     * rebuilds a different context and re-keys every later sealed step. A source
     * that promotes afresh each time cannot answer a parked run and will deliver
     * one message many times.
     */
    readonly drain: (input: BoundaryInput) => Effect.Effect<Drain, HarnessError>;
}
/**
 * The methods {@link make} needs to build a {@link Source}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SourceInput {
    readonly read: () => Effect.Effect<Queue, HarnessError>;
    readonly drain: (input: BoundaryInput) => Effect.Effect<Drain, HarnessError>;
}
/**
 * Service tag for the external steering queue source.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export declare const Source: Context.Service<Source, Source>;
/**
 * Constructs a steering source service.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (implementation: SourceInput) => Source;
/**
 * Creates a source that always returns an empty queue.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const makeNoop: (overrides?: Partial<Source>) => Source;
/**
 * Provides a steering source as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layer: (implementation: SourceInput) => Layer.Layer<Source>;
/**
 * Provides an empty steering source as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layerNoop: (overrides?: Partial<Source>) => Layer.Layer<Source>;
/**
 * What a run with `budgetMs` to work in is told when `leftMs` of it is left,
 * in whole minutes rounded down.
 *
 * @category conversions
 * @since 1.0.0-rc.17
 */
export declare const timeLeft: (leftMs: number, budgetMs: number) => string;
/**
 * `source`, with the time a run has left as a note ({@link Drain.notes}) at
 * each boundary the run continues through, so an agent with a deadline can
 * pace itself: `startedAt` is when its `budgetMs` began, by the `Clock`.
 *
 * A boundary that would idle or that parks gets no note, since nothing reads
 * it there and a note must never answer a park. The clock is read inside the
 * drain, which the run records at a boundary it continues through, so a
 * replay delivers the time the first drain told.
 *
 * @category combinators
 * @since 1.0.0-rc.17
 */
export declare const withTimeLeft: (source: Source, options: {
    readonly startedAt: number;
    readonly budgetMs: number;
}) => Source;
