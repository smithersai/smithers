/**
 * OTLP/JSON sanitization at the final transport boundary.
 * @private
 * @since 1.0.0-rc.17
 */

import { Redaction } from "@smthrs/journal"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const text = (value: string): unknown => {
  // The upstream exporter encodes structured log arguments as JSON strings.
  // Recover their keys before redaction; ordinary text stays ordinary text.
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(Redaction.redact(parsed, { onTooDeep: "name" }))
    }
  } catch { /* Plain text is not JSON. */ }
  return Redaction.redact(value, { onTooDeep: "name" })
}

const sensitiveValue = (key: string, value: unknown): boolean => {
  if (!Redaction.isSensitiveKey(key)) return false
  // Reuse the journal's semantic numeric-token-count exception. Only a
  // scalar AnyValue can be accounting; malformed/mixed encodings fail closed.
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) {
    return true
  }
  const encoded = value as Record<string, unknown>
  const numeric = encoded.intValue ?? encoded.doubleValue
  const scalar = typeof numeric === "string" ? Number(numeric) : numeric
  const redacted = Redaction.redact({ [key]: scalar }) as Record<string, unknown>
  return Object.values(redacted)[0] === Redaction.placeholder
}

const walk = (value: unknown, depth: number): unknown => {
  if (typeof value === "string") return text(value)
  if (value === null || typeof value !== "object") return value
  if (depth >= Redaction.maxDepth) return Redaction.depthMarker
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1))
  const record = value as Record<string, unknown>
  // OTLP KeyValue represents the semantic field name as data, rather than as
  // a JSON member name. Replace the entire AnyValue, including arrays/kvlist.
  const sensitive = typeof record.key === "string" && sensitiveValue(record.key, record.value)
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      sensitive && key === "value"
        ? { stringValue: Redaction.placeholder }
        : walk(item, depth + 1)
    ])
  )
}

/**
 * Redact every signal before size checks, splitting and HTTP execution.
 * @private
 * @since 1.0.0-rc.17
 */
export const redact = (body: Uint8Array): Uint8Array =>
  encoder.encode(JSON.stringify(walk(JSON.parse(decoder.decode(body)), 0)))
