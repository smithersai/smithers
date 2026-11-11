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
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const JsonObject = Schema.Record(Schema.String, Schema.Json)

/** The spec, normalized. */
export const ContractSource = Schema.Struct({
  specFormat: Schema.Literals(["openapi-3.0", "openapi-3.1", "json-schema-draft-07", "json-schema-draft-2020"]),
  endpoints: Schema.Array(Schema.Struct({
    method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: Schema.String.annotate({ description: "API path, e.g. /users/{id}" }),
    operationId: Schema.String,
    summary: Schema.String,
    requestBodySchema: Schema.optional(JsonObject),
    responseSchema: Schema.optional(JsonObject),
    parameters: Schema.optional(Schema.Array(Schema.Struct({
      name: Schema.String,
      in: Schema.Literals(["path", "query", "header"]),
      required: Schema.Boolean,
      schemaType: Schema.String
    })))
  })),
  sharedModels: Schema.Array(Schema.Struct({
    name: Schema.String.annotate({ description: "Model/component name, e.g. User" }),
    properties: Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.String,
        description: Schema.optional(Schema.String),
        required: Schema.optional(Schema.Boolean)
      })
    )
  }))
})

/** The generated interfaces and operation signatures. */
export const Interfaces = Schema.Struct({
  interfaces: Schema.Array(Schema.Struct({
    name: Schema.String.annotate({ description: "TypeScript interface name" }),
    source: Schema.String.annotate({ description: "Originating schema component or endpoint" }),
    fields: Schema.Array(Schema.Struct({
      name: Schema.String,
      type: Schema.String.annotate({ description: "TypeScript type expression" }),
      optional: Schema.Boolean,
      description: Schema.optional(Schema.String)
    })),
    zodSchema: Schema.String.annotate({ description: "Equivalent zod schema as a code string" })
  })),
  operationSignatures: Schema.Array(Schema.Struct({
    operationId: Schema.String,
    method: Schema.String,
    path: Schema.String,
    inputType: Schema.String.annotate({ description: "Name of the request interface" }),
    outputType: Schema.String.annotate({ description: "Name of the response interface" })
  })),
  summary: Schema.String
})

/** One sample typed call per endpoint, with coverage. */
export const TypedCalls = Schema.Struct({
  calls: Schema.Array(Schema.Struct({
    operationId: Schema.String,
    endpoint: Schema.String.annotate({ description: "Full method + path" }),
    inputInterface: Schema.String,
    outputInterface: Schema.String,
    samplePayload: JsonObject.annotate({ description: "Example typed request body" }),
    expectedShape: JsonObject.annotate({ description: "Example typed response shape" }),
    validationNotes: Schema.Array(Schema.String).annotate({ description: "Any type mismatches or warnings" })
  })),
  coverage: Schema.Struct({
    totalEndpoints: Schema.Number,
    typedEndpoints: Schema.Number,
    warnings: Schema.Array(Schema.String)
  }),
  summary: Schema.String
})

/** What the flow settles with. */
export const Output = Schema.Struct({ interfaces: Interfaces, typedCalls: TypedCalls })

/** Normalizes the raw spec. */
export const ParseContract = AgentAction.make("examples/OpenApiContractAgent/ParseContract", {
  payload: {
    specPath: Schema.optional(Schema.String),
    specContent: Schema.optional(Schema.String),
    format: Schema.String,
    filterPaths: Schema.optional(Schema.Array(Schema.String))
  },
  output: ContractSource,
  seat,
  system: [
    `You are an OpenAPI and JSON Schema specialist. Parse raw API specifications
into a normalized contract source representation. Identify all endpoints, HTTP methods,
operation IDs, request/response schemas, parameters, and shared model definitions.
Handle both OpenAPI 3.x and JSON Schema drafts. Resolve $ref pointers and inline definitions.`
  ],
  prompt: ({ filterPaths, format, specContent, specPath }) =>
    `Parse this ${format} spec into a normalized contract source.\n\nSpec path: ${specPath ?? "none"}\nFilter paths: ${
      JSON.stringify(filterPaths ?? [])
    }\nSpec content: ${JSON.stringify(specContent ?? "")}`
})

/** Writes the interfaces, zod schemas and operation signatures. */
export const GenerateInterfaces = AgentAction.make("examples/OpenApiContractAgent/GenerateInterfaces", {
  payload: { contract: ContractSource, naming: Schema.String, includeZod: Schema.Boolean, brandedIds: Schema.Boolean },
  output: Interfaces,
  seat,
  system: [
    `You are a TypeScript interface generator. Given a parsed contract source,
produce strongly-typed TypeScript interfaces and equivalent zod schemas for every model
and every request/response pair. Generate operation signatures mapping each endpoint to
its input and output types. Prefer precise types over 'any'. Use branded types where IDs
or dates appear. Ensure naming consistency across interfaces.`
  ],
  prompt: ({ brandedIds, contract, includeZod, naming }) =>
    `Generate interfaces for this contract.\n\nNaming: ${naming}\nInclude zod: ${includeZod}\nBranded IDs: ${brandedIds}\nContract: ${
      JSON.stringify(contract)
    }`
})

/** Writes and checks a sample typed call per endpoint. */
export const TypedCallsStep = AgentAction.make("examples/OpenApiContractAgent/TypedCalls", {
  payload: { interfaces: Interfaces, contract: ContractSource, baseUrl: Schema.String, authScheme: Schema.String },
  output: TypedCalls,
  seat,
  system: [
    `You are a typed API call builder. Given generated interfaces and operation
signatures, produce sample typed calls for every endpoint. Validate that request payloads
conform to input interfaces and response shapes match output interfaces. Flag any type
mismatches, missing required fields, or schema drift. Report coverage statistics.`
  ],
  prompt: ({ authScheme, baseUrl, contract, interfaces }) =>
    `Build typed calls against ${baseUrl} with ${authScheme} auth.\n\nInterfaces: ${
      JSON.stringify(interfaces)
    }\nContract: ${JSON.stringify(contract)}`
})

/** The flow: parse, generate, build calls. */
export const OpenApiContractAgent = Flow.make("examples/OpenApiContractAgent", {
  payload: {
    specPath: Schema.optional(Schema.String),
    specContent: Schema.optional(Schema.String),
    format: Schema.optional(Schema.String),
    filterPaths: Schema.optional(Schema.Array(Schema.String)),
    namingConvention: Schema.optional(Schema.String),
    includeZod: Schema.optional(Schema.Boolean),
    brandedIds: Schema.optional(Schema.Boolean),
    baseUrl: Schema.optional(Schema.String),
    authScheme: Schema.optional(Schema.String)
  },
  success: Output,
  error: AgentAction.AgentFailure,
  body: ({
    authScheme = "bearer",
    baseUrl = "https://api.example.com",
    brandedIds = true,
    filterPaths,
    format = "openapi-3.1",
    includeZod = true,
    namingConvention = "PascalCase",
    specContent,
    specPath
  }) =>
    Node.bindPlanned(ParseContract.call({ specPath, specContent, format, filterPaths }), (contract) =>
      Node.bindPlanned(
        GenerateInterfaces.call({ contract, naming: namingConvention, includeZod, brandedIds }),
        (interfaces) =>
          Node.bindPlanned(
            TypedCallsStep.call({ interfaces, contract, baseUrl, authScheme }),
            (typedCalls) => Node.succeed({ interfaces, typedCalls })
          )
      ))
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(ParseContract.layer, GenerateInterfaces.layer, TypedCallsStep.layer)
