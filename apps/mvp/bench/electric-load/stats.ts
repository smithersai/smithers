// The electric-load harness's arithmetic: one host's devices' record, and the report several hosts' records make
// together. No I/O, so `node --test bench/electric-load/*.test.ts` proves it.
import { percentile } from "../stats.ts"

/** One HTTP response a device's Electric client got from a shape route. */
export interface Response {
  readonly status: number
  readonly live: boolean
}

/** What one host's devices saw during a run (`run.ts` writes it as JSON). */
export interface HostRecord {
  readonly host: string
  readonly devices: number
  readonly signedIn: boolean
  readonly startedAt: string
  readonly endedAt: string
  readonly routes: number
  /** Response counts keyed `<status> <live|initial>`. */
  readonly responses: Readonly<Record<string, number>>
  /** Requests that got no response at all (network errors, timeouts). */
  readonly unanswered: number
  /** Per device and route, ms from the device's start to the route's first up-to-date; `null` if it never got there. */
  readonly upToDateMs: ReadonlyArray<number | null>
  /** Per device, ms from the write to the first change on the write's shape; `null` if none came. Empty without a write. */
  readonly writeToDeviceMs: ReadonlyArray<number | null>
}

/** The key a response is counted under. */
export const keyOf = (response: Response): string => `${response.status} ${response.live ? "live" : "initial"}`

/** Adds `response` to `counts`. */
export const count = (counts: Record<string, number>, response: Response): void => {
  const key = keyOf(response)
  counts[key] = (counts[key] ?? 0) + 1
}

/** Several hosts' records, summed: what the run as a whole saw. */
export interface Report {
  readonly devices: number
  readonly seconds: number
  readonly requests: number
  readonly requestsPerSecond: number
  readonly status5xx: number
  readonly status503: number
  readonly status429: number
  readonly unanswered: number
  /** Up-to-date times in ms over every device's every route; `never` counts routes that never got there. */
  readonly upToDate: { readonly p50: number | null; readonly p99: number | null; readonly max: number | null; readonly over10s: number; readonly never: number }
  readonly writeToAllDevices: { readonly p50: number | null; readonly p99: number | null; readonly missed: number } | null
  /** Whether the run passed: no 5xx, no 429, every request answered, every route up to date within 10 s. */
  readonly pass: boolean
}

const statusOf = (key: string) => Number(key.split(" ")[0])

const quantiles = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return { p50: null, p99: null, max: null }
  return { p50: Math.round(percentile(sorted, 0.5)), p99: Math.round(percentile(sorted, 0.99)), max: sorted.at(-1)! }
}

/** The run's report from each host's record. Its window runs from the first start to the last end. */
export const report = (records: ReadonlyArray<HostRecord>): Report => {
  const sum = (pick: (status: number) => boolean) =>
    records.reduce((total, record) =>
      total + Object.entries(record.responses).reduce((n, [key, value]) => n + (pick(statusOf(key)) ? value : 0), 0), 0)
  const requests = sum(() => true)
  const start = Math.min(...records.map((record) => Date.parse(record.startedAt)))
  const end = Math.max(...records.map((record) => Date.parse(record.endedAt)))
  const seconds = Math.max(1, Math.round((end - start) / 1000))
  const upToDate = records.flatMap((record) => record.upToDateMs)
  const reached = upToDate.filter((ms): ms is number => ms !== null)
  const writes = records.flatMap((record) => record.writeToDeviceMs)
  const delivered = writes.filter((ms): ms is number => ms !== null)
  const status5xx = sum((status) => status >= 500)
  const status429 = sum((status) => status === 429)
  const unanswered = records.reduce((n, record) => n + record.unanswered, 0)
  const over10s = reached.filter((ms) => ms > 10_000).length
  const never = upToDate.length - reached.length
  const { p50, p99, max } = quantiles(reached)
  const write = quantiles(delivered)
  return {
    devices: records.reduce((n, record) => n + record.devices, 0),
    seconds,
    requests,
    requestsPerSecond: Math.round(requests / seconds),
    status5xx,
    status503: sum((status) => status === 503),
    status429,
    unanswered,
    upToDate: { p50, p99, max, over10s, never },
    writeToAllDevices: writes.length === 0 ? null : { p50: write.p50, p99: write.p99, missed: writes.length - delivered.length },
    pass: status5xx === 0 && status429 === 0 && unanswered === 0 && over10s === 0 && never === 0,
  }
}

/** One Markdown table row for `report`, under `HEADER`. */
export const row = (label: string, r: Report): string =>
  `| ${label} | ${r.devices} | ${r.seconds} | ${r.requests} | ${r.requestsPerSecond} | ${r.status5xx} (${r.status503}) | ${r.status429} | ${r.unanswered} | ${r.upToDate.p50 ?? "-"} / ${r.upToDate.p99 ?? "-"} | ${r.upToDate.over10s + r.upToDate.never} | ${r.pass ? "pass" : "fail"} |`

export const HEADER = "| Run | Devices | s | Requests | req/s | 5xx (503) | 429 | Unanswered | Up to date p50 / p99 ms | Not up to date in 10 s | Result |\n|---|---|---|---|---|---|---|---|---|---|---|"
