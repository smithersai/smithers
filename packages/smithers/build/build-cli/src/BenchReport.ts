/**
 * Parses benchmark output from `VitestBench` and `NodeBench` targets and
 * renders a compact summary table across all settled benchmark targets.
 *
 * @since 1.0.0
 */

import * as Ansi from "./Ansi.ts"

/**
 * One measured benchmark row extracted from a target's output.
 *
 * @category models
 * @since 1.0.0
 */
export interface BenchmarkRow {
  readonly suite?: string | undefined
  readonly name: string
  readonly hz?: number | undefined
  readonly minMs?: number | undefined
  readonly maxMs?: number | undefined
  readonly meanMs?: number | undefined
  readonly p75Ms?: number | undefined
  readonly p99Ms?: number | undefined
  readonly rme?: string | undefined
  readonly samples?: number | undefined
  readonly note?: string | undefined
}

/**
 * One target's benchmark outcome for rendering.
 *
 * @category models
 * @since 1.0.0
 */
export interface TargetBenchmarks {
  readonly label: string
  readonly status: "hit" | "ran" | "failed" | "skipped" | "cancelled"
  readonly benchmarks?: ReadonlyArray<BenchmarkRow> | undefined
}

const ansiPattern = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** Removes ANSI SGR/CSI control sequences from captured tool output. */
const stripAnsi = (text: string): string => text.replace(ansiPattern, "")

const parseNumeric = (raw: string): number | undefined => {
  const cleaned = raw.replaceAll(",", "")
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : undefined
}

const vitestSuiteHeader = /^\s*[✓✔×❯]\s+(?:\|bench\|\s+)?(.+?)(?:\s+\d+(?:\.\d+)?(?:ms|s))?\s*$/

const vitestTableHeader = /^\s*name\s+hz\s+min\s+max\s+mean\s+p75\s+p99(?:\s+p995)?(?:\s+p999)?\s+rme\s+samples\s*$/

const vitestTableRow =
  /^\s*(?:[·•-]\s+)?(.+?)\s{2,}([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)(?:\s+[\d,.]+)?(?:\s+[\d,.]+)?\s+(±[\d.]+%)\s+([\d,]+)(?:\s+(.+))?\s*$/

const metricPrefix = "BENCH_METRIC "

/**
 * Extracts structured benchmark rows from a target's standard output.
 *
 * Recognizes Vitest 5 verbose benchmark tables and standalone `BENCH_METRIC`
 * JSON lines emitted by custom `NodeBench` scripts.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parse = (stdout: string): ReadonlyArray<BenchmarkRow> => {
  const rows: Array<BenchmarkRow> = []
  let currentSuite: string | undefined
  let inTable = false

  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (trimmed === "") {
      inTable = false
      continue
    }
    if (trimmed.startsWith(metricPrefix)) {
      try {
        const parsed = JSON.parse(trimmed.slice(metricPrefix.length)) as Record<string, unknown>
        if (typeof parsed["name"] === "string" && parsed["name"].length > 0) {
          rows.push({
            ...(typeof parsed["suite"] === "string" && parsed["suite"].length > 0 ? { suite: parsed["suite"] } : {}),
            name: parsed["name"],
            ...(typeof parsed["hz"] === "number" && Number.isFinite(parsed["hz"]) ? { hz: parsed["hz"] } : {}),
            ...(typeof parsed["minMs"] === "number" && Number.isFinite(parsed["minMs"])
              ? { minMs: parsed["minMs"] }
              : {}),
            ...(typeof parsed["maxMs"] === "number" && Number.isFinite(parsed["maxMs"])
              ? { maxMs: parsed["maxMs"] }
              : {}),
            ...(typeof parsed["meanMs"] === "number" && Number.isFinite(parsed["meanMs"])
              ? { meanMs: parsed["meanMs"] }
              : {}),
            ...(typeof parsed["p75Ms"] === "number" && Number.isFinite(parsed["p75Ms"])
              ? { p75Ms: parsed["p75Ms"] }
              : {}),
            ...(typeof parsed["p99Ms"] === "number" && Number.isFinite(parsed["p99Ms"])
              ? { p99Ms: parsed["p99Ms"] }
              : {}),
            ...(typeof parsed["rme"] === "string" && parsed["rme"].length > 0 ? { rme: parsed["rme"] } : {}),
            ...(typeof parsed["samples"] === "number" && Number.isFinite(parsed["samples"])
              ? { samples: parsed["samples"] }
              : {}),
            ...(typeof parsed["note"] === "string" && parsed["note"].length > 0 ? { note: parsed["note"] } : {})
          })
        }
      } catch {
        // Ignore malformed custom lines so unrelated output never breaks parsing.
      }
      continue
    }
    if (vitestTableHeader.test(rawLine)) {
      inTable = true
      continue
    }
    if (inTable) {
      const match = vitestTableRow.exec(rawLine)
      if (match !== null) {
        const name = match[1]!.trim()
        const hz = parseNumeric(match[2]!)
        const minMs = parseNumeric(match[3]!)
        const maxMs = parseNumeric(match[4]!)
        const meanMs = parseNumeric(match[5]!)
        const p75Ms = parseNumeric(match[6]!)
        const p99Ms = parseNumeric(match[7]!)
        const rme = match[8]!
        const samples = parseNumeric(match[9]!)
        const note = match[10]?.trim()
        rows.push({
          ...(currentSuite === undefined ? {} : { suite: currentSuite }),
          name,
          ...(hz === undefined ? {} : { hz }),
          ...(minMs === undefined ? {} : { minMs }),
          ...(maxMs === undefined ? {} : { maxMs }),
          ...(meanMs === undefined ? {} : { meanMs }),
          ...(p75Ms === undefined ? {} : { p75Ms }),
          ...(p99Ms === undefined ? {} : { p99Ms }),
          rme,
          ...(samples === undefined ? {} : { samples }),
          ...(note === undefined || note === "" ? {} : { note })
        })
        continue
      }
      inTable = false
    }
    const suiteMatch = vitestSuiteHeader.exec(rawLine)
    if (suiteMatch !== null) {
      const heading = suiteMatch[1]!.trim()
      const parts = heading.split(" > ").map((part) => part.trim()).filter(Boolean)
      currentSuite = parts.length > 1 ? parts.slice(1).join(" > ") : heading
    }
  }

  return rows
}

/**
 * Extracts `stdout` from a target's decoded result or cache payload when it has
 * the `Exec.Result` shape.
 *
 * @category parsing
 * @since 1.0.0
 */
export const stdoutOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as { readonly stdout?: unknown; readonly value?: unknown; readonly result?: unknown }
  if (typeof record.stdout === "string") return record.stdout
  if (record.value !== undefined) return stdoutOf(record.value)
  if (record.result !== undefined) return stdoutOf(record.result)
  return undefined
}

