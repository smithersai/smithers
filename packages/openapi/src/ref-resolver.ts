import type { OpenApiSpec, RefObject } from "./types";
export declare function isRef(obj: unknown): obj is RefObject;
/**
 * Resolve a local JSON pointer ($ref) anywhere within the OpenAPI spec.
 */
export declare function resolveRef<T = unknown>(spec: OpenApiSpec, ref: string): T;
/**
 * If the value is a $ref, resolve it. Otherwise return as-is.
 * Handles one level of indirection (resolved value is not recursively resolved).
 */
export declare function deref<T = unknown>(spec: OpenApiSpec, value: T | RefObject): T;
