import type { OpenApiSpec, OpenApiToolsOptions } from "../types";
/**
 * Synchronous version — only works with specs that are objects or local files.
 */
export declare function createOpenApiToolsSync(input: string | OpenApiSpec, options?: OpenApiToolsOptions): Record<string, any>;
