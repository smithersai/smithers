// File tabs' contract (docs/features/files.md): the one home of the values the tab, the engine worker and the tests
// share. Nothing here imports a library, so every side can.

/** How long `file/open`'s and `file/close`'s steps wait for the tab that asked: a tab that is open answers in milliseconds. */
export const FILES_WITHIN = "5 seconds"

/** The longest file path the flows take. */
export const MAX_PATH_LENGTH = 1_024

/** A file path the flows take: some name that isn't `/`, and no `.` or `..` segment, so it never leaves the revision. */
export const PATH_PATTERN = /^(?=.*[^/])(?!(?:.*\/)?\.\.?(?:\/|$))/

/** A line anchor as `?L=` writes it: one line, `12`, or a range, `10-20`. */
export const LINES_PATTERN = /^[1-9]\d{0,8}(?:-[1-9]\d{0,8})?$/

/**
 * How a step ended: the tab opened the file (`opened`) or closed its tab (`closed`); the tab had no such tab to close
 * (`absent`); the tab that asked shows no repository (`no_repository`); or no tab answered, because the one that asked
 * is gone (`gone`).
 */
export const OUTCOMES = ["opened", "closed", "absent", "no_repository", "gone"] as const

/** One of {@link OUTCOMES}. */
export type Outcome = (typeof OUTCOMES)[number]

/**
 * The `BroadcastChannel` the engine worker asks the tabs of engine `name` on.
 *
 * @throws {never}
 */
export const filesChannel = (name: string): string => `${name}/files`

/**
 * What file tabs record, by name, and the attributes they carry: the step's log line, span and count, in the engine
 * worker. None carries a path, which can carry content. ChatApi's relay keeps exactly what src/telemetry.ts merges from
 * every feature.
 */
export const FILES_TELEMETRY = {
  records: ["files.focus", "smithers_web_file_focus", "files.tab", "smithers_web_file_tabs", "execute_tool file/open", "execute_tool file/close"],
  fields: ["phase", "reason", "op", "door", "outcome", "executionId", "durationMs", "smithers.files.op", "smithers.files.door", "smithers.files.outcome"],
} as const
