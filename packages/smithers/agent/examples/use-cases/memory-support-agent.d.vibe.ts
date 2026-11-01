/**
 * Answer a support message from the customer's recalled memory, update that memory, and escalate when unsure.
 *
 * Port of the 0.x `memory-support-agent.jsx`. A recall agent loads the
 * customer's facts and recent tickets and reads their sentiment; a support
 * agent replies from them; a persistence agent then updates the customer's
 * facts from the exchange. Only a reply that asks for escalation goes on to the
 * escalation agent, which picks a tier and packages the context.
 *
 * 0.x's recall, respond, persist and escalate prompts were placeholders that printed their props; these prompts state the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools to reach the memory store; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`), and a host keeps customers apart by binding its `remember`/`recall` flows under a per-customer `WithMemory` policy (see `26-memory-recall.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { type Action, Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One durable fact about a customer. */
export declare const MemoryEntry: Schema.Struct<{
    readonly key: Schema.String;
    readonly value: Schema.String;
    readonly updatedAt: Schema.String;
}>;
/** What the recall agent loaded for one customer. */
export declare const Recall: Schema.Struct<{
    readonly customerId: Schema.String;
    readonly facts: Schema.$Array<Schema.Struct<{
        readonly key: Schema.String;
        readonly value: Schema.String;
        readonly updatedAt: Schema.String;
    }>>;
    readonly recentTickets: Schema.$Array<Schema.String>;
    readonly sentiment: Schema.Literals<readonly ["positive", "neutral", "frustrated", "angry"]>;
}>;
/** The support agent's reply. `confidenceScore` runs from 0 to 100. */
export declare const Response: Schema.Struct<{
    readonly reply: Schema.String;
    readonly confidenceScore: Schema.Number;
    readonly needsEscalation: Schema.Boolean;
    readonly reasoning: Schema.String;
    readonly suggestedActions: Schema.$Array<Schema.String>;
}>;
/** How the persistence agent changed the customer's memory. */
export declare const Persist: Schema.Struct<{
    readonly customerId: Schema.String;
    readonly newFacts: Schema.$Array<Schema.Struct<{
        readonly key: Schema.String;
        readonly value: Schema.String;
        readonly updatedAt: Schema.String;
    }>>;
    readonly removedKeys: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** Where the escalation agent sent the interaction. */
export declare const Escalation: Schema.Struct<{
    readonly escalated: Schema.Boolean;
    readonly tier: Schema.Literals<readonly ["t1", "t2", "t3", "engineering"]>;
    readonly reason: Schema.String;
    readonly context: Schema.String;
    readonly summary: Schema.String;
}>;
/** What the flow settles with: every step's output, and `null` when nothing was escalated. */
export declare const Output: Schema.Struct<{
    readonly recall: Schema.Struct<{
        readonly customerId: Schema.String;
        readonly facts: Schema.$Array<Schema.Struct<{
            readonly key: Schema.String;
            readonly value: Schema.String;
            readonly updatedAt: Schema.String;
        }>>;
        readonly recentTickets: Schema.$Array<Schema.String>;
        readonly sentiment: Schema.Literals<readonly ["positive", "neutral", "frustrated", "angry"]>;
    }>;
    readonly response: Schema.Struct<{
        readonly reply: Schema.String;
        readonly confidenceScore: Schema.Number;
        readonly needsEscalation: Schema.Boolean;
        readonly reasoning: Schema.String;
        readonly suggestedActions: Schema.$Array<Schema.String>;
    }>;
    readonly persist: Schema.Struct<{
        readonly customerId: Schema.String;
        readonly newFacts: Schema.$Array<Schema.Struct<{
            readonly key: Schema.String;
            readonly value: Schema.String;
            readonly updatedAt: Schema.String;
        }>>;
        readonly removedKeys: Schema.$Array<Schema.String>;
        readonly summary: Schema.String;
    }>;
    readonly escalation: Schema.NullOr<Schema.Struct<{
        readonly escalated: Schema.Boolean;
        readonly tier: Schema.Literals<readonly ["t1", "t2", "t3", "engineering"]>;
        readonly reason: Schema.String;
        readonly context: Schema.String;
        readonly summary: Schema.String;
    }>>;
}>;
/** Loads one customer's memory and reads their sentiment. */
export declare const RecallMemory: AgentAction.AgentAction<"examples/MemorySupportAgent/Recall", Schema.Struct<{
    customerId: Schema.String;
    conversationHistory: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly customerId: Schema.String;
    readonly facts: Schema.$Array<Schema.Struct<{
        readonly key: Schema.String;
        readonly value: Schema.String;
        readonly updatedAt: Schema.String;
    }>>;
    readonly recentTickets: Schema.$Array<Schema.String>;
    readonly sentiment: Schema.Literals<readonly ["positive", "neutral", "frustrated", "angry"]>;
}>>;
/** Replies to the latest message from what recall loaded. */
export declare const Respond: AgentAction.AgentAction<"examples/MemorySupportAgent/Respond", Schema.Struct<{
    customerId: Schema.String;
    facts: Schema.$Array<Schema.Struct<{
        readonly key: Schema.String;
        readonly value: Schema.String;
        readonly updatedAt: Schema.String;
    }>>;
    recentTickets: Schema.$Array<Schema.String>;
    sentiment: Schema.String;
    latestMessage: Schema.String;
}>, Schema.Struct<{
    readonly reply: Schema.String;
    readonly confidenceScore: Schema.Number;
    readonly needsEscalation: Schema.Boolean;
    readonly reasoning: Schema.String;
    readonly suggestedActions: Schema.$Array<Schema.String>;
}>>;
/** Updates the customer's memory from the reply. */
export declare const PersistMemory: AgentAction.AgentAction<"examples/MemorySupportAgent/Persist", Schema.Struct<{
    customerId: Schema.String;
    existingFacts: Schema.$Array<Schema.Struct<{
        readonly key: Schema.String;
        readonly value: Schema.String;
        readonly updatedAt: Schema.String;
    }>>;
    reply: Schema.String;
    latestMessage: Schema.String;
}>, Schema.Struct<{
    readonly customerId: Schema.String;
    readonly newFacts: Schema.$Array<Schema.Struct<{
        readonly key: Schema.String;
        readonly value: Schema.String;
        readonly updatedAt: Schema.String;
    }>>;
    readonly removedKeys: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** Picks an escalation tier and packages the context for it. */
export declare const Escalate: AgentAction.AgentAction<"examples/MemorySupportAgent/Escalate", Schema.Struct<{
    customerId: Schema.String;
    confidenceScore: Schema.Number;
    reasoning: Schema.String;
    suggestedActions: Schema.$Array<Schema.String>;
    sentiment: Schema.String;
    recentTickets: Schema.$Array<Schema.String>;
}>, Schema.Struct<{
    readonly escalated: Schema.Boolean;
    readonly tier: Schema.Literals<readonly ["t1", "t2", "t3", "engineering"]>;
    readonly reason: Schema.String;
    readonly context: Schema.String;
    readonly summary: Schema.String;
}>>;
type Requirements = Action.Requirement<"examples/MemorySupportAgent/Recall" | "examples/MemorySupportAgent/Respond" | "examples/MemorySupportAgent/Persist" | "examples/MemorySupportAgent/Escalate">;
/** The flow: recall, respond, persist, and escalate when the reply asks for it. */
export declare const MemorySupportAgent: Flow.Flow<"examples/MemorySupportAgent", Schema.Struct<{
    customerId: Schema.optional<Schema.String>;
    conversationHistory: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    latestMessage: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly recall: Schema.Struct<{
        readonly customerId: Schema.String;
        readonly facts: Schema.$Array<Schema.Struct<{
            readonly key: Schema.String;
            readonly value: Schema.String;
            readonly updatedAt: Schema.String;
        }>>;
        readonly recentTickets: Schema.$Array<Schema.String>;
        readonly sentiment: Schema.Literals<readonly ["positive", "neutral", "frustrated", "angry"]>;
    }>;
    readonly response: Schema.Struct<{
        readonly reply: Schema.String;
        readonly confidenceScore: Schema.Number;
        readonly needsEscalation: Schema.Boolean;
        readonly reasoning: Schema.String;
        readonly suggestedActions: Schema.$Array<Schema.String>;
    }>;
    readonly persist: Schema.Struct<{
        readonly customerId: Schema.String;
        readonly newFacts: Schema.$Array<Schema.Struct<{
            readonly key: Schema.String;
            readonly value: Schema.String;
            readonly updatedAt: Schema.String;
        }>>;
        readonly removedKeys: Schema.$Array<Schema.String>;
        readonly summary: Schema.String;
    }>;
    readonly escalation: Schema.NullOr<Schema.Struct<{
        readonly escalated: Schema.Boolean;
        readonly tier: Schema.Literals<readonly ["t1", "t2", "t3", "engineering"]>;
        readonly reason: Schema.String;
        readonly context: Schema.String;
        readonly summary: Schema.String;
    }>>;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, Action.Requirement<"examples/MemorySupportAgent/Persist"> | Action.Requirement<"examples/MemorySupportAgent/Recall"> | Action.Requirement<"examples/MemorySupportAgent/Respond"> | Requirements>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<Action.Requirement<"examples/MemorySupportAgent/Escalate"> | Action.Requirement<"examples/MemorySupportAgent/Persist"> | Action.Requirement<"examples/MemorySupportAgent/Recall"> | Action.Requirement<"examples/MemorySupportAgent/Respond">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
export {};
