import { Effect } from "effect";
import type { OpenApiSpec } from "./types";
/**
 * Load an OpenAPI spec from a JSON/YAML string, URL, file path, or object.
 */
export declare function loadSpecEffect(input: string | OpenApiSpec): Effect.Effect<OpenApiSpec, unknown>;
