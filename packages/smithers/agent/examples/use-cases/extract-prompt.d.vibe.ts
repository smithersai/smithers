/**
 * Resolve a prompt from a given string, a cached entry, or a Socratic question loop with a person.
 *
 * Port of the 0.x `components/extract-prompt/` `<ExtractPrompt>` component. A
 * provided prompt of at least 32 characters passes through, and so does a
 * cached entry; neither asks a model. Otherwise a drafter agent fills the
 * R-C-T-F slots (role, context, task, format) and scores its own draft. A
 * draft that reaches the threshold (1.0 for high stakes, 0.7 for low, or an
 * explicit `threshold`) settles the flow; below it, the person answers the
 * draft's one Socratic question and the drafter refines, for at most
 * `maxTurns` drafts (default 10), settling with the last draft at the bound.
 *
 * 0.x's drafter asked the person itself through an `ask-user` bash script; here the flow asks the draft's `nextQuestion` as a `HumanTask` and hands the answer to the next draft.
 * 0.x's loop ended on the score alone, so a draft the person overrode below the threshold still asks again until the bound; kept.
 * 0.x's cache I/O (`MarkdownPromptCache`, `SqlitePromptCache`) was the caller's job, so the flow takes the cache hit as `cached`; the optional `scorers` observability hook is not ported.
 * 0.x's slot fields had zod defaults; here the drafter fills every slot, and `AgentAction` renders and enforces the output schema instead of the prompt's JSON instruction.
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { type Action, Flow, HumanTask } from "@smthrs/flow";
import * as Schema from "effect/Schema";
/** A provided prompt shorter than this, once trimmed, is extracted rather than passed through. */
export declare const minTrivialLength = 32;
/** How sure the person must be before a draft is good enough. */
export declare const Stakes: Schema.Literals<readonly ["high", "low"]>;
/** The threshold a stakes label stands for: every slot strongly filled for high stakes, good enough for low. */
export declare const stakesToThreshold: (stakes: typeof Stakes.Type) => number;
/** The R-C-T-F slots, plus the auxiliary ones that often matter. */
export declare const Structured: Schema.Struct<{
    readonly role: Schema.String;
    readonly context: Schema.String;
    readonly task: Schema.String;
    readonly format: Schema.String;
    readonly constraints: Schema.$Array<Schema.String>;
    readonly successCriteria: Schema.$Array<Schema.String>;
    readonly outOfScope: Schema.$Array<Schema.String>;
}>;
/** The Socratic principle the next question applies. */
export declare const Principle: Schema.Literals<readonly ["definition", "elenchus", "hypothesis-elimination", "generalization", "induction", "dialectic", "maieutic", "analogy", "irony", "recollection", "none"]>;
/** One draft of the extracted prompt, and what the flow settles with. */
export declare const RctfPrompt: Schema.Struct<{
    readonly prompt: Schema.String;
    readonly structured: Schema.Struct<{
        readonly role: Schema.String;
        readonly context: Schema.String;
        readonly task: Schema.String;
        readonly format: Schema.String;
        readonly constraints: Schema.$Array<Schema.String>;
        readonly successCriteria: Schema.$Array<Schema.String>;
        readonly outOfScope: Schema.$Array<Schema.String>;
    }>;
    readonly score: Schema.Number;
    readonly scoreReason: Schema.String;
    readonly nextQuestion: Schema.String;
    readonly nextPrinciple: Schema.Literals<readonly ["definition", "elenchus", "hypothesis-elimination", "generalization", "induction", "dialectic", "maieutic", "analogy", "irony", "recollection", "none"]>;
    readonly resolved: Schema.Boolean;
    readonly overridden: Schema.Boolean;
    readonly overrideReason: Schema.NullOr<Schema.String>;
}>;
/** A prompt a caller's cache returned for the same key. */
export declare const CachedPrompt: Schema.Struct<{
    readonly key: Schema.String;
    readonly prompt: Schema.String;
    readonly structured: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly schema: Schema.Literals<readonly ["rctf", "prd", "freeform"]>;
    readonly stakes: Schema.Literals<readonly ["high", "low"]>;
    readonly score: Schema.Number;
    readonly scoreReason: Schema.String;
    readonly createdAt: Schema.String;
    readonly source: Schema.Literals<readonly ["extracted", "manual"]>;
    readonly overridden: Schema.Boolean;
}>;
/** One draft: refine the prior draft with the person's answer, ask one question, and self-score. */
export declare const Draft: AgentAction.AgentAction<"examples/ExtractPrompt/Draft", Schema.Struct<{
    context: Schema.String;
    threshold: Schema.Number;
    stakes: Schema.Literals<readonly ["high", "low"]>;
    priorDraft: Schema.optional<Schema.Struct<{
        readonly prompt: Schema.String;
        readonly structured: Schema.Struct<{
            readonly role: Schema.String;
            readonly context: Schema.String;
            readonly task: Schema.String;
            readonly format: Schema.String;
            readonly constraints: Schema.$Array<Schema.String>;
            readonly successCriteria: Schema.$Array<Schema.String>;
            readonly outOfScope: Schema.$Array<Schema.String>;
        }>;
        readonly score: Schema.Number;
        readonly scoreReason: Schema.String;
        readonly nextQuestion: Schema.String;
        readonly nextPrinciple: Schema.Literals<readonly ["definition", "elenchus", "hypothesis-elimination", "generalization", "induction", "dialectic", "maieutic", "analogy", "irony", "recollection", "none"]>;
        readonly resolved: Schema.Boolean;
        readonly overridden: Schema.Boolean;
        readonly overrideReason: Schema.NullOr<Schema.String>;
    }>>;
    answer: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly prompt: Schema.String;
    readonly structured: Schema.Struct<{
        readonly role: Schema.String;
        readonly context: Schema.String;
        readonly task: Schema.String;
        readonly format: Schema.String;
        readonly constraints: Schema.$Array<Schema.String>;
        readonly successCriteria: Schema.$Array<Schema.String>;
        readonly outOfScope: Schema.$Array<Schema.String>;
    }>;
    readonly score: Schema.Number;
    readonly scoreReason: Schema.String;
    readonly nextQuestion: Schema.String;
    readonly nextPrinciple: Schema.Literals<readonly ["definition", "elenchus", "hypothesis-elimination", "generalization", "induction", "dialectic", "maieutic", "analogy", "irony", "recollection", "none"]>;
    readonly resolved: Schema.Boolean;
    readonly overridden: Schema.Boolean;
    readonly overrideReason: Schema.NullOr<Schema.String>;
}>>;
type Requirements = Action.Requirement<"examples/ExtractPrompt/Draft">;
/** The flow. Its payload is real at plan time, so the passthroughs are decided before anything runs. */
export declare const ExtractPrompt: Flow.Flow<"examples/ExtractPrompt", Schema.Struct<{
    prompt: Schema.optional<Schema.String>;
    cached: Schema.optional<Schema.Struct<{
        readonly key: Schema.String;
        readonly prompt: Schema.String;
        readonly structured: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
        readonly schema: Schema.Literals<readonly ["rctf", "prd", "freeform"]>;
        readonly stakes: Schema.Literals<readonly ["high", "low"]>;
        readonly score: Schema.Number;
        readonly scoreReason: Schema.String;
        readonly createdAt: Schema.String;
        readonly source: Schema.Literals<readonly ["extracted", "manual"]>;
        readonly overridden: Schema.Boolean;
    }>>;
    stakes: Schema.optional<Schema.Literals<readonly ["high", "low"]>>;
    threshold: Schema.optional<Schema.Number>;
    maxTurns: Schema.optional<Schema.Int>;
    context: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly prompt: Schema.String;
    readonly structured: Schema.Struct<{
        readonly role: Schema.String;
        readonly context: Schema.String;
        readonly task: Schema.String;
        readonly format: Schema.String;
        readonly constraints: Schema.$Array<Schema.String>;
        readonly successCriteria: Schema.$Array<Schema.String>;
        readonly outOfScope: Schema.$Array<Schema.String>;
    }>;
    readonly score: Schema.Number;
    readonly scoreReason: Schema.String;
    readonly nextQuestion: Schema.String;
    readonly nextPrinciple: Schema.Literals<readonly ["definition", "elenchus", "hypothesis-elimination", "generalization", "induction", "dialectic", "maieutic", "analogy", "irony", "recollection", "none"]>;
    readonly resolved: Schema.Boolean;
    readonly overridden: Schema.Boolean;
    readonly overrideReason: Schema.NullOr<Schema.String>;
}>, Schema.Union<readonly [Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, typeof HumanTask.HumanTaskFailed]>, Requirements>;
/** Every step the flow calls. */
export declare const layer: import("effect/Layer").Layer<Action.Requirement<"examples/ExtractPrompt/Draft">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
export {};
