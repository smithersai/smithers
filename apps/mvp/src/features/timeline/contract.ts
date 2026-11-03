// The timeline's records (docs/features/timeline.md): what ChatApi's relay keeps of them (src/telemetry.ts). A summary
// that runs, fails or finds no model says so; its text never does.
export const TIMELINE_TELEMETRY = {
  records: [
    "timeline.summary",
    "timeline.summary.unconfigured",
    "timeline.summary.stopped",
    "timeline.summary.unavailable",
    "timeline.summary.defect",
    "timeline.summary.notice",
    "timeline.phases",
    "smithers_timeline_summary_calls",
    "smithers_timeline_summary_stops",
    "smithers_timeline_phase_calls",
  ],
  fields: ["outcome", "replayed", "role", "code", "errorCode", "reason", "level", "items", "phases"],
} as const

/**
 * `POST /api/timeline/summaries` (worker/TimelineSummaries.ts): `claim` takes the one model call a message's revision
 * may cost, for every tab, device and person; `record` writes its summary onto the message, which syncs to them all.
 */
export const TIMELINE_SUMMARIES_ROUTE = "/api/timeline/summaries"

/** The flow that claims and records summaries: the only run that may call the route for a person. */
export const SUMMARIZE_FLOW = "timeline/summarize"

/** The flow that segments a conversation into phases and arcs: the only other run that may call the route for a person. */
export const PHASES_FLOW = "timeline/phases"

/**
 * What a claim is for, recorded with it (never content): a `question` or `answer`, each of which gets a summary (FE-19).
 * `long_answer` and `multiline_answer` are claims from before the ruling, kept so journaled runs replay.
 */
export const SUMMARY_REASONS = ["question", "answer", "long_answer", "multiline_answer"] as const
export type SummaryReason = typeof SUMMARY_REASONS[number]

/** Model summaries a person's claims may start in any 24 hours, unless `TIMELINE_SUMMARY_DAILY_CAP` says otherwise. */
export const SUMMARY_DAILY_CAP = 200

/** A phase or an arc, stored as JSON on the message it starts at (`messages.phase`, `messages.arc`). */
export const TITLE_WORDS = 6
export const TITLE_LENGTH = 48
export const MARK_SUMMARY_LENGTH = 180
/** The most a stored mark can take: its title, summary and bookkeeping, with escapes. */
export const MARK_LENGTH = 512
/** New items, since the open span was last written, that make it worth another call. */
export const SEGMENT_EVERY = { 1: 4, 2: 6 } as const
/** The most items one call reads, including persisted rolling summaries of open spans. */
export const SEGMENT_WINDOW = { 1: 24, 2: 16 } as const
/** Closed phases before the first arcs are worth making: below a column's capacity, so level 2 has them when it appears. */
export const ARCS_FROM = 12
/** The most items a span can claim: a stored mark past this is damage, whatever a conversation grows to. */
export const MOST_COVERED = 100_000
/** Spans one record may write. */
export const SEGMENT_SPANS = 12

/** Maximum raw JSON request bytes, shared by dispatch and the handler. */
export const MAX_SUMMARY_BODY_BYTES = 16_384
