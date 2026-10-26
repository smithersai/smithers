import { digestSync } from "@smthrs/crypto"
import { Redaction } from "@smthrs/journal"

/** Scrub recognized credential forms before clipping, including previously cached summaries. */
export const safeTimelineText = (text: string): string => String(Redaction.redact(text))

/** Full content identity; the model may receive a bounded excerpt of it. */
export const revisionOf = (row: { readonly id: string; readonly role: string; readonly text: string }) => digestSync(JSON.stringify([1, row.id, row.role, row.text]))

/** Old cached state-only summaries cannot replace a concrete subject. */
export const isGenericSummary = (value: string): boolean => /^(?:(?:question|reply|answer|tool|run|todo) (?:sent|completed|done|failed|queued|opened)|working|waiting(?: to send| for reply)?|needs you|not sent|done|completed|failed|queued)[.!]?$/i.test(value.trim())

/** Words an answer's label shows for free; a longer answer is what a model summary is for. */
export const FREE_WORDS = 8

/**
 * Why an answer needs a model summary, or `undefined` when its free label says enough: the rail's label already names
 * the question it answers and its outcome, so a one-line answer of at most {@link FREE_WORDS} words costs nothing.
 */
export const summaryReason = (text: string): "long_answer" | "multiline_answer" | undefined => {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== "")
  if (lines.length > 1) return "multiline_answer"
  return (lines[0] ?? "").trim().split(/\s+/).length > FREE_WORDS ? "long_answer" : undefined
}

/** Characters of the question and the answer the summary model reads: enough to name the subject and the outcome. */
export const QUESTION_EXCERPT = 500
export const ANSWER_EXCERPT = 2000
