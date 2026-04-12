import { type OpenApiSpec, type ParsedOperation } from "./types";
/**
 * Extract all operations from an OpenAPI spec.
 */
export declare function extractOperations(spec: OpenApiSpec): ParsedOperation[];
