/**
 * Identify a document's family, resolve the output schema for it at run time, and extract into that shape.
 *
 * Port of the 0.x `dynamic-schema-enricher.jsx`. A context agent names the
 * document's source, tenant and family. A resolver agent turns that into a
 * field specification with tenant overrides, an extractor agent fills those
 * fields from the raw content, and an output agent validates the extraction
 * into the typed record the flow settles with. The four steps run in order.
 *
 * 0.x declared the context and output steps with no agent, so each emitted its prompt element as a static value its schema could not accept; here both are agent steps, as their prompts and schemas intend.
 * 0.x's prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the resolver and extractor `read`, `bash` and `grep`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The document families the context step chooses from. */
export declare const DocumentFamily: Schema.Literals<readonly ["invoice", "contract", "receipt", "onboarding", "support-ticket", "unknown"]>;
/** Who sent the document, for whom, and what kind of document it is. */
export declare const Context: Schema.Struct<{
    readonly source: Schema.String;
    readonly tenant: Schema.String;
    readonly documentFamily: Schema.Literals<readonly ["invoice", "contract", "receipt", "onboarding", "support-ticket", "unknown"]>;
    readonly rawContent: Schema.String;
    readonly detectedLanguage: Schema.String;
    readonly summary: Schema.String;
}>;
/** One field of a resolved schema. */
export declare const FieldSpec: Schema.Struct<{
    readonly name: Schema.String;
    readonly type: Schema.Literals<readonly ["string", "number", "boolean", "date", "array", "object"]>;
    readonly required: Schema.Boolean;
    readonly description: Schema.String;
}>;
/** A tenant's rule for one field. */
export declare const TenantOverride: Schema.Struct<{
    readonly field: Schema.String;
    readonly rule: Schema.String;
}>;
/** The output schema the resolver chose for this document. */
export declare const ResolvedSchema: Schema.Struct<{
    readonly schemaId: Schema.String;
    readonly schemaFamily: Schema.String;
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly type: Schema.Literals<readonly ["string", "number", "boolean", "date", "array", "object"]>;
        readonly required: Schema.Boolean;
        readonly description: Schema.String;
    }>>;
    readonly tenantOverrides: Schema.$Array<Schema.Struct<{
        readonly field: Schema.String;
        readonly rule: Schema.String;
    }>>;
    readonly confidence: Schema.Number;
    readonly summary: Schema.String;
}>;
/** The fields the extractor filled. */
export declare const Extraction: Schema.Struct<{
    readonly schemaId: Schema.String;
    readonly extractedFields: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly missingRequired: Schema.$Array<Schema.String>;
    readonly warnings: Schema.$Array<Schema.String>;
    readonly extractionConfidence: Schema.Number;
    readonly summary: Schema.String;
}>;
/** The validated record the flow settles with. */
export declare const TypedOutput: Schema.Struct<{
    readonly schemaId: Schema.String;
    readonly tenant: Schema.String;
    readonly documentFamily: Schema.String;
    readonly payload: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly valid: Schema.Boolean;
    readonly validationErrors: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** Names the document's source, tenant and family. */
export declare const ParseContext: AgentAction.AgentAction<"examples/DynamicSchemaEnricher/Context", Schema.Struct<{
    rawInput: Schema.String;
    source: Schema.String;
    tenant: Schema.String;
}>, Schema.Struct<{
    readonly source: Schema.String;
    readonly tenant: Schema.String;
    readonly documentFamily: Schema.Literals<readonly ["invoice", "contract", "receipt", "onboarding", "support-ticket", "unknown"]>;
    readonly rawContent: Schema.String;
    readonly detectedLanguage: Schema.String;
    readonly summary: Schema.String;
}>>;
/** Chooses the schema for the document's family and tenant. */
export declare const Resolve: AgentAction.AgentAction<"examples/DynamicSchemaEnricher/Resolve", Schema.Struct<{
    documentFamily: Schema.String;
    tenant: Schema.String;
    source: Schema.String;
    detectedLanguage: Schema.String;
    schemaRegistry: Schema.String;
}>, Schema.Struct<{
    readonly schemaId: Schema.String;
    readonly schemaFamily: Schema.String;
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly type: Schema.Literals<readonly ["string", "number", "boolean", "date", "array", "object"]>;
        readonly required: Schema.Boolean;
        readonly description: Schema.String;
    }>>;
    readonly tenantOverrides: Schema.$Array<Schema.Struct<{
        readonly field: Schema.String;
        readonly rule: Schema.String;
    }>>;
    readonly confidence: Schema.Number;
    readonly summary: Schema.String;
}>>;
/** Fills the resolved schema's fields from the raw content. */
export declare const Extract: AgentAction.AgentAction<"examples/DynamicSchemaEnricher/Extract", Schema.Struct<{
    rawContent: Schema.String;
    schemaId: Schema.String;
    fields: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly type: Schema.Literals<readonly ["string", "number", "boolean", "date", "array", "object"]>;
        readonly required: Schema.Boolean;
        readonly description: Schema.String;
    }>>;
    tenantOverrides: Schema.$Array<Schema.Struct<{
        readonly field: Schema.String;
        readonly rule: Schema.String;
    }>>;
}>, Schema.Struct<{
    readonly schemaId: Schema.String;
    readonly extractedFields: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly missingRequired: Schema.$Array<Schema.String>;
    readonly warnings: Schema.$Array<Schema.String>;
    readonly extractionConfidence: Schema.Number;
    readonly summary: Schema.String;
}>>;
/** Validates the extraction into the final typed record. */
export declare const Output: AgentAction.AgentAction<"examples/DynamicSchemaEnricher/Output", Schema.Struct<{
    schemaId: Schema.String;
    tenant: Schema.String;
    documentFamily: Schema.String;
    extractedFields: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    missingRequired: Schema.$Array<Schema.String>;
    warnings: Schema.$Array<Schema.String>;
    confidence: Schema.Number;
}>, Schema.Struct<{
    readonly schemaId: Schema.String;
    readonly tenant: Schema.String;
    readonly documentFamily: Schema.String;
    readonly payload: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly valid: Schema.Boolean;
    readonly validationErrors: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** The flow: context, resolve, extract, output. */
export declare const DynamicSchemaEnricher: Flow.Flow<"examples/DynamicSchemaEnricher", Schema.Struct<{
    document: Schema.optional<Schema.String>;
    source: Schema.optional<Schema.String>;
    tenant: Schema.optional<Schema.String>;
    schemaRegistry: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly schemaId: Schema.String;
    readonly tenant: Schema.String;
    readonly documentFamily: Schema.String;
    readonly payload: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly valid: Schema.Boolean;
    readonly validationErrors: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/DynamicSchemaEnricher/Context"> | import("@smthrs/flow/Action").Requirement<"examples/DynamicSchemaEnricher/Extract"> | import("@smthrs/flow/Action").Requirement<"examples/DynamicSchemaEnricher/Output"> | import("@smthrs/flow/Action").Requirement<"examples/DynamicSchemaEnricher/Resolve">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/DynamicSchemaEnricher/Context"> | import("@smthrs/flow/Action").Requirement<"examples/DynamicSchemaEnricher/Extract"> | import("@smthrs/flow/Action").Requirement<"examples/DynamicSchemaEnricher/Output"> | import("@smthrs/flow/Action").Requirement<"examples/DynamicSchemaEnricher/Resolve">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
