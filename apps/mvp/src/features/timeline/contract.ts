// The timeline's records (docs/features/timeline.md): what ChatApi's relay keeps of them (src/telemetry.ts). A summary
// that runs, fails or finds no model says so; its text never does.
export const TIMELINE_TELEMETRY = {
  records: [
    "timeline.summary",
    "timeline.summary.unconfigured",
    "timeline.summary.stopped",
    "timeline.summary.unavailable",
    "timeline.summary.defect",
    "smithers_timeline_summary_calls",
    "smithers_timeline_summary_stops",
  ],
  fields: ["outcome", "replayed", "role", "code", "errorCode", "reason"],
} as const

/**
 * `POST /api/timeline/summaries` (worker/TimelineSummaries.ts): `claim` takes the one model call a message's revision
 * may cost, for every tab, device and person; `record` writes its summary onto the message, which syncs to them all.
 */
export const TIMELINE_SUMMARIES_ROUTE = "/api/timeline/summaries"

/** The flow that claims and records summaries: the only run that may call the route for a person. */
export const SUMMARIZE_FLOW = "timeline/summarize"

/**
 * Why an answer needed the model, recorded with each claim (never content): more words than a label shows, or more
 * than one line. Anything shorter keeps its free label and costs nothing.
 */
export const SUMMARY_REASONS = ["long_answer", "multiline_answer"] as const
export type SummaryReason = typeof SUMMARY_REASONS[number]

/** Model summaries a person's claims may start in any 24 hours, unless `TIMELINE_SUMMARY_DAILY_CAP` says otherwise. */
export const SUMMARY_DAILY_CAP = 200
