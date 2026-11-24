import * as Data from "effect/Data"
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

/**
 * Comparison between a current benchmark measurement and a baseline entry.
 *
 * @category models
 * @since 1.0.0
 */
export interface BenchmarkDelta {
  readonly target: string
  readonly benchmark: string
  readonly currentHz?: number | undefined
  readonly baselineHz?: number | undefined
  readonly currentMeanMs?: number | undefined
  readonly baselineMeanMs?: number | undefined
  /** Throughput ratio (`current / baseline`): `> 1` is faster, `< 1` is slower. */
  readonly speedupRatio?: number | undefined
  /** Percentage throughput drop (`(1 - speedupRatio) * 100`): positive when slower, negative when faster. */
  readonly regressionPercent?: number | undefined
  readonly status: "faster" | "slower" | "same" | "new"
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

const baselineKey = (target: string, benchmark: string): string => `${target}\0${benchmark}`

const validStatuses: ReadonlySet<string> = new Set(["hit", "ran", "failed", "skipped", "cancelled"])

const parseBaselineRow = (raw: unknown): BenchmarkRow | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record["name"] !== "string" || record["name"].length === 0) return undefined
  return {
    ...(typeof record["suite"] === "string" && record["suite"].length > 0 ? { suite: record["suite"] } : {}),
    name: record["name"],
    ...(typeof record["hz"] === "number" && Number.isFinite(record["hz"]) ? { hz: record["hz"] } : {}),
    ...(typeof record["minMs"] === "number" && Number.isFinite(record["minMs"]) ? { minMs: record["minMs"] } : {}),
    ...(typeof record["maxMs"] === "number" && Number.isFinite(record["maxMs"]) ? { maxMs: record["maxMs"] } : {}),
    ...(typeof record["meanMs"] === "number" && Number.isFinite(record["meanMs"]) ? { meanMs: record["meanMs"] } : {}),
    ...(typeof record["p75Ms"] === "number" && Number.isFinite(record["p75Ms"]) ? { p75Ms: record["p75Ms"] } : {}),
    ...(typeof record["p99Ms"] === "number" && Number.isFinite(record["p99Ms"]) ? { p99Ms: record["p99Ms"] } : {}),
    ...(typeof record["rme"] === "string" && record["rme"].length > 0 ? { rme: record["rme"] } : {}),
    ...(typeof record["samples"] === "number" && Number.isFinite(record["samples"])
      ? { samples: record["samples"] }
      : {}),
    ...(typeof record["note"] === "string" && record["note"].length > 0 ? { note: record["note"] } : {})
  }
}

/**
 * Decodes a benchmark baseline from either a `--results-file` JSON envelope
 * (`{ results: [...] }`) or an array of {@link TargetBenchmarks}.
 *
 * @category parsing
 * @since 1.0.0
 */
class BenchBaselineError extends Data.TaggedError("BenchBaselineError")<{ readonly message: string }> {}

export const loadBaseline = (raw: unknown): ReadonlyArray<TargetBenchmarks> => {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { readonly results?: unknown }).results)
    ? (raw as { readonly results: ReadonlyArray<unknown> }).results
    : undefined
  if (list === undefined) {
    throw new BenchBaselineError({
      message: "benchmark baseline must be a --results-file JSON object with a results array or a target array"
    })
  }
  const targets: Array<TargetBenchmarks> = []
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record["label"] !== "string" || record["label"].length === 0) continue
    const rawBenchmarks = Array.isArray(record["benchmarks"]) ? record["benchmarks"] : undefined
    const benchmarks = rawBenchmarks === undefined
      ? undefined
      : rawBenchmarks.map(parseBaselineRow).filter((row): row is BenchmarkRow => row !== undefined)
    const status = typeof record["status"] === "string" && validStatuses.has(record["status"])
      ? (record["status"] as TargetBenchmarks["status"])
      : "ran"
    targets.push({
      label: record["label"],
      status,
      ...(benchmarks === undefined || benchmarks.length === 0 ? {} : { benchmarks })
    })
  }
  return targets
}

const sameBandRatio = 0.03

/**
 * Compares current benchmark measurements against a baseline snapshot.
 *
 * Uses throughput (`hz`) when both sides report positive values, falling back
 * to inverse mean latency (`meanMs`) otherwise.
 *
 * @category comparison
 * @since 1.0.0
 */
export const compare = (
  current: ReadonlyArray<TargetBenchmarks>,
  baseline: ReadonlyArray<TargetBenchmarks>
): ReadonlyArray<BenchmarkDelta> => {
  const baselineIndex = new Map<string, BenchmarkRow>()
  for (const target of baseline) {
    if (target.benchmarks === undefined) continue
    for (const row of target.benchmarks) {
      baselineIndex.set(baselineKey(target.label, displayName(row)), row)
    }
  }

  const deltas: Array<BenchmarkDelta> = []
  for (const target of current) {
    if (target.benchmarks === undefined || target.benchmarks.length === 0) continue
    for (const row of target.benchmarks) {
      const benchmark = displayName(row)
      const previous = baselineIndex.get(baselineKey(target.label, benchmark))
      if (previous === undefined) {
        deltas.push({
          target: target.label,
          benchmark,
          ...(row.hz === undefined ? {} : { currentHz: row.hz }),
          ...(row.meanMs === undefined ? {} : { currentMeanMs: row.meanMs }),
          status: "new"
        })
        continue
      }

      const speedupRatio = row.hz !== undefined && row.hz > 0 && previous.hz !== undefined && previous.hz > 0
        ? row.hz / previous.hz
        : row.meanMs !== undefined && row.meanMs > 0 && previous.meanMs !== undefined && previous.meanMs > 0
        ? previous.meanMs / row.meanMs
        : undefined
      const regressionPercent = speedupRatio === undefined ? undefined : (1 - speedupRatio) * 100
      const status: BenchmarkDelta["status"] = speedupRatio === undefined
        ? "same"
        : Math.abs(speedupRatio - 1) < sameBandRatio
        ? "same"
        : speedupRatio > 1
        ? "faster"
        : "slower"

      deltas.push({
        target: target.label,
        benchmark,
        ...(row.hz === undefined ? {} : { currentHz: row.hz }),
        ...(previous.hz === undefined ? {} : { baselineHz: previous.hz }),
        ...(row.meanMs === undefined ? {} : { currentMeanMs: row.meanMs }),
        ...(previous.meanMs === undefined ? {} : { baselineMeanMs: previous.meanMs }),
        ...(speedupRatio === undefined ? {} : { speedupRatio }),
        ...(regressionPercent === undefined ? {} : { regressionPercent }),
        status
      })
    }
  }
  return deltas
}

