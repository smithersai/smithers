// ---------------------------------------------------------------------------
// loadSpecSync — synchronous OpenAPI spec loader
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import type { OpenApiSpec } from "./types";
import { parseSpecText } from "./_specHelpers";

/**
 * Synchronous version for simpler call sites.
 */
export function loadSpecSync(input: string | OpenApiSpec): OpenApiSpec {
  if (typeof input === "object" && input !== null && "openapi" in input) {
    return input;
  }
  const str = input as string;
  try {
    const content = readFileSync(str, "utf8");
    return parseSpecText(content);
  } catch {
    return parseSpecText(str);
  }
}
