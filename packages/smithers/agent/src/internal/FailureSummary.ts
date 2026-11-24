/**
 * Bounded diagnostic headlines for durable agent failure records.
 * @since 1.0.0
 */

import { truncated } from "./Truncate.ts"

/**
 * The innermost typed sentence from the engine's JSON-safe failure value.
 * @category getters
 * @since 1.0.0
 */
export const failureSummary = (failure: unknown): string | undefined => {
  let current = failure
  let summary: string | undefined
  for (let depth = 0; depth < 16 && typeof current === "object" && current !== null; depth++) {
    const row = current as Record<string, unknown>
    if (typeof row["message"] === "string" && row["message"].trim() !== "") {
      const code = typeof row["code"] === "string" && row["code"] !== "" ? `${truncated(row["code"], 128)}: ` : ""
      summary = `${code}${truncated(row["message"].replace(/\s+/g, " ").trim(), 1024)}`
    }
    current = row["cause"]
  }
  return summary
}
