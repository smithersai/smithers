/**
 * <OpenAPIContractAgent> — Convert JSON Schema / OpenAPI structures into typed
 * interfaces for extraction or tool interaction.
 *
 * Shape: contract source → interface generation → typed runtime calls.
 * Use cases: API client generation, structured extraction from specs,
 * contract-first tool scaffolding, schema-to-zod conversion.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ParseContractPrompt from "./prompts/openapi-contract-agent/parse-contract.mdx";
import GenerateInterfacesPrompt from "./prompts/openapi-contract-agent/generate-interfaces.mdx";
import TypedCallsPrompt from "./prompts/openapi-contract-agent/typed-calls.mdx";

const contractSourceSchema = z.object({
  specFormat: z.enum(["openapi-3.0", "openapi-3.1", "json-schema-draft-07", "json-schema-draft-2020"]),
  endpoints: z.array(z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().describe("API path, e.g. /users/{id}"),
    operationId: z.string(),
    summary: z.string(),
    requestBodySchema: z.record(z.string(), z.unknown()).optional(),
    responseSchema: z.record(z.string(), z.unknown()).optional(),
    parameters: z.array(z.object({
      name: z.string(),
      in: z.enum(["path", "query", "header"]),
      required: z.boolean(),
      schemaType: z.string(),
    })).optional(),
  })),
  sharedModels: z.array(z.object({
    name: z.string().describe("Model/component name, e.g. User"),
    properties: z.record(z.string(), z.object({
      type: z.string(),
      description: z.string().optional(),
      required: z.boolean().optional(),
    })),
  })),
});

const interfaceSchema = z.object({
  interfaces: z.array(z.object({
    name: z.string().describe("TypeScript interface name"),
    source: z.string().describe("Originating schema component or endpoint"),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string().describe("TypeScript type expression"),
      optional: z.boolean(),
      description: z.string().optional(),
    })),
    zodSchema: z.string().describe("Equivalent zod schema as a code string"),
  })),
  operationSignatures: z.array(z.object({
    operationId: z.string(),
    method: z.string(),
    path: z.string(),
    inputType: z.string().describe("Name of the request interface"),
    outputType: z.string().describe("Name of the response interface"),
  })),
  summary: z.string(),
});

const typedCallSchema = z.object({
  calls: z.array(z.object({
    operationId: z.string(),
    endpoint: z.string().describe("Full method + path"),
    inputInterface: z.string(),
    outputInterface: z.string(),
    samplePayload: z.record(z.string(), z.unknown()).describe("Example typed request body"),
    expectedShape: z.record(z.string(), z.unknown()).describe("Example typed response shape"),
    validationNotes: z.array(z.string()).describe("Any type mismatches or warnings"),
  })),
  coverage: z.object({
    totalEndpoints: z.number(),
    typedEndpoints: z.number(),
    warnings: z.array(z.string()),
  }),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  contractSource: contractSourceSchema,
  interfaces: interfaceSchema,
  typedCalls: typedCallSchema,
});

const contractParser = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are an OpenAPI and JSON Schema specialist. Parse raw API specifications
into a normalized contract source representation. Identify all endpoints, HTTP methods,
operation IDs, request/response schemas, parameters, and shared model definitions.
Handle both OpenAPI 3.x and JSON Schema drafts. Resolve $ref pointers and inline definitions.`,
});

const interfaceGenerator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a TypeScript interface generator. Given a parsed contract source,
produce strongly-typed TypeScript interfaces and equivalent zod schemas for every model
and every request/response pair. Generate operation signatures mapping each endpoint to
its input and output types. Prefer precise types over 'any'. Use branded types where IDs
or dates appear. Ensure naming consistency across interfaces.`,
});

const typedCallBuilder = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a typed API call builder. Given generated interfaces and operation
signatures, produce sample typed calls for every endpoint. Validate that request payloads
conform to input interfaces and response shapes match output interfaces. Flag any type
mismatches, missing required fields, or schema drift. Report coverage statistics.`,
});

export default smithers((ctx) => {
  const contract = ctx.outputMaybe("contractSource", { nodeId: "parse-contract" });
  const interfaces = ctx.outputMaybe("interfaces", { nodeId: "generate-interfaces" });

  return (
    <Workflow name="openapi-contract-agent">
      <Sequence>
        {/* Phase 1: Parse the raw spec into a normalized contract source */}
        <Task id="parse-contract" output={outputs.contractSource} agent={contractParser}>
          <ParseContractPrompt
            specPath={ctx.input.specPath}
            specContent={ctx.input.specContent}
            format={ctx.input.format ?? "openapi-3.1"}
            filterPaths={ctx.input.filterPaths}
          />
        </Task>

        {/* Phase 2: Generate typed interfaces and zod schemas from the contract */}
        <Task id="generate-interfaces" output={outputs.interfaces} agent={interfaceGenerator}>
          <GenerateInterfacesPrompt
            contract={contract}
            naming={ctx.input.namingConvention ?? "PascalCase"}
            includeZod={ctx.input.includeZod ?? true}
            brandedIds={ctx.input.brandedIds ?? true}
          />
        </Task>

        {/* Phase 3: Produce typed runtime calls with validation */}
        <Task id="typed-calls" output={outputs.typedCalls} agent={typedCallBuilder}>
          <TypedCallsPrompt
            interfaces={interfaces}
            contract={contract}
            baseUrl={ctx.input.baseUrl ?? "https://api.example.com"}
            authScheme={ctx.input.authScheme ?? "bearer"}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
