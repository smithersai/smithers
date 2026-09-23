/**
 * The user's own file flows (`flows/<name>/flow.ts`), run in background tabs.
 *
 * Mirrors `workspace.ts`: a request persists before any work, returns a
 * `requested` receipt, and settles only from the control plane's watch. The
 * `Port` is the seam to the native control host (`flow-control.ts`).
 */
import type { ControlSchema } from "@smthrs/control"
import * as NodeOutput from "@smthrs/cli/NodeOutput"
import type { Schema } from "effect"
import * as Form from "./form.ts"
import type * as Panels from "./panels.ts"
import type * as Session from "./session.ts"
import * as Summary from "./summary.ts"

type ControlEvent = ControlSchema.ControlEvent

export interface Listed {
  readonly name: string
  readonly description: string
  readonly modelInvocable: boolean
}
/** A plan card; `raw` is the control plane's, kept in memory only. */
export interface Card {
  readonly all: boolean
  readonly raw: unknown
}
export type Settled =
  | { readonly kind: "done"; readonly answer: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled" }
export interface Watch {
  /** Settles only at a terminal event; a run parked for approval keeps it open. */
  readonly done: Promise<Settled>
  readonly close: () => void
}
export interface Port {
  /** Registry only; never imports a flow module. */
  readonly discover: () => Promise<ReadonlyArray<Listed>>
  readonly input: (flow: string) => Promise<Schema.Top | undefined>
  readonly plan: (flow: string, input: unknown) => Promise<Card>
  /** Approves and launches. A signal interrupts approval only; an admitted launch still returns its receipt. */
  readonly start: (card: Card, source?: string, signal?: AbortSignal) => Promise<string>
  readonly resume: (runId: string) => Promise<{ readonly runId: string } | Settled>
  readonly watch: (runId: string, onEvent: (event: ControlEvent) => void) => Watch
  readonly events: (runId: string) => Promise<ReadonlyArray<ControlEvent>>
  readonly cancel: (runId: string) => Promise<void>
  readonly dispose: () => Promise<void>
}
export class FlowError extends Error {
  constructor(
    readonly code: "unknown_flow" | "refused" | "invalid_input" | "launch" | "control",
    message: string
  ) {
    super(message)
  }
}

export interface Run {
  readonly id: string
  readonly flow: string
  readonly by: "user" | "agent"
  readonly input: Record<string, unknown>
  /** The original input as JSON, for deduplication. */
  readonly requested: string
  readonly status: "queued" | "requested" | "input" | "approval" | "running" | "waiting" | "done" | "failed" | "cancelled"
  readonly runId?: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly message?: string
  readonly answer?: string
  /** A stop must follow an in-flight launch through its remote receipt. */
  readonly stopRequested?: true
}
export interface Request {
  readonly id?: string
  readonly flow: string
  readonly input: Record<string, unknown>
  readonly by: Run["by"]
}

export const interrupted = "Interrupted; retry to continue."
/** Concurrent flow runs; later requests wait FIFO in `queued` and start when one settles. */
export const seats = 3
/** Events the watch settles on; they never move a parked run back to running. */
export const terminal: ReadonlySet<string> = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled", "control.run.pending"])
const active = (run: Run) =>
  run.status === "requested" || run.status === "input" || run.status === "approval" || run.status === "running" ||
  run.status === "waiting"

export class FlowRuns {
  private runs = new Map<string, Run>()
  private events = new Map<string, Array<ControlEvent>>()
  private cards = new Map<string, Card>()
  private schemas = new Map<string, Schema.Top>()
  private watches = new Map<string, Watch>()
  private launching = new Map<string, AbortController>()
  private launches = new Set<Promise<void>>()
  /** Bumped by every restart of a run; a continuation from an older attempt drops its result. */
  private attempts = new Map<string, number>()
  private loaded = new Set<string>()
  private cache: ReadonlyArray<Listed> = []
  private discoveryFailure: string | undefined
  private discovery = 0
  private listeners = new Set<() => void>()
  private closed = false
  constructor(
    private options: {
      port?: Port | undefined
      persist: (record: Session.Record) => void
      restored?: ReadonlyArray<Run> | undefined
    }
  ) {
    for (const run of options.restored ?? []) {
      if (active(run) || run.status === "queued") this.save({ ...run, status: "failed", message: interrupted, endedAt: Date.now() })
      else this.runs.set(run.id, run)
    }
  }
  subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed() {
    for (const listener of this.listeners) listener()
  }
  snapshot = (): ReadonlyArray<Run> => [...this.runs.values()]
  get busy(): boolean {
    return [...this.runs.values()].some((run) => active(run) || run.status === "queued")
  }
  has = (id: string): boolean => this.runs.has(id)
  get = (id: string): Run | undefined => this.runs.get(id)
  /** The payload schema of a run parked for input. */
  schema = (id: string): Schema.Top | undefined => this.schemas.get(id)
  /** The last discovery; `refresh` updates it in the background. */
  listed = (): ReadonlyArray<Listed> => this.cache
  /** Why the newest discovery failed; cleared by the next one that succeeds. */
  failure = (): string | undefined => this.discoveryFailure
  private async discover() {
    const version = ++this.discovery
    let listed: ReadonlyArray<Listed>
    try {
      listed = await this.options.port!.discover()
    } catch (error) {
      if (version === this.discovery && !this.closed) {
        this.discoveryFailure = error instanceof Error ? error.message : String(error)
        this.changed()
      }
      throw error
    }
    if (version === this.discovery && !this.closed) {
      this.cache = listed
      this.discoveryFailure = undefined
      this.changed()
    }
    return listed
  }
  refresh = (): void => {
    const port = this.options.port
    if (port === undefined || this.closed) return
    // A failed listing keeps the last one and records `failure`; running a flow reports its own failure.
    this.discover().catch(() => {})
  }
  private save(run: Run) {
    this.options.persist({ type: "flow", run })
    this.runs.set(run.id, run)
    this.changed()
    if (!active(run) && run.status !== "queued") this.drain()
  }
  private full(): boolean {
    return [...this.runs.values()].filter(active).length >= seats
  }
  /** Starts queued runs, oldest request first, while a seat is free. */
  private drain() {
    if (this.closed) return
    const queued = [...this.runs.values()].filter((run) => run.status === "queued").sort((a, b) => a.startedAt - b.startedAt)
    for (const run of queued) {
      if (this.full()) return
      const attempt = this.attempt(run.id)
      this.save({ ...run, status: "requested", message: undefined })
      queueMicrotask(() => void this.prepare(run.id, attempt))
    }
  }
  private update(id: string, attempt: number, change: Partial<Run>) {
    const run = this.runs.get(id)
    if (run === undefined || this.closed || this.attempts.get(id) !== attempt) return undefined
    const next = { ...run, ...change }
    this.save(next)
    return next
  }
  private fail(id: string, attempt: number, error: unknown) {
    this.update(id, attempt, {
      status: "failed",
      endedAt: Date.now(),
      message: error instanceof Error ? error.message : String(error)
    })
  }
  private attempt(id: string): number {
    const next = (this.attempts.get(id) ?? 0) + 1
    this.attempts.set(id, next)
    return next
  }
  request = (request: Request): { id: string; status: Run["status"] } => {
    if (this.closed) throw new Error("Session closed")
    if (this.options.port === undefined) throw new Error("Flows unavailable")
    if (request.by === "agent" && this.cache.find((each) => each.name === request.flow)?.modelInvocable === false) {
      throw new Error(`${request.flow} is not for a model to start`)
    }
    const requested = JSON.stringify(request.input)
    const existing = request.id === undefined ? undefined : this.runs.get(request.id)
    if (existing !== undefined) {
      if (existing.flow !== request.flow || existing.requested !== requested) {
        throw new Error("Request id already belongs to another task")
      }
      return { id: existing.id, status: existing.status }
    }
    const id = request.id ?? `${request.flow}-${Date.now().toString(36)}`
    const run: Run = {
      id,
      flow: request.flow,
      by: request.by,
      input: request.input,
      requested,
      status: this.full() ? "queued" : "requested",
      startedAt: Date.now()
    }
    // Persist FIRST; the receipt acknowledges only the request.
    this.save(run)
    if (run.status === "queued") return { id, status: "queued" }
    const attempt = this.attempt(id)
    queueMicrotask(() => void this.prepare(id, attempt))
    return { id, status: "requested" }
  }
  private async prepare(id: string, attempt: number) {
    const port = this.options.port!
    try {
      const listed = await this.discover()
      const run = this.runs.get(id)
      if (run === undefined || this.attempts.get(id) !== attempt || this.closed) return
      const found = listed.find((each) => each.name === run.flow)
      if (found === undefined) throw new FlowError("unknown_flow", `Unknown flow ${run.flow}`)
      if (run.by === "agent" && !found.modelInvocable) {
        throw new FlowError("refused", `${run.flow} is not for a model to start`)
      }
      const schema = await port.input(run.flow)
      if (this.attempts.get(id) !== attempt || this.closed) return
      if (schema !== undefined && !Form.valid(schema, run.input)) {
        this.schemas.set(id, schema)
        const fields = Form.fields(schema)
        const missing = Form.missing(fields, Form.draft(fields, run.input))
        this.update(id, attempt, {
          status: "input",
          message: missing.length === 0 ? "Invalid input" : `Needs: ${missing.join(", ")}`
        })
        return
      }
      await this.plan(id, attempt)
    } catch (error) {
      this.fail(id, attempt, error)
    }
  }
  private async plan(id: string, attempt: number) {
    const run = this.runs.get(id)!
    const card = await this.options.port!.plan(run.flow, run.input)
    if (this.attempts.get(id) !== attempt || this.closed) return
    if (card.all) {
      this.cards.set(id, card)
      this.update(id, attempt, { status: "approval", message: "Approve: all capabilities" })
      return
    }
    await this.launch(id, attempt, card)
  }
  private launch(id: string, attempt: number, card: Card): Promise<void> {
    const task = this.start(id, attempt, card)
    this.launches.add(task)
    const settled = () => { this.launches.delete(task) }
    void task.then(settled, settled)
    return task
  }
  private async start(id: string, attempt: number, card: Card) {
    const controller = new AbortController()
    this.launching.set(id, controller)
    try {
      const runId = await this.options.port!.start(card, `flow:${id}`, controller.signal)
      const run = this.runs.get(id)!
      if (this.closed) {
        // Preserve the receipt even after the UI detached; retry must target this run.
        this.save({ ...run, runId, status: "failed", message: interrupted, endedAt: Date.now() })
      } else {
        if (this.update(id, attempt, { status: "running", runId, message: undefined }) === undefined) return
        this.follow(id, attempt, runId)
      }
      if (run.stopRequested) await this.stop(id, runId)
    } finally {
      this.launching.delete(id)
    }
  }
  private async stop(id: string, runId: string) {
    try {
      await this.options.port!.cancel(runId)
    } catch (error) {
      const current = this.runs.get(id)
      if (current !== undefined && (active(current) || this.closed)) {
        this.save({ ...current, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  private follow(id: string, attempt: number, runId: string) {
    this.events.set(id, [])
    this.loaded.add(id)
    const watch = this.options.port!.watch(runId, (event) => {
      if (this.attempts.get(id) !== attempt) return
      this.events.get(id)?.push(event)
      const status = this.runs.get(id)?.status
      if (event.kind === "control.run.waiting-approval" && status === "running") this.update(id, attempt, { status: "waiting" })
      else if (status === "waiting" && event.kind !== "control.run.waiting-approval" && !terminal.has(event.kind)) this.update(id, attempt, { status: "running" })
      else this.changed()
    })
    this.watches.set(id, watch)
    watch.done.then((settled) => {
      this.watches.delete(id)
      this.settle(id, attempt, settled)
    }, (error) => {
      this.watches.delete(id)
      this.fail(id, attempt, error)
    })
  }
  private settle(id: string, attempt: number, settled: Settled) {
    const endedAt = Date.now()
    if (settled.kind === "done") this.update(id, attempt, { status: "done", answer: settled.answer, endedAt, message: undefined })
    else if (settled.kind === "failed") this.update(id, attempt, { status: "failed", message: settled.message, endedAt })
    else this.update(id, attempt, { status: "cancelled", endedAt, message: undefined })
  }
  /** Supplies the input a run parked for, then plans it. */
  fill = (id: string, input: Record<string, unknown>): void => {
    const run = this.runs.get(id)
    if (run?.status !== "input" || this.closed) return
    const attempt = this.attempt(id)
    this.save({ ...run, input, status: "requested", message: undefined })
    void this.plan(id, attempt).catch((error) => this.fail(id, attempt, error))
  }
  /** The human approves a run whose envelope grants every capability. */
  approve = (id: string): void => {
    const run = this.runs.get(id)
    const card = this.cards.get(id)
    if (run?.status !== "approval" || card === undefined || this.closed) return
    this.cards.delete(id)
    const attempt = this.attempt(id)
    this.save({ ...run, status: "requested", message: undefined })
    void this.launch(id, attempt, card).catch((error) => this.fail(id, attempt, error))
  }
  cancel = (id: string): void => {
    const run = this.runs.get(id)
    if (run === undefined || (!active(run) && run.status !== "queued")) return
    if (this.launching.has(id)) {
      this.save({ ...run, stopRequested: true, message: "Stopping" })
      this.launching.get(id)!.abort()
      return
    }
    if (run.runId !== undefined && (run.status === "running" || run.status === "waiting")) {
      // The watch settles the status; a refused cancel keeps it running.
      this.save({ ...run, stopRequested: true })
      void this.stop(id, run.runId)
      return
    }
    this.attempt(id)
    this.cards.delete(id)
    this.save({ ...run, status: "cancelled", endedAt: Date.now() })
  }
  /** Runs a failed or stopped run again; the receipt says whether it waits for a seat. */
  retry = (id: string): { id: string; status: Run["status"] } => {
    const run = this.runs.get(id)
    if (run === undefined) throw new Error("Unknown tab")
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new Error(`Only a failed or stopped run can be retried; ${id} is ${run.status}`)
    }
    if (this.closed) throw new Error("Session closed")
    if (this.options.port === undefined) throw new Error("Flows unavailable")
    const { endedAt: _ended, answer: _answer, ...rest } = run
    if (this.full()) {
      const { runId: _runId, stopRequested: _stop, ...fresh } = rest
      this.save({ ...fresh, status: "queued", message: undefined, startedAt: Date.now() })
      return { id, status: "queued" }
    }
    const attempt = this.attempt(id)
    if (run.runId !== undefined && run.stopRequested && run.status === "failed") {
      this.save({ ...rest, status: "running", message: undefined })
      this.follow(id, attempt, run.runId)
      void this.stop(id, run.runId)
      return { id, status: "running" }
    }
    if (run.runId !== undefined && run.message === interrupted) {
      const runId = run.runId
      this.save({ ...rest, status: "running", message: undefined })
      this.options.port.resume(runId).then((receipt) => {
        if ("runId" in receipt) {
          if (this.update(id, attempt, { runId: receipt.runId }) !== undefined) this.follow(id, attempt, receipt.runId)
        } else this.settle(id, attempt, receipt)
      }, (error) => this.fail(id, attempt, error))
      return { id, status: "running" }
    }
    const { runId: _runId, stopRequested: _stop, ...fresh } = rest
    this.save({ ...fresh, status: "requested", message: undefined, startedAt: Date.now() })
    queueMicrotask(() => void this.prepare(id, attempt))
    return { id, status: "requested" }
  }
  panel = (id: string): Panels.Panel => {
    const run = this.runs.get(id)
    if (run === undefined) return { id: `flow:${id}`, title: id, summary: "Unknown run.", rows: [] }
    if (run.runId !== undefined && !this.loaded.has(id)) {
      // A restored run: read its recorded events once, in the background.
      this.loaded.add(id)
      const attempt = this.attempts.get(id)
      this.options.port?.events(run.runId).then((events) => {
        if (this.attempts.get(id) !== attempt || this.events.get(id)?.length) return
        this.events.set(id, [...events])
        this.changed()
      }, () => { /* The summary keeps the persisted status and message. */ })
    }
    const summary = run.message ??
      (run.status === "done"
        ? Summary.sentence(run.answer ?? "Done.")
        : run.status === "requested"
        ? "Requested."
        : run.status === "queued"
        ? "Queued."
        : run.status === "cancelled"
        ? "Stopped."
        : run.status === "waiting"
        ? "Waiting."
        : "Running.")
    const nodes = NodeOutput.project(this.events.get(id) ?? []).map((node) => ({
      id: node.nodeId,
      label: node.flowName,
      status: node.outcome === "success" ? "done" as const : node.outcome === "failure" ? "failed" as const : "running" as const,
      details: [{
        kind: "code" as const,
        language: "json",
        code: (JSON.stringify(node.value ?? node.message ?? null, null, 2) ?? "null").slice(0, 200_000)
      }]
    }))
    const act = run.status === "input"
      ? [{ id: "act", label: "Fill in", details: [], action: { label: "Fill in", prompt: "" } }]
      : run.status === "approval"
      ? [{ id: "act", label: "Approve", details: [], action: { label: "Approve", prompt: "" } }]
      : []
    const result = run.answer !== undefined && !nodes.some((node) => node.id === NodeOutput.resultNodeId)
      ? [{ id: NodeOutput.resultNodeId, label: "Result", status: "done" as const, details: [{ kind: "code" as const, code: run.answer.slice(0, 200_000) }] }]
      : []
    return { id: `flow:${id}`, title: run.flow, summary, rows: [...act, ...nodes, ...result] }
  }
  read = (id: string) => {
    const run = this.runs.get(id)
    if (run === undefined) throw new Error("Unknown tab")
    const panel = this.panel(id)
    return {
      id: run.id,
      flow: run.flow,
      status: run.status,
      answer: run.answer?.slice(0, 8000),
      message: run.message,
      steps: panel.rows.slice(-8).map((row) => ({ label: row.label, status: row.status }))
    }
  }
  context = (): string =>
    JSON.stringify(
      [...this.runs.values()].map(({ id, flow, status, answer, message }) => ({
        id,
        flow,
        status,
        answer: answer?.slice(0, 6000),
        message: message?.slice(0, 500)
      }))
    )
  dispose = async (): Promise<void> => {
    this.closed = true
    for (const controller of this.launching.values()) controller.abort()
    for (const watch of this.watches.values()) watch.close()
    this.watches.clear()
    await Promise.allSettled(this.launches)
  }
}
