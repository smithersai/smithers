import type { OpenApiSpec } from "./types";
/**
 * Synchronous version for simpler call sites.
 */
export declare function loadSpecSync(input: string | OpenApiSpec): OpenApiSpec;
