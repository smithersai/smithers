import type { OpenApiSpec, OpenApiToolsOptions } from "../types";
/**
 * Synchronous version — only works with specs that are objects or local files.
 */
export declare function createOpenApiToolSync(input: string | OpenApiSpec, operationId: string, options?: OpenApiToolsOptions): any;
