import { expect } from "@playwright/test"
import { open, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { baseURL, guard, target } from "./target"

// ChatApi's records, for the e2e tests that read what it recorded (docs/observability.md): its own, the remote flows'
// its `FlowExecution` objects ran, and the browser's and the engine worker's OTLP records it relayed (`otlp.signal`).
// Locally `alchemy dev` writes each Worker's log under `.alchemy/log/dev_<user>/<Worker>/`. A deployment's come from a
// Cloudflare tail on ChatApi's script (`CloudflareTail`), which needs `CLOUDFLARE_API_TOKEN` (Workers Tail read) and
// `CLOUDFLARE_ACCOUNT_ID`. A test that reads them declares `requires("localLogs")`, or reads them only where
// `partly("localLogs")` says it can (e2e/target.ts).

const LOG_ROOT = fileURLToPath(new URL("../.alchemy/log", import.meta.url))

export type LogRecord = { message?: unknown; level?: string; annotations?: Record<string, unknown>; [key: string]: unknown }
export type Line = { worker: string; file: string; text: string; record?: LogRecord }

/** A tail's log message as a record: the structured logger's JSON line, parsed, or the object it logged. */
export const recordOf = (message: unknown): LogRecord | undefined => {
  let parsed: unknown = message
  if (typeof message === "string") {
    try {
      parsed = JSON.parse(message)
    } catch {
      return undefined
    }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as LogRecord : undefined
}

/** A capture retains a gap permanently, including after Cloudflare resumes streaming. No request metadata is kept. */
type TailEvent = {
  event?: { type?: string; request?: { url?: string; headers?: Record<string, string> } }
  eventTimestamp?: number
  outcome?: string
  logs?: Array<{ message?: Array<unknown> }>
}

export class TailCapture {
  readonly receipts: Array<{ signal: string; bytes: number; outcome: string; target: number; at?: number }> = []
  private readonly received: Array<Line> = []
  private lost: string | undefined

  get failure() { return this.lost }

  get lines(): Array<Line> {
    if (this.lost !== undefined) throw new Error(this.lost)
    return this.received
  }

  fail(reason: "sampling" | "disconnected" | "failed" | "malformed") {
    this.lost ??= reason === "sampling"
      ? "Cloudflare log tail entered sampling mode; capture is incomplete"
      : `Cloudflare log tail ${reason}; capture is incomplete`
  }

  add(event: TailEvent) {
    if (event.event?.type === "overload") this.fail("sampling")
    const signal = event.event?.request?.url?.match(/\/api\/telemetry\/v1\/(logs|metrics|traces)(?:\?|$)/)?.[1]
    const before = this.received.length
    for (const log of event.logs ?? []) for (const message of log.message ?? []) {
      const record = recordOf(message)
      this.received.push({ worker: "ChatApi", file: "tail", text: typeof message === "string" ? message : JSON.stringify(message),
        ...(record === undefined ? {} : { record }) })
    }
    if (signal !== undefined) {
      const size = Number(event.event?.request?.headers?.["content-length"])
      this.receipts.push({ signal, bytes: Number.isFinite(size) ? size : 0,
        outcome: ["ok", "canceled", "exception"].includes(event.outcome ?? "") ? event.outcome! : "other",
        target: this.received.slice(before).filter(({ record }) =>
          record?.annotations?.flow === "app/theme/set" || record?.annotations?.["smithers.flow"] === "app/theme/set"
        ).length,
        ...(typeof event.eventTimestamp === "number" ? { at: event.eventTimestamp } : {}),
      })
    }
  }
}

/** Standard WebSocket frame representations; decoding keeps the message's complete byte range. */
export const frameText = async (data: unknown): Promise<string> => {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
  return (data as Blob).text()
}

/** The ChatApi script a deployment's tail opens on: `E2E_CHATAPI_SCRIPT`, else the one named for `E2E_STAGE` (prod). */
const CAPTURE_HEADER = "x-smithers-e2e-capture"
const SCRIPT_PREFIX = (stage: string) => `smithers-mvp-chatapi-${stage}-`

/**
 * A Cloudflare tail on a deployment's ChatApi script, one per test process: the records it has streamed since it
 * opened, in arrival order. Opened on first use and deleted when the process ends or `close` is called. Prints and
 * keeps no token, header or request body: only each log line's own text.
 */
export class CloudflareTail {
  private static opened: Promise<CloudflareTail> | undefined
  private static current: CloudflareTail | undefined
  private closed = false
  private readonly capture = new TailCapture()
  readonly readinessTraceId = crypto.randomUUID().replaceAll("-", "")
  get lines(): Array<Line> { return this.capture.lines }
  get receipts() { return this.capture.receipts }
  get captureHeaders(): Record<string, string> { return this.captureId === undefined ? {} : { [CAPTURE_HEADER]: this.captureId } }

  private constructor(
    private readonly api: string,
    private readonly apiHeaders: Record<string, string>,
    private readonly id: string,
    private readonly socket: WebSocket,
    private readonly postOnly: boolean,
    private readonly captureId?: string,
  ) {}

  /** The process's tail, opened now if it isn't. */
  static async shared(env: NodeJS.ProcessEnv = process.env, postOnly = false, captureId?: string): Promise<CloudflareTail> {
    const current = CloudflareTail.current
    if (current !== undefined && (current.capture.failure !== undefined || current.postOnly !== postOnly || current.captureId !== captureId)) await current.close()
    CloudflareTail.opened ??= CloudflareTail.open(env, postOnly, captureId).catch((cause: unknown) => {
      CloudflareTail.opened = undefined
      throw cause
    })
    return CloudflareTail.opened
  }

  private static async open(env: NodeJS.ProcessEnv, postOnly: boolean, captureId?: string): Promise<CloudflareTail> {
    const token = env.CLOUDFLARE_API_TOKEN ?? ""
    const account = env.CLOUDFLARE_ACCOUNT_ID ?? ""
    if (token === "" || account === "") throw new Error("A deployment's logs need CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const scripts = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`
    const script = env.E2E_CHATAPI_SCRIPT ?? await CloudflareTail.script(scripts, headers, env.E2E_STAGE ?? "prod")
    const api = `${scripts}/${script}/tails`
    // Filters are a create-tail HTTP parameter. The WebSocket accepts the debug control message, not filters.
    const filters = [
      ...(postOnly ? [{ method: ["POST"] }] : []),
      ...(captureId === undefined ? [] : [{ header: { key: CAPTURE_HEADER, query: captureId } }]),
    ]
    const created = await (await fetch(api, { method: "POST", headers, body: JSON.stringify({ filters }) })).json() as {
      success: boolean
      errors?: Array<{ code: number }>
      result?: { id: string; url: string }
    }
    if (!created.success || created.result === undefined) {
      throw new Error(`Cloudflare refused a tail on ${script}: ${JSON.stringify(created.errors?.map((error) => error.code))}`)
    }
    const socket = new WebSocket(created.result.url, "trace-v1")
    socket.binaryType = "arraybuffer"
    const tail = new CloudflareTail(api, headers, created.result.id, socket, postOnly, captureId)
    CloudflareTail.current = tail
    socket.addEventListener("message", (event) => {
      void tail.receive(event.data).catch(() => tail.capture.fail("malformed"))
    })
    socket.addEventListener("close", () => { tail.capture.fail("disconnected") })
    socket.addEventListener("error", () => { tail.capture.fail("failed") })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true })
        socket.addEventListener("error", () => reject(new Error(`The tail on ${script} didn't connect`)), { once: true })
      })
      socket.send(JSON.stringify({ debug: false }))
      process.once("beforeExit", () => void tail.close())
      await tail.streaming(new URL("/api/questions", env.E2E_PROD_URL ?? baseURL))
      return tail
    } catch (cause) {
      await tail.close()
      throw cause
    }
  }

  /**
   * A fresh, content-free refused ask proves this connection sees this request's trace. Unrelated traffic cannot
   * release the barrier, and no receipt is a capture failure rather than an empty production log. No question is stored.
   */
  private async streaming(probe: URL) {
    const traceId = this.readinessTraceId
    const spanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16)
    const observed = () => this.lines.some(({ record }) => record?.message === "chat.question" && traceIdOf(record) === traceId)
    for (let tries = 0; tries < 15 && !observed(); tries++) {
      const arrived = new Promise<void>((resolve) => {
        this.arrivals.push(() => {
          if (this.capture.failure !== undefined || observed()) resolve()
        })
        AbortSignal.timeout(2_000).addEventListener("abort", () => resolve(), { once: true })
      })
      await fetch(probe, {
        method: "POST",
        headers: { ...this.captureHeaders, traceparent: `00-${traceId}-${spanId}-01`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(2_000),
      }).then((response) => response.body?.cancel(), () => undefined)
      await arrived
    }
    if (!observed()) {
      await this.close()
      throw new Error("Cloudflare log tail did not receive its readiness trace; capture is incomplete")
    }
  }

  /** Who waits for the next line. */
  private readonly arrivals: Array<() => void> = []

  /** The one script whose name starts with the stage's ChatApi prefix; only the scripts' ids are read. */
  private static async script(scripts: string, headers: Record<string, string>, stage: string): Promise<string> {
    const listed = await (await fetch(scripts, { headers })).json() as { result?: Array<{ id: string }> }
    const ids = (listed.result ?? []).map((script) => script.id).filter((id) => id.startsWith(SCRIPT_PREFIX(stage)))
    if (ids.length !== 1) throw new Error(`Expected one ChatApi script for stage ${stage}, found ${ids.length}; set E2E_CHATAPI_SCRIPT`)
    return ids[0]!
  }

  /** One tail event: each of its log lines, its JSON parsed when it is JSON. */
  private async receive(data: unknown) {
    const text = await frameText(data)
    let event: TailEvent
    try {
      event = JSON.parse(text)
    } catch {
      this.capture.fail("malformed")
      for (const resolve of this.arrivals.splice(0)) resolve()
      return
    }
    this.capture.add(event)
    for (const resolve of this.arrivals.splice(0)) resolve()
  }

  /** Deletes the tail; the process's next `shared` opens another. */
  async close() {
    if (this.closed) return
    this.closed = true
    if (CloudflareTail.current === this) {
      CloudflareTail.opened = undefined
      CloudflareTail.current = undefined
    }
    this.socket.close()
    await fetch(`${this.api}/${this.id}`, { method: "DELETE", headers: this.apiHeaders }).catch(() => undefined)
  }
}

