// Credential scrubbing for fleet telemetry (OBS-5), shared by the worker (before a row is stored and again when a
// stored row is read) and the browser (before a row Electric delivered is shown). The journal's redaction rules run
// first: they are the one definition of a Smithers machine token (`smm_`), a scoped token (`smt1.`), a signed or
// access token, a private key block and the provider keys. The pattern below adds the forms fleet reporters send
// that the journal leaves alone, and a machine token a reporter cut short.
import { Redaction } from "@smthrs/journal"
import { TRANSCRIPT_ROLES, type TranscriptEntry, type TranscriptRole } from "./globalContract"

const SECRET_PATTERN =
  /(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|sma_[0-9a-f]{32,}|smm_[A-Za-z0-9_-]{8,}|smt1\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{12,}|(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*\S+)/gi

/** What stands where a credential was. */
export const REDACTED = "[redacted]"

/**
 * `value` with every recognized credential replaced by `[redacted]`. Applying it twice changes nothing more.
 *
 * @throws {never}
 */
export function redactSecrets(value: string): string {
  return String(Redaction.redact(value)).replace(SECRET_PATTERN, REDACTED).replaceAll(Redaction.placeholder, REDACTED)
}

/**
 * Scrubs accidental credential patterns and bounds text length.
 *
 * @throws {never}
 */
export function scrubText(value: string | null | undefined, maxLen: number): string | null {
  if (value === undefined || value === null) return null
  const cleaned = redactSecrets(value).replace(/[\r\n\t]+/g, " ").trim()
  return cleaned.length === 0 ? null : cleaned.slice(0, maxLen)
}

/** The most transcript entries stored per observed session. */
export const MAX_TRANSCRIPT_ENTRIES = 24
export const MAX_TRANSCRIPT_TEXT_LENGTH = 360
export const MAX_TRANSCRIPT_LABEL_LENGTH = 80

/**
 * Scrubs and bounds a session's transcript entries (OBS-5): keeps at most the last 24 entries,
 * validates the role allowlist, scrubs `text` (max 360 chars) and `label` (max 80 chars) through
 * `scrubText`, and normalizes timestamps so credentials or raw dumps never enter Postgres or Electric.
 * A stored transcript is read through it too, so a row written before a rule existed is scrubbed by that rule.
 *
 * @throws {never}
 */
export function scrubTranscript(raw: unknown): ReadonlyArray<TranscriptEntry> | null {
  let list: unknown = raw
  if (typeof list === "string") {
    try {
      list = JSON.parse(list)
    } catch {
      // expected: a stored or reported transcript that is not JSON is no transcript
      return null
    }
  }
  if (!Array.isArray(list)) return null
  const kept: Array<TranscriptEntry> = []
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue
    const obj = item as Record<string, unknown>
    const rawRole = obj["role"]
    if (typeof rawRole !== "string" || !(TRANSCRIPT_ROLES as ReadonlyArray<string>).includes(rawRole)) continue
    const rawText = obj["text"]
    if (typeof rawText !== "string") continue
    const text = scrubText(rawText, MAX_TRANSCRIPT_TEXT_LENGTH)
    if (text === null) continue
    const rawLabel = obj["label"]
    const label = typeof rawLabel === "string" ? scrubText(rawLabel, MAX_TRANSCRIPT_LABEL_LENGTH) : null
    const rawTs = obj["ts"]
    const ts = typeof rawTs === "string" && rawTs.length <= 64 && !Number.isNaN(Date.parse(rawTs))
      ? new Date(Date.parse(rawTs)).toISOString()
      : null
    kept.push({
      ts,
      role: rawRole as TranscriptRole,
      label,
      text,
    })
  }
  if (kept.length === 0) return null
  return kept.slice(-MAX_TRANSCRIPT_ENTRIES)
}
