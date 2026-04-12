import type { OpenApiSpec, OpenApiToolsOptions } from "../types";
/**
 * Create AI SDK tools from all operations in an OpenAPI spec.
 *
 * @param input - OpenAPI spec as JSON object, file path, URL, or raw text
 * @param options - Configuration for auth, filtering, base URL, etc.
 * @returns Record of operationId → AI SDK tool
 */
export declare function createOpenApiTools(input: string | OpenApiSpec, options?: OpenApiToolsOptions): Promise<Record<string, any>>;