// The lines each Worker's log gains from now on. Locally files that already exist are read from their current end,
// and files `alchemy dev` starts after a reload are read whole; in a deployment, the tail's lines after `start`.
export class LogTail {
  private constructor(
    private readonly offsets: Map<string, number>,
    private readonly tail?: { readonly source: CloudflareTail; readonly from: number },
  ) {}

  private static async files() {
    const files: Array<{ worker: string; path: string }> = []
    const users = (await readdir(LOG_ROOT, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && entry.name.startsWith("dev_"))
    for (const user of users) {
      for (const worker of await readdir(join(LOG_ROOT, user.name), { withFileTypes: true })) {
        if (!worker.isDirectory()) continue
        const dir = join(LOG_ROOT, user.name, worker.name)
        for (const file of await readdir(dir)) if (file.endsWith(".log")) files.push({ worker: worker.name, path: join(dir, file) })
      }
    }
    return files
  }

  static async start(options: { readonly postOnly?: boolean; readonly isolated?: boolean } = {}) {
    guard("localLogs")
    if (target === "deployment") {
      const source = await CloudflareTail.shared(process.env, options.postOnly, options.isolated ? crypto.randomUUID() : undefined)
      return new LogTail(new Map(), { source, from: source.lines.length })
    }
    const offsets = new Map<string, number>()
    for (const { path } of await LogTail.files()) offsets.set(path, (await stat(path)).size)
    expect([...offsets.keys()].some((path) => path.includes("/ChatApi/")), `alchemy dev writes ChatApi's log under ${LOG_ROOT}`).toBe(true)
    return new LogTail(offsets)
  }

  get receipts() { return this.tail?.source.receipts ?? [] }
  get captureHeaders(): Record<string, string> { return this.tail?.source.captureHeaders ?? {} }

  async lines(): Promise<Array<Line>> {
    if (this.tail !== undefined) return this.tail.source.lines.slice(this.tail.from)
    const lines: Array<Line> = []
    for (const { worker, path } of await LogTail.files()) {
      const from = this.offsets.get(path) ?? 0
      const handle = await open(path, "r")
      try {
        const { size } = await handle.stat()
        if (size <= from) continue
        const buffer = Buffer.alloc(size - from)
        await handle.read(buffer, 0, buffer.length, from)
        for (const text of buffer.toString("utf8").split("\n")) {
          if (text.trim() === "") continue
          let record: LogRecord | undefined
          try {
            record = JSON.parse(text) as LogRecord
          } catch {
            record = undefined
          }
          lines.push({ worker, file: path, text, record })
        }
      } finally {
        await handle.close()
      }
    }
    return lines
  }

  /** Deletes a deployment's tail now rather than when the process ends; locally, nothing. */
  async dispose() {
    await this.tail?.source.close()
  }

  // ChatApi's JSON records: its own, and the browser's it relayed (they carry `otlp.signal`).
  async records() {
    const records = (await this.lines()).filter((line) => line.worker === "ChatApi" && line.record !== undefined).map((line) => line.record!)
    const relayed = (record: LogRecord) => record.annotations?.["otlp.signal"] !== undefined
    return { own: records.filter((record) => !relayed(record)), browser: records.filter(relayed) }
  }
}

// A record's trace id, wherever its logger put it: top level or annotations, as trace_id, traceId or trace.id.
export const traceIdOf = (record: LogRecord | undefined): string | undefined => {
  if (record === undefined) return undefined
  for (const fields of [record, record.annotations ?? {}]) {
    for (const [key, value] of Object.entries(fields)) {
      if (/^trace(_|\.)?id$/i.test(key) && typeof value === "string") return value
    }
  }
  return undefined
}

export const field = (record: LogRecord, name: string) => record.annotations?.[name]
