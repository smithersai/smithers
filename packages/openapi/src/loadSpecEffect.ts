// ---------------------------------------------------------------------------
// loadSpecEffect — Effect-based OpenAPI spec loader
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { fromPromise, fromSync } from "@smithers/runtime/interop";
import type { OpenApiSpec } from "./types";
import { parseSpecText } from "./_specHelpers";

/**
 * Load an OpenAPI spec from a JSON/YAML string, URL, file path, or object.
 */
export function loadSpecEffect(
  input: string | OpenApiSpec,
): Effect.Effect<OpenApiSpec, unknown> {
  if (typeof input === "object" && input !== null && "openapi" in input) {
    return Effect.succeed(input);
  }

  const str = input as string;

  // URL
  if (str.startsWith("http://") || str.startsWith("https://")) {
    return fromPromise("openapi fetch spec", async () => {
      const res = await fetch(str);
      if (!res.ok) {
        throw new Error(`Failed to fetch OpenAPI spec: ${res.status} ${res.statusText}`);
      }
      const text = await res.text();
      return parseSpecText(text);
    });
  }

  // File path or raw JSON/YAML string
  return fromSync("openapi load spec", () => {
    // Try reading as file first
    try {
      const content = readFileSync(str, "utf8");
      return parseSpecText(content);
    } catch {
      // Not a file — try parsing as raw text
      return parseSpecText(str);
    }
  });
}