const formatHz = (hz: number | undefined): string => {
  if (hz === undefined) return "-"
  if (hz >= 100_000) return `${Math.round(hz).toLocaleString("en-US")}/s`
  if (hz >= 1_000) return `${hz.toLocaleString("en-US", { maximumFractionDigits: 1 })}/s`
  if (hz >= 10) return `${hz.toFixed(1)}/s`
  return `${hz.toFixed(2)}/s`
}

const formatDurationMs = (ms: number | undefined): string => {
  if (ms === undefined) return "-"
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)}s`
  if (ms >= 10) return `${ms.toFixed(1)}ms`
  if (ms >= 1) return `${ms.toFixed(2)}ms`
  if (ms >= 0.001) return `${(ms * 1_000).toFixed(1)}µs`
  return `${(ms * 1_000_000).toFixed(0)}ns`
}

const displayName = (row: BenchmarkRow): string =>
  row.suite === undefined || row.suite === "" ? row.name : `${row.suite} :: ${row.name}`

/**
 * Formats benchmark results across all targets into a readable aligned table.
 * Returns `undefined` when no target reported benchmark rows.
 *
 * @category formatting
 * @since 1.0.0
 */
export const format = (
  targets: ReadonlyArray<TargetBenchmarks>,
  style: Ansi.Palette = Ansi.none
): string | undefined => {
  const entries: Array<{
    readonly target: string
    readonly benchmark: string
    readonly hz: string
    readonly mean: string
    readonly p99: string
    readonly rme: string
    readonly samples: string
    readonly status: TargetBenchmarks["status"]
  }> = []

  for (const target of targets) {
    if (target.benchmarks === undefined || target.benchmarks.length === 0) continue
    for (const row of target.benchmarks) {
      entries.push({
        target: target.label,
        benchmark: displayName(row),
        hz: formatHz(row.hz),
        mean: formatDurationMs(row.meanMs),
        p99: formatDurationMs(row.p99Ms),
        rme: row.rme ?? "-",
        samples: row.samples === undefined ? "-" : String(row.samples),
        status: target.status
      })
    }
  }

  if (entries.length === 0) return undefined

  const targetWidth = Math.max("TARGET".length, ...entries.map((entry) => entry.target.length))
  const benchWidth = Math.max("BENCHMARK".length, ...entries.map((entry) => entry.benchmark.length))
  const hzWidth = Math.max("OPS/S".length, ...entries.map((entry) => entry.hz.length))
  const meanWidth = Math.max("MEAN".length, ...entries.map((entry) => entry.mean.length))
  const p99Width = Math.max("P99".length, ...entries.map((entry) => entry.p99.length))
  const rmeWidth = Math.max("RME".length, ...entries.map((entry) => entry.rme.length))
  const samplesWidth = Math.max("SAMPLES".length, ...entries.map((entry) => entry.samples.length))

  const header = style.dim(
    `${"TARGET".padEnd(targetWidth)}  ${"BENCHMARK".padEnd(benchWidth)}  ${"OPS/S".padStart(hzWidth)}  ${
      "MEAN".padStart(meanWidth)
    }  ${"P99".padStart(p99Width)}  ${"RME".padStart(rmeWidth)}  ${"SAMPLES".padStart(samplesWidth)}  SOURCE`
  )

  const lines = entries.map((entry) => {
    const source = entry.status === "hit" ? style.dim("cached") : style.green("live")
    return `${style.cyan(entry.target.padEnd(targetWidth))}  ${entry.benchmark.padEnd(benchWidth)}  ${
      style.bold(entry.hz.padStart(hzWidth))
    }  ${entry.mean.padStart(meanWidth)}  ${entry.p99.padStart(p99Width)}  ${
      style.dim(entry.rme.padStart(rmeWidth))
    }  ${style.dim(entry.samples.padStart(samplesWidth))}  ${source}`
  })

  return [header, ...lines].join("\n")
}
