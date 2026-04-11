// ---------------------------------------------------------------------------
// OpenAPI tool factory — public API
// ---------------------------------------------------------------------------

export {
  createOpenApiTools,
  createOpenApiToolsSync,
  createOpenApiTool,
  createOpenApiToolSync,
  listOperations,
} from "./tool-factory/index";

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

export { extractOperations } from "./extractOperations";
export { loadSpecEffect } from "./loadSpecEffect";
export { loadSpecSync } from "./loadSpecSync";
export { jsonSchemaToZod } from "./jsonSchemaToZod";
export { buildOperationSchema } from "./buildOperationSchema";
