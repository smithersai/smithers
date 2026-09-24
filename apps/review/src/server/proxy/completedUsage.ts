import { parseUsageFromJson } from "./parseUsageFromJson.ts";
import type { UsageSummary } from "./parseUsage.ts";

/** Only release a JSON-response reservation when the provider supplied final usage. */
export function completedUsage(body: string): UsageSummary | null {
  try {
    const payload = JSON.parse(body);
    if (typeof payload?.usage?.input_tokens !== "number" || typeof payload?.usage?.output_tokens !== "number") return null;
    return parseUsageFromJson(body);
  } catch {
    return null;
  }
}
