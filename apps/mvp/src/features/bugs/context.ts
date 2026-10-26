import type { ErrorRecord } from "../../flows/errors"
import type { Ran } from "../../flows/history"
import { BUG_INBOX_PATH, MAX_ERRORS, MAX_RECENT } from "./contract"
import type { ErrorEntry, Failure, ReportContext } from "./schema"

// What a report says the tab showed (docs/features/bugs.md#what-a-report-carries), as a pure function of what
// the tab recorded: the page the person was on before the form, the repository on it, the build, the latest trace
// ids, run ids and failure codes of this tab's runs, its latest error records (src/flows/errors.ts), and the browser
// and window. Ids, names and codes only: nothing here reads a message, an answer, a payload or a page's text.

/** The pages a report never names as where the bug was: the bug inbox and its form. */
export const isBugPage = (path: string): boolean => path === BUG_INBOX_PATH || path.startsWith(`${BUG_INBOX_PATH}/`)

/** The first segments of the app's own pages, which name no repository. */
const APP_SEGMENTS: ReadonlySet<string> = new Set(["app", "api", "docs", "auth"])

const NAME = /^[\w.-]{1,100}$/

/** The repository a page shows, `owner/name`, when its path is a repository's (`/<owner>/<name>/…`). */
export const repoOf = (route: string | null): string | null => {
  if (route === null) return null
  const [owner, name] = route.split(/[?#]/, 1)[0]!.split("/").filter(Boolean)
  if (owner === undefined || name === undefined || APP_SEGMENTS.has(owner)) return null
  return NAME.test(owner) && NAME.test(name) && owner !== "." && owner !== ".." && name !== "." && name !== ".."
    ? `${owner}/${name}`
    : null
}

/** The page a report names: the one shown now unless it is the bug form, else the latest page before it. */
export const routeOf = (current: string | undefined, pages: ReadonlyArray<string>): string | null => {
  const candidates = current === undefined ? pages : [current, ...pages]
  const page = candidates.find((path) => !isBugPage(path))
  return page === undefined ? null : page.slice(0, 2_048)
}

const TRACE = /^[0-9a-f]{32}$/
const RUN = /^[\w.:@/+-]{1,200}$/
const FLOW = /^[\w./-]{1,128}$/
const CODE = /^[\w./:-]{1,64}$/

const ERROR_NAME = /^[\w ./:@+%~!$&'()*,;=-]{1,200}$/

/** Whether an error record fits a report's shape (`ErrorEntry`): one that doesn't is left out, never cut. */
const fits = (record: ErrorRecord): record is ErrorEntry =>
  record.at.length <= 40 && ERROR_NAME.test(record.name) && (record.code === null || CODE.test(record.code)) &&
  (record.traceId === null || TRACE.test(record.traceId))

/** The first `MAX_RECENT` distinct values, in order. */
const latest = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)].slice(0, MAX_RECENT)

/** What the tab recorded, which the report reads. */
export interface Recorded {
  /** The page shown now, if the host can say. */
  readonly current: string | undefined
  /** The pages shown before it, newest first. */
  readonly pages: ReadonlyArray<string>
  /** This tab's latest dispatches, newest first. */
  readonly ran: ReadonlyArray<Ran>
  /** This tab's latest error records, newest first. */
  readonly errors: ReadonlyArray<ErrorRecord>
  readonly build: string
  readonly browser: string
  readonly viewport: string
}

/** The report's context from what the tab recorded: an id or code that doesn't fit its shape is left out; text is cut. */
export const contextOf = (recorded: Recorded): ReportContext => {
  const route = routeOf(recorded.current, recorded.pages)
  const failures: Array<Failure> = []
  const seen = new Set<string>()
  for (const { flow, code, outcome } of recorded.ran) {
    if (outcome === "done" || code === undefined || !FLOW.test(flow) || !CODE.test(code)) continue
    const key = `${flow} ${code}`
    if (seen.has(key) || failures.length === MAX_RECENT) continue
    seen.add(key)
    failures.push({ flow, code })
  }
  return {
    route,
    repo: repoOf(route),
    build: recorded.build.slice(0, 64),
    traces: latest(recorded.ran.flatMap(({ traceId }) => (traceId !== undefined && TRACE.test(traceId) ? [traceId] : []))),
    runs: latest(recorded.ran.flatMap(({ executionId }) => (RUN.test(executionId) ? [executionId] : []))),
    failures,
    errors: recorded.errors.filter(fits).slice(0, MAX_ERRORS),
    browser: recorded.browser.slice(0, 512),
    viewport: recorded.viewport.slice(0, 32),
  }
}

/** The context of a report whose tab didn't answer: it is still filed, with what only the step knows. */
export const UNANSWERED: ReportContext = {
  route: null,
  repo: null,
  build: "unknown",
  traces: [],
  runs: [],
  failures: [],
  errors: [],
  browser: "unknown",
  viewport: "unknown",
}
