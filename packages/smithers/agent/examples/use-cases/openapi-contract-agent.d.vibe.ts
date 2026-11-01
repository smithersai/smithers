/**
 * Convert an OpenAPI or JSON Schema contract into typed interfaces and checked sample calls.
 *
 * Port of the 0.x `openapi-contract-agent.jsx`. A parser agent normalizes the
 * spec into endpoints and shared models, a generator agent writes TypeScript
 * interfaces, an equivalent zod schema per interface, and an input and output
 * type per operation, and a call-builder agent writes a sample typed call per
 * endpoint, flags mismatches, and reports coverage. The three steps run in
 * sequence with no branch.
 *
 * The flow settles with the interfaces and the calls; 0.x left them in its output tables.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The spec, normalized. */
export declare const ContractSource: Schema.Struct<{
    readonly specFormat: Schema.Literals<readonly ["openapi-3.0", "openapi-3.1", "json-schema-draft-07", "json-schema-draft-2020"]>;
    readonly endpoints: Schema.$Array<Schema.Struct<{
        readonly method: Schema.Literals<readonly ["GET", "POST", "PUT", "PATCH", "DELETE"]>;
        readonly path: Schema.String;
        readonly operationId: Schema.String;
        readonly summary: Schema.String;
        readonly requestBodySchema: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
        readonly responseSchema: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
        readonly parameters: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly in: Schema.Literals<readonly ["path", "query", "header"]>;
            readonly required: Schema.Boolean;
            readonly schemaType: Schema.String;
        }>>>;
    }>>;
    readonly sharedModels: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly properties: Schema.$Record<Schema.String, Schema.Struct<{
            readonly type: Schema.String;
            readonly description: Schema.optional<Schema.String>;
            readonly required: Schema.optional<Schema.Boolean>;
        }>>;
    }>>;
}>;
/** The generated interfaces and operation signatures. */
export declare const Interfaces: Schema.Struct<{
    readonly interfaces: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly source: Schema.String;
        readonly fields: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly type: Schema.String;
            readonly optional: Schema.Boolean;
            readonly description: Schema.optional<Schema.String>;
        }>>;
        readonly zodSchema: Schema.String;
    }>>;
    readonly operationSignatures: Schema.$Array<Schema.Struct<{
        readonly operationId: Schema.String;
        readonly method: Schema.String;
        readonly path: Schema.String;
        readonly inputType: Schema.String;
        readonly outputType: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>;
/** One sample typed call per endpoint, with coverage. */
export declare const TypedCalls: Schema.Struct<{
    readonly calls: Schema.$Array<Schema.Struct<{
        readonly operationId: Schema.String;
        readonly endpoint: Schema.String;
        readonly inputInterface: Schema.String;
        readonly outputInterface: Schema.String;
        readonly samplePayload: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
        readonly expectedShape: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
        readonly validationNotes: Schema.$Array<Schema.String>;
    }>>;
    readonly coverage: Schema.Struct<{
        readonly totalEndpoints: Schema.Number;
        readonly typedEndpoints: Schema.Number;
        readonly warnings: Schema.$Array<Schema.String>;
    }>;
    readonly summary: Schema.String;
}>;
/** What the flow settles with. */
export declare const Output: Schema.Struct<{
    readonly interfaces: Schema.Struct<{
        readonly interfaces: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly source: Schema.String;
            readonly fields: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly type: Schema.String;
                readonly optional: Schema.Boolean;
                readonly description: Schema.optional<Schema.String>;
            }>>;
            readonly zodSchema: Schema.String;
        }>>;
        readonly operationSignatures: Schema.$Array<Schema.Struct<{
            readonly operationId: Schema.String;
            readonly method: Schema.String;
            readonly path: Schema.String;
            readonly inputType: Schema.String;
            readonly outputType: Schema.String;
        }>>;
        readonly summary: Schema.String;
    }>;
    readonly typedCalls: Schema.Struct<{
        readonly calls: Schema.$Array<Schema.Struct<{
            readonly operationId: Schema.String;
            readonly endpoint: Schema.String;
            readonly inputInterface: Schema.String;
            readonly outputInterface: Schema.String;
            readonly samplePayload: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
            readonly expectedShape: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
            readonly validationNotes: Schema.$Array<Schema.String>;
        }>>;
        readonly coverage: Schema.Struct<{
            readonly totalEndpoints: Schema.Number;
            readonly typedEndpoints: Schema.Number;
            readonly warnings: Schema.$Array<Schema.String>;
        }>;
        readonly summary: Schema.String;
    }>;
}>;
/** Normalizes the raw spec. */
export declare const ParseContract: AgentAction.AgentAction<"examples/OpenApiContractAgent/ParseContract", Schema.Struct<{
    specPath: Schema.optional<Schema.String>;
    specContent: Schema.optional<Schema.String>;
    format: Schema.String;
    filterPaths: Schema.optional<Schema.$Array<Schema.String>>;
}>, Schema.Struct<{
    readonly specFormat: Schema.Literals<readonly ["openapi-3.0", "openapi-3.1", "json-schema-draft-07", "json-schema-draft-2020"]>;
    readonly endpoints: Schema.$Array<Schema.Struct<{
        readonly method: Schema.Literals<readonly ["GET", "POST", "PUT", "PATCH", "DELETE"]>;
        readonly path: Schema.String;
        readonly operationId: Schema.String;
        readonly summary: Schema.String;
        readonly requestBodySchema: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
        readonly responseSchema: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
        readonly parameters: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly in: Schema.Literals<readonly ["path", "query", "header"]>;
            readonly required: Schema.Boolean;
            readonly schemaType: Schema.String;
        }>>>;
    }>>;
    readonly sharedModels: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly properties: Schema.$Record<Schema.String, Schema.Struct<{
            readonly type: Schema.String;
            readonly description: Schema.optional<Schema.String>;
            readonly required: Schema.optional<Schema.Boolean>;
        }>>;
    }>>;
}>>;
/** Writes the interfaces, zod schemas and operation signatures. */
export declare const GenerateInterfaces: AgentAction.AgentAction<"examples/OpenApiContractAgent/GenerateInterfaces", Schema.Struct<{
    contract: Schema.Struct<{
        readonly specFormat: Schema.Literals<readonly ["openapi-3.0", "openapi-3.1", "json-schema-draft-07", "json-schema-draft-2020"]>;
        readonly endpoints: Schema.$Array<Schema.Struct<{
            readonly method: Schema.Literals<readonly ["GET", "POST", "PUT", "PATCH", "DELETE"]>;
            readonly path: Schema.String;
            readonly operationId: Schema.String;
            readonly summary: Schema.String;
            readonly requestBodySchema: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
            readonly responseSchema: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
            readonly parameters: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly in: Schema.Literals<readonly ["path", "query", "header"]>;
                readonly required: Schema.Boolean;
                readonly schemaType: Schema.String;
            }>>>;
        }>>;
        readonly sharedModels: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly properties: Schema.$Record<Schema.String, Schema.Struct<{
                readonly type: Schema.String;
                readonly description: Schema.optional<Schema.String>;
                readonly required: Schema.optional<Schema.Boolean>;
            }>>;
        }>>;
    }>;
    naming: Schema.String;
    includeZod: Schema.Boolean;
    brandedIds: Schema.Boolean;
}>, Schema.Struct<{
    readonly interfaces: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly source: Schema.String;
        readonly fields: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly type: Schema.String;
            readonly optional: Schema.Boolean;
            readonly description: Schema.optional<Schema.String>;
        }>>;
        readonly zodSchema: Schema.String;
    }>>;
    readonly operationSignatures: Schema.$Array<Schema.Struct<{
        readonly operationId: Schema.String;
        readonly method: Schema.String;
        readonly path: Schema.String;
        readonly inputType: Schema.String;
        readonly outputType: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>>;
/** Writes and checks a sample typed call per endpoint. */
export declare const TypedCallsStep: AgentAction.AgentAction<"examples/OpenApiContractAgent/TypedCalls", Schema.Struct<{
    interfaces: Schema.Struct<{
        readonly interfaces: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly source: Schema.String;
            readonly fields: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly type: Schema.String;
                readonly optional: Schema.Boolean;
                readonly description: Schema.optional<Schema.String>;
            }>>;
            readonly zodSchema: Schema.String;
        }>>;
        readonly operationSignatures: Schema.$Array<Schema.Struct<{
            readonly operationId: Schema.String;
            readonly method: Schema.String;
            readonly path: Schema.String;
            readonly inputType: Schema.String;
            readonly outputType: Schema.String;
        }>>;
        readonly summary: Schema.String;
    }>;
    contract: Schema.Struct<{
        readonly specFormat: Schema.Literals<readonly ["openapi-3.0", "openapi-3.1", "json-schema-draft-07", "json-schema-draft-2020"]>;
        readonly endpoints: Schema.$Array<Schema.Struct<{
            readonly method: Schema.Literals<readonly ["GET", "POST", "PUT", "PATCH", "DELETE"]>;
            readonly path: Schema.String;
            readonly operationId: Schema.String;
            readonly summary: Schema.String;
            readonly requestBodySchema: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
            readonly responseSchema: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
            readonly parameters: Schema.optional<Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly in: Schema.Literals<readonly ["path", "query", "header"]>;
                readonly required: Schema.Boolean;
                readonly schemaType: Schema.String;
            }>>>;
        }>>;
        readonly sharedModels: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly properties: Schema.$Record<Schema.String, Schema.Struct<{
                readonly type: Schema.String;
                readonly description: Schema.optional<Schema.String>;
                readonly required: Schema.optional<Schema.Boolean>;
            }>>;
        }>>;
    }>;
    baseUrl: Schema.String;
    authScheme: Schema.String;
}>, Schema.Struct<{
    readonly calls: Schema.$Array<Schema.Struct<{
        readonly operationId: Schema.String;
        readonly endpoint: Schema.String;
        readonly inputInterface: Schema.String;
        readonly outputInterface: Schema.String;
        readonly samplePayload: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
        readonly expectedShape: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
        readonly validationNotes: Schema.$Array<Schema.String>;
    }>>;
    readonly coverage: Schema.Struct<{
        readonly totalEndpoints: Schema.Number;
        readonly typedEndpoints: Schema.Number;
        readonly warnings: Schema.$Array<Schema.String>;
    }>;
    readonly summary: Schema.String;
}>>;
/** The flow: parse, generate, build calls. */
export declare const OpenApiContractAgent: Flow.Flow<"examples/OpenApiContractAgent", Schema.Struct<{
    specPath: Schema.optional<Schema.String>;
    specContent: Schema.optional<Schema.String>;
    format: Schema.optional<Schema.String>;
    filterPaths: Schema.optional<Schema.$Array<Schema.String>>;
    namingConvention: Schema.optional<Schema.String>;
    includeZod: Schema.optional<Schema.Boolean>;
    brandedIds: Schema.optional<Schema.Boolean>;
    baseUrl: Schema.optional<Schema.String>;
    authScheme: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly interfaces: Schema.Struct<{
        readonly interfaces: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly source: Schema.String;
            readonly fields: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly type: Schema.String;
                readonly optional: Schema.Boolean;
                readonly description: Schema.optional<Schema.String>;
            }>>;
            readonly zodSchema: Schema.String;
        }>>;
        readonly operationSignatures: Schema.$Array<Schema.Struct<{
            readonly operationId: Schema.String;
            readonly method: Schema.String;
            readonly path: Schema.String;
            readonly inputType: Schema.String;
            readonly outputType: Schema.String;
        }>>;
        readonly summary: Schema.String;
    }>;
    readonly typedCalls: Schema.Struct<{
        readonly calls: Schema.$Array<Schema.Struct<{
            readonly operationId: Schema.String;
            readonly endpoint: Schema.String;
            readonly inputInterface: Schema.String;
            readonly outputInterface: Schema.String;
            readonly samplePayload: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
            readonly expectedShape: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
            readonly validationNotes: Schema.$Array<Schema.String>;
        }>>;
        readonly coverage: Schema.Struct<{
            readonly totalEndpoints: Schema.Number;
            readonly typedEndpoints: Schema.Number;
            readonly warnings: Schema.$Array<Schema.String>;
        }>;
        readonly summary: Schema.String;
    }>;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/OpenApiContractAgent/GenerateInterfaces"> | import("@smthrs/flow/Action").Requirement<"examples/OpenApiContractAgent/ParseContract"> | import("@smthrs/flow/Action").Requirement<"examples/OpenApiContractAgent/TypedCalls">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/OpenApiContractAgent/GenerateInterfaces"> | import("@smthrs/flow/Action").Requirement<"examples/OpenApiContractAgent/ParseContract"> | import("@smthrs/flow/Action").Requirement<"examples/OpenApiContractAgent/TypedCalls">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