/**
 * Selects benchmark deltas whose throughput dropped by more than
 * `thresholdPercent` compared to the baseline.
 *
 * @category comparison
 * @since 1.0.0
 */
export const regressions = (
  deltas: ReadonlyArray<BenchmarkDelta>,
  thresholdPercent: number
): ReadonlyArray<BenchmarkDelta> =>
  deltas.filter((delta) => delta.regressionPercent !== undefined && delta.regressionPercent > thresholdPercent)

const formatDeltaPlain = (delta: BenchmarkDelta): string => {
  if (delta.status === "new") return "new"
  if (delta.speedupRatio === undefined) return "-"
  if (delta.status === "same") {
    const pct = (delta.speedupRatio - 1) * 100
    return `~${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`
  }
  if (delta.status === "faster") {
    if (delta.speedupRatio >= 10) return `+${delta.speedupRatio.toFixed(1)}x`
    if (delta.speedupRatio >= 1.5) return `+${delta.speedupRatio.toFixed(2)}x`
    return `+${((delta.speedupRatio - 1) * 100).toFixed(1)}%`
  }
  return `-${((1 - delta.speedupRatio) * 100).toFixed(1)}%`
}

const colorDelta = (delta: BenchmarkDelta, padded: string, style: Ansi.Palette): string => {
  if (delta.status === "faster") return style.green(padded)
  if (delta.status === "slower") return style.red(padded)
  if (delta.status === "new") return style.cyan(padded)
  return style.dim(padded)
}

/**
 * Formats benchmark results across all targets into a readable aligned table.
 * When `baseline` is supplied, adds a `DELTA` column showing speedup or
 * regression against the baseline. Returns `undefined` when no target reported
 * benchmark rows.
 *
 * @category formatting
 * @since 1.0.0
 */
export const format = (
  targets: ReadonlyArray<TargetBenchmarks>,
  style: Ansi.Palette = Ansi.none,
  baseline?: ReadonlyArray<TargetBenchmarks> | undefined
): string | undefined => {
  const deltaMap = baseline === undefined
    ? undefined
    : new Map(compare(targets, baseline).map((delta) => [baselineKey(delta.target, delta.benchmark), delta]))

  const entries: Array<{
    readonly target: string
    readonly benchmark: string
    readonly hz: string
    readonly mean: string
    readonly p99: string
    readonly rme: string
    readonly samples: string
    readonly delta?: BenchmarkDelta | undefined
    readonly deltaText: string
    readonly status: TargetBenchmarks["status"]
  }> = []

  for (const target of targets) {
    if (target.benchmarks === undefined || target.benchmarks.length === 0) continue
    for (const row of target.benchmarks) {
      const benchmark = displayName(row)
      const delta = deltaMap?.get(baselineKey(target.label, benchmark))
      entries.push({
        target: target.label,
        benchmark,
        hz: formatHz(row.hz),
        mean: formatDurationMs(row.meanMs),
        p99: formatDurationMs(row.p99Ms),
        rme: row.rme ?? "-",
        samples: row.samples === undefined ? "-" : String(row.samples),
        delta,
        deltaText: delta === undefined ? "" : formatDeltaPlain(delta),
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
  const deltaWidth = deltaMap === undefined
    ? 0
    : Math.max("DELTA".length, ...entries.map((entry) => entry.deltaText.length))

  const header = style.dim(
    `${"TARGET".padEnd(targetWidth)}  ${"BENCHMARK".padEnd(benchWidth)}  ${"OPS/S".padStart(hzWidth)}  ${
      "MEAN".padStart(meanWidth)
    }  ${"P99".padStart(p99Width)}  ${"RME".padStart(rmeWidth)}  ${"SAMPLES".padStart(samplesWidth)}${
      deltaMap === undefined ? "" : `  ${"DELTA".padStart(deltaWidth)}`
    }  SOURCE`
  )

  const lines = entries.map((entry) => {
    const source = entry.status === "hit" ? style.dim("cached") : style.green("live")
    const deltaColumn = entry.delta === undefined
      ? ""
      : `  ${colorDelta(entry.delta, entry.deltaText.padStart(deltaWidth), style)}`
    return `${style.cyan(entry.target.padEnd(targetWidth))}  ${entry.benchmark.padEnd(benchWidth)}  ${
      style.bold(entry.hz.padStart(hzWidth))
    }  ${entry.mean.padStart(meanWidth)}  ${entry.p99.padStart(p99Width)}  ${
      style.dim(entry.rme.padStart(rmeWidth))
    }  ${style.dim(entry.samples.padStart(samplesWidth))}${deltaColumn}  ${source}`
  })

  return [header, ...lines].join("\n")
}
