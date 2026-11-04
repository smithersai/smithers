/**
 * External agents: a durable step whose work an external agent does on a
 * runner machine.
 *
 * {@link make} declares the host side of {@link module:AgentRunner}: one
 * `ExternalJob` from `@smthrs/flow` over the {@link AgentRunner.AgentJobs}
 * port. Its start queues generation `<origin>#g<n>` of the step's
 * {@link AgentRunner.Task} once, parked probes read how the job stands, a
 * retryable end is replaced by the next generation on the same runner (which
 * continues the same checkout), and the step ends with the files the agent
 * changed, or with an {@link AgentFailed} that names why.
 *
 * The step is the whole session's durable unit: its journal holds the start,
 * each probe, each generation and the result, never the agent's transcript.
 * Inside the session the runner checkpoints what the agent's own protocol
 * records and resumes from the last checkpoint after a crash; nothing on the
 * host needs to know.
 *
 * @since 1.0.0
 */
import { ExternalJob, type Flow } from "@smthrs/flow";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Schema from "effect/Schema";
import * as AgentRunner from "./AgentRunner.vibe";
/**
 * Why an external agent step failed: a runner's {@link AgentRunner.FAILURES}
 * code, or `cancelled` when the job was stopped before it ended.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const REASONS: readonly ["agent", "refused", "workspace", "too_large", "timeout", "machine_lost", "exhausted", "cancelled"];
declare const AgentFailed_base: Schema.Class<AgentFailed, Schema.TaggedStruct<"@smthrs/agent/ExternalAgent/AgentFailed", {
    readonly reason: Schema.Literals<readonly ["agent", "refused", "workspace", "too_large", "timeout", "machine_lost", "exhausted", "cancelled"]>;
}>, import("effect/Cause").YieldableError>;
/**
 * The step's job ended without a change. `reason` is a code, never the agent's
 * own text, which can carry the task's content.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class AgentFailed extends AgentFailed_base {
}
/**
 * What an external agent step answers: the files the agent changed, its last
 * message, what it cost as far as it said, and the generation that finished.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Result: Schema.Struct<{
    readonly changes: Schema.Struct<{
        readonly additions: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly contents: Schema.String;
        }>>;
        readonly deletions: Schema.$Array<Schema.String>;
    }>;
    readonly summary: Schema.String;
    readonly usage: Schema.Struct<{
        readonly contextTokens: Schema.optional<Schema.Int>;
        readonly costUsd: Schema.optional<Schema.Number>;
    }>;
    readonly generation: Schema.Int;
}>;
/**
 * What an external agent step answers, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Result = typeof Result.Type;
/**
 * The journaled handle of one generation: the job's key and the agent it went
 * to, so every later probe is traced and counted by it.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Handle: Schema.Struct<{
    readonly key: Schema.String;
    readonly agent: Schema.String;
}>;
/**
 * The journaled handle of one generation, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Handle = typeof Handle.Type;
/**
 * Counts external agent jobs by `agent` and `outcome`: `started`, `again` (a
 * retryable end, replaced if the agent has restarts left), `abandoned`
 * (cancelled by key before its start answered), `done`, or `failed` with the
 * failure's `reason`.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const jobs: Metric.Counter<number>;
/**
 * The step's deadline: the longest an agent may work ({@link AgentRunner.MAX_HOURS})
 * and ten minutes for the runner to settle. The job store ends a job at its
 * own agent's hours, so a shorter agent never waits for this.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const TIMEOUT = "730 minutes";
/** What a step declares, with the payload's decoded type. */
type PayloadOf<P extends Schema.Struct.Fields | Flow.AnyStructSchema> = P extends Schema.Struct.Fields ? Schema.Struct<P>["Type"] : P["Type"];
/**
 * The declaration of an external agent step.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options<P extends Schema.Struct.Fields | Flow.AnyStructSchema> {
    /** The step's typed input. */
    readonly payload: P;
    /** The job for one payload. Pure: every generation of a step recomputes it from the journaled payload. */
    readonly task: (payload: PayloadOf<P>) => AgentRunner.Task;
}
/**
 * Declares a durable step whose work an external agent does on a runner.
 *
 * `call(payload)` runs it inside a flow body as its own child execution, and
 * `flows` lists the declarations a host that resolves executions by tag must
 * register. `toLayer()` implements it over the host's
 * {@link AgentRunner.AgentJobs}.
 *
 * The step fails with {@link AgentFailed} when the job ends without a change,
 * and `ExternalJobTimedOut` when {@link TIMEOUT} passes first. A cancelled
 * step cancels its job, by key when the store's start had not answered yet.
 * {@link AgentRunner.AgentJobsUnavailable} is an `infra` fault, so the engine
 * retries the store operation that raised it.
 *
 * @example
 * ```ts
 * import { ExternalAgent } from "@smthrs/agent"
 * import * as Schema from "effect/Schema"
 *
 * const Session = ExternalAgent.make("agent/Session", {
 *   payload: { prompt: Schema.String, base: Schema.String },
 *   task: ({ prompt, base }) => ({
 *     agent: { name: "coder", labels: ["linux"], profile: "coder", maxHours: 4, restarts: 1 },
 *     repository: "github/acme/app",
 *     base,
 *     system: [],
 *     prompt,
 *     limits: { files: 50, bytes: 1024 * 1024 }
 *   })
 * })
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: <const Tag extends string, P extends Schema.Struct.Fields | Flow.AnyStructSchema>(tag: Tag, options: Options<P>) => ({
    readonly call: (payload: import("@smthrs/flow/Action").PlannedPayload<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["~type.make.in"]>) => import("@smthrs/plan/Node").Node<{
        readonly changes: {
            readonly additions: readonly {
                readonly path: string;
                readonly contents: string;
            }[];
            readonly deletions: readonly string[];
        };
        readonly summary: string;
        readonly usage: {
            readonly contextTokens?: number | undefined;
            readonly costUsd?: number | undefined;
        };
        readonly generation: number;
    }, AgentFailed | AgentRunner.AgentJobsUnavailable | ExternalJob.ExternalJobLost | ExternalJob.ExternalJobTimedOut | import("@smthrs/flow/Sleep").SleepRequestInvalid, never>;
    readonly run: <R>(payload: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"], options: {
        readonly executionId: string;
        readonly operations: ExternalJob.Operations<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"], {
            readonly key: string;
            readonly agent: string;
        }, {
            readonly changes: {
                readonly additions: readonly {
                    readonly path: string;
                    readonly contents: string;
                }[];
                readonly deletions: readonly string[];
            };
            readonly summary: string;
            readonly usage: {
                readonly contextTokens?: number | undefined;
                readonly costUsd?: number | undefined;
            };
            readonly generation: number;
        }, AgentFailed | AgentRunner.AgentJobsUnavailable, R>;
        readonly wait?: import("effect/Duration").Input | undefined;
    }) => Effect.Effect<{
        readonly changes: {
            readonly additions: readonly {
                readonly path: string;
                readonly contents: string;
            }[];
            readonly deletions: readonly string[];
        };
        readonly summary: string;
        readonly usage: {
            readonly contextTokens?: number | undefined;
            readonly costUsd?: number | undefined;
        };
        readonly generation: number;
    }, AgentFailed | AgentRunner.AgentJobsUnavailable | import("@smthrs/flow/FlowRuntime").ExecutionIdentityConflict | ExternalJob.ExternalJobLost | ExternalJob.ExternalJobTimedOut | import("@smthrs/flow/FlowRuntime").FlowCycleDetected | Schema.SchemaError | import("@smthrs/flow/Sleep").SleepRequestInvalid, R | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/flow/FlowRuntime").FlowRuntime | Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["EncodingServices"], import("@smthrs/flow/Action").Requirement<string>>>;
    readonly toLayer: <R>(operations: ExternalJob.Operations<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"], {
        readonly key: string;
        readonly agent: string;
    }, {
        readonly changes: {
            readonly additions: readonly {
                readonly path: string;
                readonly contents: string;
            }[];
            readonly deletions: readonly string[];
        };
        readonly summary: string;
        readonly usage: {
            readonly contextTokens?: number | undefined;
            readonly costUsd?: number | undefined;
        };
        readonly generation: number;
    }, AgentFailed | AgentRunner.AgentJobsUnavailable, R>) => import("effect/Layer").Layer<import("@smthrs/flow/Action").Requirement<`${Tag}/cancel`> | import("@smthrs/flow/Action").Requirement<`${Tag}/collect`> | import("@smthrs/flow/Action").Requirement<`${Tag}/fail`> | import("@smthrs/flow/Action").Requirement<`${Tag}/initialize`> | import("@smthrs/flow/Action").Requirement<`${Tag}/launch-timeout`> | import("@smthrs/flow/Action").Requirement<`${Tag}/ready`> | import("@smthrs/flow/Action").Requirement<`${Tag}/start`> | import("@smthrs/flow/Action").Requirement<`${Tag}/status`>, never, import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("@smthrs/flow/Action").Implementations | Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["DecodingServices"], {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["EncodingServices"], {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<Exclude<R, import("effect/Scope").Scope>, {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<Exclude<R, import("@smthrs/flow/FlowRuntime").FlowInstance | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("effect/Scope").Scope>, {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["DecodingServices"], never>, {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["EncodingServices"], never>, {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["DecodingServices"], never>, {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["EncodingServices"], never>, {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }>>;
    readonly flows: ReadonlyArray<Flow.Any>;
} & Flow.Flow<Tag, P extends Schema.Struct.Fields ? Schema.Struct<P> : P, Schema.Struct<{
    readonly changes: Schema.Struct<{
        readonly additions: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly contents: Schema.String;
        }>>;
        readonly deletions: Schema.$Array<Schema.String>;
    }>;
    readonly summary: Schema.String;
    readonly usage: Schema.Struct<{
        readonly contextTokens: Schema.optional<Schema.Int>;
        readonly costUsd: Schema.optional<Schema.Number>;
    }>;
    readonly generation: Schema.Int;
}>, Schema.Union<readonly [Schema.Union<readonly [typeof AgentFailed, typeof AgentRunner.AgentJobsUnavailable]>, typeof ExternalJob.ExternalJobLost, typeof ExternalJob.ExternalJobTimedOut, typeof import("@smthrs/flow/Sleep").SleepRequestInvalid]>, import("@smthrs/flow/Action").Requirement<string>>) & {
    readonly toLayer: () => import("effect/Layer").Layer<import("@smthrs/flow/Action").Requirement<`${Tag}/cancel`> | import("@smthrs/flow/Action").Requirement<`${Tag}/collect`> | import("@smthrs/flow/Action").Requirement<`${Tag}/fail`> | import("@smthrs/flow/Action").Requirement<`${Tag}/initialize`> | import("@smthrs/flow/Action").Requirement<`${Tag}/launch-timeout`> | import("@smthrs/flow/Action").Requirement<`${Tag}/ready`> | import("@smthrs/flow/Action").Requirement<`${Tag}/start`> | import("@smthrs/flow/Action").Requirement<`${Tag}/status`>, never, AgentRunner.AgentJobs | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("@smthrs/flow/Action").Implementations | Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["DecodingServices"], {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["EncodingServices"], {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["DecodingServices"], never>, {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["EncodingServices"], never>, {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["DecodingServices"], never>, {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }> | Exclude<Exclude<(P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["EncodingServices"], never>, {
        executionId: string;
        current: ({
            readonly key: string;
            readonly started: true;
            readonly handle: {
                readonly key: string;
                readonly agent: string;
            };
        } | {
            readonly key: string;
            readonly started: false;
            readonly input: (P extends Schema.Struct.Fields ? Schema.Struct<P> : P)["Type"];
        }) | undefined;
    }>>;
};
export {};
