import type { JsonValueData } from "@smthrs/ui"

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {}

/** A CI action carries prior outcomes too; only its own final command owns these records. */
export const outputLogs = (value: JsonValueData | null): ReadonlyArray<JsonValueData> => {
  if (value === null || value.clipped) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value.text)
    // expected: historical non-JSON results contain no command records
  } catch { return [] }
  const sealed = record(parsed)
  const result = record(sealed._tag === "Success" ? sealed.value : parsed)
  if (!Array.isArray(result.steps)) return []
  const output = record(record(result.steps.at(-1)).output)
  return [output.stdout, output.stderr].flatMap((text) => typeof text === "string" && text.length > 0
    ? [{ text, bytes: new TextEncoder().encode(text).length, clipped: output.truncated === true }]
    : [])
}
