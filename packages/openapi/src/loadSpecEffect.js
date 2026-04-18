// ---------------------------------------------------------------------------
// loadSpecEffect — Effect-based OpenAPI spec loader
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { parseSpecText } from "./_specHelpers.js";

/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */

/**
 * Load an OpenAPI spec from a JSON/YAML string, URL, file path, or object.
 *
 * @param {string | OpenApiSpec} input
 * @returns {Effect.Effect<OpenApiSpec, unknown>}
 */
export function loadSpecEffect(input) {
    if (typeof input === "object" && input !== null && "openapi" in input) {
        return Effect.succeed(input);
    }
    const str = input;
    // URL
    if (str.startsWith("http://") || str.startsWith("https://")) {
        return Effect.tryPromise({
            try: async () => {
                const res = await fetch(str);
                if (!res.ok) {
                    throw new Error(`Failed to fetch OpenAPI spec: ${res.status} ${res.statusText}`);
                }
                const text = await res.text();
                return parseSpecText(text);
            },
            catch: (cause) => toSmithersError(cause, "openapi fetch spec"),
        });
    }
    // File path or raw JSON/YAML string
    return Effect.try({
        try: () => {
            // Try reading as file first
            try {
                const content = readFileSync(str, "utf8");
                return parseSpecText(content);
            }
            catch {
                // Not a file — try parsing as raw text
                return parseSpecText(str);
            }
        },
        catch: (cause) => toSmithersError(cause, "openapi load spec"),
    });
}
