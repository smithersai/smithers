/**
 * Extract known form fields, collect the missing required ones over bounded rounds, validate, and submit.
 *
 * Port of the 0.x `form-filler-assistant.jsx`. An extractor agent reads the
 * documents and user input into known and missing fields. When a required
 * field is missing, a clarification agent works through the user responses
 * the payload supplies, one round at a time, until it reports every required
 * field collected or `maxClarifications` rounds (default 5) have run. A
 * validator agent then normalizes the full field set, and only a valid
 * payload goes to the submission agent (target `stdout`, method `dry-run` by
 * default).
 *
 * As in 0.x, the clarification rounds read `userResponses` from the payload; no step waits on a person.
 * 0.x declared `validate` with a prompt but no agent, so it could not produce its schema; here it is an agent step.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts written from the same props.
 * 0.x gave the agents `read`, `grep`, `bash` and `write` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { type Action, Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One field value and where it came from. */
export declare const FieldEntry: Schema.Struct<{
    readonly name: Schema.String;
    readonly value: Schema.String;
    readonly source: Schema.Literals<readonly ["document", "user-input", "inferred"]>;
    readonly confidence: Schema.Number;
}>;
/** A field the sources did not fill. */
export declare const MissingField: Schema.Struct<{
    readonly name: Schema.String;
    readonly description: Schema.String;
    readonly required: Schema.Boolean;
}>;
/** The extractor's answer. */
export declare const Extraction: Schema.Struct<{
    readonly knownFields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly value: Schema.String;
        readonly source: Schema.Literals<readonly ["document", "user-input", "inferred"]>;
        readonly confidence: Schema.Number;
    }>>;
    readonly missingFields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly description: Schema.String;
        readonly required: Schema.Boolean;
    }>>;
    readonly documentType: Schema.String;
    readonly summary: Schema.String;
}>;
/** One clarification round's answer. */
export declare const Clarification: Schema.Struct<{
    readonly answeredFields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly value: Schema.String;
        readonly source: Schema.Literals<readonly ["document", "user-input", "inferred"]>;
        readonly confidence: Schema.Number;
    }>>;
    readonly stillMissing: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly description: Schema.String;
        readonly required: Schema.Boolean;
    }>>;
    readonly allRequiredCollected: Schema.Boolean;
    readonly summary: Schema.String;
}>;
/** The validated, normalized field set. */
export declare const Validation: Schema.Struct<{
    readonly valid: Schema.Boolean;
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly value: Schema.String;
        readonly valid: Schema.Boolean;
        readonly error: Schema.optional<Schema.String>;
    }>>;
    readonly normalizedPayload: Schema.$Record<Schema.String, Schema.String>;
    readonly summary: Schema.String;
}>;
/** What the submission did. */
export declare const Submission: Schema.Struct<{
    readonly target: Schema.String;
    readonly status: Schema.Literals<readonly ["submitted", "dry-run", "failed"]>;
    readonly responseCode: Schema.optional<Schema.Number>;
    readonly confirmationId: Schema.optional<Schema.String>;
    readonly fieldCount: Schema.Number;
    readonly summary: Schema.String;
}>;
/** What the flow settles with. `submission` is null when validation failed. */
export declare const Output: Schema.Struct<{
    readonly validation: Schema.Struct<{
        readonly valid: Schema.Boolean;
        readonly fields: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly value: Schema.String;
            readonly valid: Schema.Boolean;
            readonly error: Schema.optional<Schema.String>;
        }>>;
        readonly normalizedPayload: Schema.$Record<Schema.String, Schema.String>;
        readonly summary: Schema.String;
    }>;
    readonly submission: Schema.NullOr<Schema.Struct<{
        readonly target: Schema.String;
        readonly status: Schema.Literals<readonly ["submitted", "dry-run", "failed"]>;
        readonly responseCode: Schema.optional<Schema.Number>;
        readonly confirmationId: Schema.optional<Schema.String>;
        readonly fieldCount: Schema.Number;
        readonly summary: Schema.String;
    }>>;
}>;
/** Reads the documents and user input into known and missing fields. */
export declare const Extract: AgentAction.AgentAction<"examples/FormFillerAssistant/Extract", Schema.Struct<{
    documents: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    userInput: Schema.String;
    formSchema: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, Schema.Struct<{
    readonly knownFields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly value: Schema.String;
        readonly source: Schema.Literals<readonly ["document", "user-input", "inferred"]>;
        readonly confidence: Schema.Number;
    }>>;
    readonly missingFields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly description: Schema.String;
        readonly required: Schema.Boolean;
    }>>;
    readonly documentType: Schema.String;
    readonly summary: Schema.String;
}>>;
/** One round of collecting the missing fields. */
export declare const Clarify: AgentAction.AgentAction<"examples/FormFillerAssistant/Clarify", Schema.Struct<{
    knownFields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly value: Schema.String;
        readonly source: Schema.Literals<readonly ["document", "user-input", "inferred"]>;
        readonly confidence: Schema.Number;
    }>>;
    missingFields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly description: Schema.String;
        readonly required: Schema.Boolean;
    }>>;
    previousAnswers: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly value: Schema.String;
        readonly source: Schema.Literals<readonly ["document", "user-input", "inferred"]>;
        readonly confidence: Schema.Number;
    }>>;
    userResponses: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly answeredFields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly value: Schema.String;
        readonly source: Schema.Literals<readonly ["document", "user-input", "inferred"]>;
        readonly confidence: Schema.Number;
    }>>;
    readonly stillMissing: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly description: Schema.String;
        readonly required: Schema.Boolean;
    }>>;
    readonly allRequiredCollected: Schema.Boolean;
    readonly summary: Schema.String;
}>>;
/** Validates and normalizes the complete field set. */
export declare const Validate: AgentAction.AgentAction<"examples/FormFillerAssistant/Validate", Schema.Struct<{
    knownFields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly value: Schema.String;
        readonly source: Schema.Literals<readonly ["document", "user-input", "inferred"]>;
        readonly confidence: Schema.Number;
    }>>;
    collectedFields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly value: Schema.String;
        readonly source: Schema.Literals<readonly ["document", "user-input", "inferred"]>;
        readonly confidence: Schema.Number;
    }>>;
    formSchema: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, Schema.Struct<{
    readonly valid: Schema.Boolean;
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly value: Schema.String;
        readonly valid: Schema.Boolean;
        readonly error: Schema.optional<Schema.String>;
    }>>;
    readonly normalizedPayload: Schema.$Record<Schema.String, Schema.String>;
    readonly summary: Schema.String;
}>>;
/** Submits a validated payload to the target. */
export declare const Submit: AgentAction.AgentAction<"examples/FormFillerAssistant/Submit", Schema.Struct<{
    payload: Schema.$Record<Schema.String, Schema.String>;
    target: Schema.String;
    method: Schema.String;
    dryRun: Schema.Boolean;
}>, Schema.Struct<{
    readonly target: Schema.String;
    readonly status: Schema.Literals<readonly ["submitted", "dry-run", "failed"]>;
    readonly responseCode: Schema.optional<Schema.Number>;
    readonly confirmationId: Schema.optional<Schema.String>;
    readonly fieldCount: Schema.Number;
    readonly summary: Schema.String;
}>>;
type Requirements = Action.Requirement<"examples/FormFillerAssistant/Extract" | "examples/FormFillerAssistant/Clarify" | "examples/FormFillerAssistant/Validate" | "examples/FormFillerAssistant/Submit">;
/** The flow: extract, clarify while required fields are missing, validate, submit. */
export declare const FormFillerAssistant: Flow.Flow<"examples/FormFillerAssistant", Schema.Struct<{
    documents: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    userInput: Schema.optional<Schema.String>;
    formSchema: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    userResponses: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    maxClarifications: Schema.optional<Schema.Int>;
    target: Schema.optional<Schema.String>;
    method: Schema.optional<Schema.String>;
    dryRun: Schema.optional<Schema.Boolean>;
}>, Schema.Struct<{
    readonly validation: Schema.Struct<{
        readonly valid: Schema.Boolean;
        readonly fields: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly value: Schema.String;
            readonly valid: Schema.Boolean;
            readonly error: Schema.optional<Schema.String>;
        }>>;
        readonly normalizedPayload: Schema.$Record<Schema.String, Schema.String>;
        readonly summary: Schema.String;
    }>;
    readonly submission: Schema.NullOr<Schema.Struct<{
        readonly target: Schema.String;
        readonly status: Schema.Literals<readonly ["submitted", "dry-run", "failed"]>;
        readonly responseCode: Schema.optional<Schema.Number>;
        readonly confirmationId: Schema.optional<Schema.String>;
        readonly fieldCount: Schema.Number;
        readonly summary: Schema.String;
    }>>;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, Action.Requirement<"examples/FormFillerAssistant/Extract"> | Requirements>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<Action.Requirement<"examples/FormFillerAssistant/Clarify"> | Action.Requirement<"examples/FormFillerAssistant/Extract"> | Action.Requirement<"examples/FormFillerAssistant/Submit"> | Action.Requirement<"examples/FormFillerAssistant/Validate">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
export {};
