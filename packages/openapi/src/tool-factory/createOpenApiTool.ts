import type { OpenApiSpec, OpenApiToolsOptions } from "../types";
/**
 * Create a single AI SDK tool from an OpenAPI spec by operationId.
 *
 * @param input - OpenAPI spec as JSON object, file path, URL, or raw text
 * @param operationId - The operationId of the operation to create a tool for
 * @param options - Configuration for auth, base URL, etc.
 * @returns A single AI SDK tool
 */
export declare function createOpenApiTool(input: string | OpenApiSpec, operationId: string, options?: OpenApiToolsOptions): Promise<any>;
