import type { OpenApiSpec } from "../types";
/**
 * List all operations from a spec (for CLI preview).
 */
export declare function listOperations(input: string | OpenApiSpec): Array<{
    operationId: string;
    method: string;
    path: string;
    summary: string;
}>;
