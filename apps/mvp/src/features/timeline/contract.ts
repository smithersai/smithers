// The timeline's records (docs/features/timeline.md): what ChatApi's relay keeps of them (src/telemetry.ts). A summary
// that runs, fails or finds no model says so; its text never does.
export const TIMELINE_TELEMETRY = {
  records: [
    "timeline.summary",
    "timeline.summary.unconfigured",
    "timeline.summary.stopped",
    "timeline.summary.unavailable",
    "timeline.summary.defect",
    "timeline.summary.deleted",
    "timeline.summary.delete",
    "smithers_timeline_summary_calls",
    "smithers_timeline_summary_removals",
    "smithers_timeline_summary_stops",
  ],
  fields: ["outcome", "replayed", "role", "code"],
} as const
