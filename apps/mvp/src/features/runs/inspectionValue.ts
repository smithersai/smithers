/** Inspection values are bounded JSON; only complete, disclosed values can provide domain outcomes. */
export const inspectionValue = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || !("text" in value) ||
    typeof value.text !== "string" || !("clipped" in value) || value.clipped !== false) return undefined
  // expected: a value that isn't JSON contains no domain evidence
  try { return JSON.parse(value.text) } catch { return undefined }
}
