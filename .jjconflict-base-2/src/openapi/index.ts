// ---------------------------------------------------------------------------
// OpenAPI tool factory — public API
// ---------------------------------------------------------------------------

export {
  createOpenApiTools,
  createOpenApiToolsSync,
  createOpenApiTool,
  createOpenApiToolSync,
  listOperations,
} from "./tool-factory";

export type {
  OpenApiSpec,
  OpenApiAuth,
  OpenApiToolsOptions,
  ParsedOperation,
} from "./types";

export {
  openApiToolCallsTotal,
  openApiToolCallErrorsTotal,
  openApiToolDuration,
} from "./metrics";

export { extractOperations, loadSpecEffect, loadSpecSync } from "./spec-parser";
export { jsonSchemaToZod, buildOperationSchema } from "./schema-converter";
