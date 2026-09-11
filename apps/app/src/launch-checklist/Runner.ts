/*
 * Launch checklist (U7) — the runner.
 *
 * Pure with respect to the outside world: it takes a row catalog and a probe
 * context and returns results plus a report. Launching a browser, reading the
 * clock, writing files, and exiting the process all belong to the CLI
 * (scripts/launch-checklist.ts), which is why this module is unit-testable
 * with fake pages and a fake fetch.
 */
import {
  BrowserUnavailableError,
  type ChecklistReport,
  type ChecklistRow,
  type ProbeContext,
  type RowResult,
  type Status,
  type Totals
} from "./Types.ts"

export interface RunOptions {
  readonly rows: ReadonlyArray<ChecklistRow>
  readonly mode: "dry-run" | "run"
  readonly context: ProbeContext
  /** Bounds the probe, including streamed response bodies. */
  readonly rowTimeoutMs?: number
  /** Called after every completed row so reports survive later failures. */
  readonly onProgress?: (results: ReadonlyArray<RowResult>) => void
}

const missingEnvFor = (row: ChecklistRow, env: Readonly<Record<string, string | undefined>>): ReadonlyArray<string> =>
  (row.requiredEnv ?? []).filter((name) => {
    const value = env[name]
    return value === undefined || value === ""
  })

const result = (
  row: ChecklistRow,
  status: Status,
  reasons: ReadonlyArray<string>,
  evidence: ReadonlyArray<string>,
  durationMs: number,
  undecidedInProbe = false
): RowResult => ({
  id: row.id,
  section: row.section,
  title: row.title,
  status,
  reasons,
  evidence,
  durationMs,
  tests: [`[${row.id}] ${row.title} [${status === "pass" ? "passed" : status === "fail" ? "failed" : status}]`],
  ...(undecidedInProbe ? { undecidedInProbe: true } : {})
})

export const runChecklist = async ({ rows, mode, context, rowTimeoutMs = 120_000, onProgress }: RunOptions): Promise<ReadonlyArray<RowResult>> => {
  if (!Number.isFinite(rowTimeoutMs) || rowTimeoutMs <= 0) throw new Error("rowTimeoutMs must be positive and finite")
  const results: Array<RowResult> = []
  const record = (row: RowResult): void => {
    results.push(row)
    onProgress?.([...results])
  }
  for (const row of rows) {
    const start = context.now()
    if (mode === "dry-run") {
      record(
        result(
          row,
          "skipped-dry-run",
          ["dry run: no network calls were made and no browser was launched"],
          [
            ...(row.requiredEnv !== undefined ? [`requires env: ${row.requiredEnv.join(", ")}`] : []),
            ...(row.browser === true ? ["drives a headless page on the target"] : ["HTTP-only probe"])
          ],
          context.now() - start
        )
      )
      continue
    }

    const missing = missingEnvFor(row, context.env)
    if (missing.length > 0) {
      record(result(row, "not-testable-yet", [`missing env: ${missing.join(", ")}`], [], context.now() - start))
      continue
    }

    const controller = new AbortController()
    const signal = controller.signal
    const combine = (other?: AbortSignal | null): AbortSignal =>
      other == null ? signal : AbortSignal.any([signal, other])
    const rowContext: ProbeContext = {
      ...context,
      signal,
      fetch: (url, init) => {
        signal.throwIfAborted()
        return context.fetch(url, { ...init, signal: combine(init?.signal) })
      },
      sleep: (ms, other) => {
        signal.throwIfAborted()
        return context.sleep(ms, combine(other))
      },
      page: async (cookie, other) => {
        signal.throwIfAborted()
        const page = await context.page(cookie, combine(other))
        signal.throwIfAborted()
        return {
          text: (other) => page.text(combine(other)),
          evaluate: (expression, other) => page.evaluate(expression, combine(other)),
          type: (text, other) => page.type(text, combine(other)),
          press: (key, other) => page.press(key, combine(other)),
          reload: (other) => page.reload(combine(other))
        }
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`row ${row.id} timed out after ${rowTimeoutMs}ms`)
        reject(error)
        controller.abort(error)
      }, rowTimeoutMs)
    })
    let completed: RowResult
    try {
      const probeResult = await Promise.race([deadline, row.probe(rowContext)])
      completed = result(
        row,
        probeResult.status,
        probeResult.status === "pass" ? [] : [probeResult.detail],
        [probeResult.detail],
        context.now() - start,
        probeResult.status === "not-testable-yet"
      )
    } catch (error) {
      const status: Status = error instanceof BrowserUnavailableError ? "not-testable-yet" : "fail"
      completed = result(row, status, [String(error instanceof Error ? error.message : error)], [], context.now() - start)
    } finally {
      clearTimeout(timer)
      controller.abort(new Error(`row ${row.id} finished`))
    }
    record(completed)
  }
  return results
}

export const totalsOf = (rows: ReadonlyArray<RowResult>): Totals => ({
  pass: rows.filter((row) => row.status === "pass").length,
  fail: rows.filter((row) => row.status === "fail").length,
  notTestableYet: rows.filter((row) => row.status === "not-testable-yet").length,
  probeUndecided: rows.filter((row) => row.undecidedInProbe === true).length,
  skippedDryRun: rows.filter((row) => row.status === "skipped-dry-run").length
})

export const buildReport = (
  mode: "dry-run" | "run",
  target: string | undefined,
  generatedAt: string,
  rows: ReadonlyArray<RowResult>
): ChecklistReport => ({
  generatedAt,
  mode,
  target: target ?? null,
  totals: totalsOf(rows),
  rows
})

/**
 * A real `fail` fails the command. In a run (not a dry run), a row whose probe
 * ran and STILL decided nothing exits 2: the checklist claimed a check it did
 * not perform, and a green report would launder the gap. Missing env and a
 * missing browser stay green — those are capability gaps, not punt answers.
 */
export const exitCodeFor = (totals: Totals, mode: "dry-run" | "run" = "run"): number => {
  if (totals.fail > 0) return 1
  if (mode === "run" && totals.probeUndecided > 0) return 2
  return 0
}

export const renderMarkdown = (report: ChecklistReport): string =>
  [
    "# Launch checklist report",
    "",
    `- Mode: ${report.mode}`,
    `- Target: ${report.target ?? "(none — dry run)"}`,
    `- Generated: ${report.generatedAt}`,
    `- Totals: **${report.totals.fail} fail** · ${report.totals.pass} pass · ${report.totals.notTestableYet} not-testable-yet (${report.totals.probeUndecided} probe-undecided) · ${report.totals.skippedDryRun} skipped-dry-run`,
    "",
    "## Rows",
    "",
    "| ID | Section | Status | Title |",
    "| --- | --- | --- | --- |",
    ...report.rows.map((row) => `| ${row.id} | ${row.section} | ${row.status} | ${row.title} |`),
    "",
    "## Detail",
    "",
    ...report.rows.flatMap((row) => [
      `### ${row.id} — ${row.title}`,
      "",
      `Status: ${row.status}`,
      ...(row.reasons.length > 0 ? ["", "Reasons:", ...row.reasons.map((reason) => `- ${reason}`)] : []),
      ...(row.evidence.length > 0 ? ["", "Evidence:", ...row.evidence.map((line) => `- ${line}`)] : []),
      ""
    ])
  ].join("\n")
