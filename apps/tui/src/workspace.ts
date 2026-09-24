/** Background work outlives a chat turn. Each tab has its own durable transcript. */
import type * as Context from "./context.ts"
import type * as Host from "./host.ts"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import { delegateModels, type DelegateModel } from "./models.ts"
import * as Panels from "./panels.ts"
import * as Session from "./session.ts"
import * as Summary from "./summary.ts"
import * as Transcript from "./transcript.ts"
import * as Tree from "./tree.ts"

export interface Tab {
  readonly id: string
  readonly parent?: string
  readonly depth: number
  readonly title: string
  readonly description?: string
  readonly prompt: string
  readonly seat: string
  /** Seat currently answering; `seat` remains the original resume choice. */
  readonly activeSeat?: string
  readonly file: string
  readonly status: "queued" | "requested" | "running" | "waiting" | "parked" | "done" | "failed" | "cancelled"
  readonly wakeAt?: number
  readonly failure?: FailureCopy.Description
  readonly detail?: string
  /** When the request was made; a queued tab waits before it launches. */
  readonly startedAt: number
  /** When the worker began, after any wait for a seat. */
  readonly launchedAt?: number
  readonly endedAt?: number
  readonly message?: string
  readonly answer?: string
}
export interface Request {
  readonly id: string
  readonly title: string
  readonly prompt: string
  readonly model?: DelegateModel
}
export interface Snapshot {
  readonly tabs: ReadonlyArray<Tab>
  readonly panels: ReadonlyArray<Panels.Panel>
}
/** Settled tabs whose answer every coordinator turn carries, and how much of each. */
const contextAnswers = 5
const contextAnswerChars = 1500
/** Concurrent worker seats; later requests wait FIFO in `queued`. */
export const seats = Math.max(1, Number.parseInt(process.env.SMITHERS_TUI_WORKERS ?? "6", 10) || 6)
const active = (tab: Tab): boolean => tab.status === "running" || tab.status === "requested"
const settled = (tab: Tab): boolean => tab.status === "done" || tab.status === "failed" || tab.status === "cancelled"
/** Refusal returned by agent.delegate at the maximum supported depth. */
export class AgentDepthExceeded extends Error {
  readonly _tag = "AgentDepthExceeded"
  readonly code = "depth_exceeded"
  constructor() { super("Maximum delegation depth is 3") }
}
const resetAt = (error: unknown): number | undefined => {
  let current = error
  const seen = new Set<unknown>()
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const value = current as { resetAtEpochMillis?: unknown; cause?: unknown }
    if (typeof value.resetAtEpochMillis === "number") return value.resetAtEpochMillis
    current = value.cause
  }
  return undefined
}
export class Workspace {
  private queue: Array<{ readonly id: string; readonly writer: Session.Writer; readonly history: ReadonlyArray<Context.Entry> }> = []
  private tabs = new Map<string, Tab>()
  private panels = new Map<string, Panels.Panel>()
  private transcripts = new Map<string, Transcript.Transcript>()
  private handles = new Map<string, Host.Turn>()
  private cancelRequested = new Set<string>()
  private listeners = new Set<() => void>()
  private closed = false
  constructor(
    private options: {
      host: Host.Host
      workerSeat: string
      history: () => ReadonlyArray<Context.Entry>
      persist: (record: Session.Record) => void
      restored?: Snapshot
    }
  ) {
    for (const saved of options.restored?.tabs ?? []) {
      // Older sessions predate recursive tabs.
      const tab = { ...saved, depth: saved.depth ?? (saved.id.split("/").length - 1) }
      let records: ReadonlyArray<Session.Record> = []
      let transcript: Transcript.Transcript | undefined
      try {
        records = Session.load(tab.file)
        transcript = Session.restore(records.filter((record) => record.type !== "event" || record.event._tag !== "aborted").map((record) => record.type === "outcome" && record.outcome._tag === "failed" && record.outcome.headline === undefined
          ? { ...record, outcome: { ...record.outcome, headline: FailureCopy.describe(record.outcome.message, tab.activeSeat ?? tab.seat).headline } }
          : record)).transcript
      } catch { /* A persisted request can precede creation of its worker file. */ }
      let settled = tab
      if (tab.status === "running" || tab.status === "requested" || tab.status === "waiting" || tab.status === "parked") {
        // Prefer the worker's own receipt if the process exited before the parent saved it.
        const receipt = records.findLast((record) => record.type === "outcome")
        const outcome = receipt?.type === "outcome" ? receipt.outcome : undefined
        settled = receipt === undefined || outcome === undefined
          ? tab
          : outcome._tag === "done"
          ? { ...tab, status: "done", answer: outcome.answer ?? "", endedAt: receipt.at }
          : outcome._tag === "cancelled"
          ? { ...tab, status: "cancelled", endedAt: receipt.at }
          : { ...tab, status: "failed", message: outcome.message ?? "Failed", failure: tab.failure ?? FailureCopy.describe(outcome.message, tab.activeSeat ?? tab.seat), endedAt: receipt.at }
      }
      // A worker whose host died has no outcome in its file; its timeline must not stay live.
      if (transcript !== undefined && settled.status === "failed" && transcript.activity?.status === "running") {
        transcript = Transcript.failure(
          transcript,
          settled.message ?? "Failed",
          settled.endedAt ?? Date.now()
        )
      }
      if (transcript !== undefined) this.transcripts.set(tab.id, transcript)
      if (settled === tab) this.tabs.set(tab.id, tab)
      else this.save(settled)
      if (settled.status === "queued") this.queue.push({ id: tab.id, writer: Session.reopen(tab.file), history: [] })
      if (settled === tab && (active(tab) || tab.status === "waiting" || tab.status === "parked")) this.scheduleResume(tab)
    }
    for (const panel of options.restored?.panels ?? []) Panels.keep(this.panels, panel)
    if (this.queue.length > 0) queueMicrotask(() => this.drain())
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
  snapshot = (): Snapshot => ({ tabs: [...this.tabs.values()], panels: [...this.panels.values()] })
  get busy(): boolean {
    return [...this.tabs.values()].some((tab) => active(tab) || tab.status === "queued" || tab.status === "parked")
  }
  private save(tab: Tab) {
    this.options.persist({ type: "tab", tab })
    this.tabs.set(tab.id, tab)
    this.changed()
    if (settled(tab) || tab.status === "parked") this.drain()
  }
  /** Starts queued requests, oldest first, while a seat is free. */
  private drain() {
    while (!this.closed && this.queue.length > 0 && [...this.tabs.values()].filter(active).length < seats) {
      const next = this.queue.shift()!
      const tab = this.tabs.get(next.id)
      if (tab?.status !== "queued" || tab.file !== next.writer.file) continue
      const requested: Tab = { ...tab, status: "requested" }
      this.save(requested)
      queueMicrotask(() => this.launch(requested, next.writer, next.history))
    }
  }
  /** Custom views kept; publishing one more replaces the least recently published. */
  static readonly maxPanels = Panels.limit
  publish = (value: Panels.Panel): void => {
    const panel = Panels.decode(value)
    this.options.persist({ type: "panel", panel })
    Panels.keep(this.panels, panel)
    this.changed()
  }
  request = (request: Request): { id: string; status: Tab["status"] } => this.open(request, this.seat(request))
  /** Namespaces a child under its parent and refuses delegation beyond depth three. */
  requestChild = (parent: Tab, request: Request): { id: string; status: Tab["status"] } => {
    if (parent.depth >= 3) throw new AgentDepthExceeded()
    return this.open({ ...request, id: `${parent.id}/${request.id}` }, this.seat(request), parent.id, parent.depth + 1)
  }
  /** A worker waits for its own children while its pool slot is available to queued work. */
  wait = (parentId: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<Pick<Tab, "id" | "status" | "answer" | "message">>> => {
    const parent = this.tabs.get(parentId)
    if (parent === undefined) throw new Error("Unknown parent tab")
    const children = ids.map((id) => {
      const child = this.tabs.get(id.startsWith(`${parentId}/`) ? id : `${parentId}/${id}`)
      if (child?.parent !== parentId) throw new Error(`Unknown child tab: ${id}`)
      return child.id
    })
    this.save({ ...parent, status: "waiting" })
    this.drain()
    return new Promise((resolve, reject) => {
      const check = () => {
        const current = this.tabs.get(parentId)
        if (this.closed || current === undefined || settled(current)) {
          unsubscribe()
          reject(new Error("Parent tab stopped while waiting"))
          return
        }
        const tabs = children.map((id) => this.tabs.get(id)!)
        if (!tabs.every(settled) || [...this.tabs.values()].filter(active).length >= seats) return
        unsubscribe()
        this.save({ ...this.tabs.get(parentId)!, status: "running" })
        resolve(tabs.map(({ id, status, answer, message }) => ({ id, status, answer, message })))
      }
      const unsubscribe = this.subscribe(check)
      check()
    })
  }
  private seat(request: Request): string {
    return request.model === undefined ? this.options.workerSeat : delegateModels[request.model]
  }
  private open(request: Request, seat: string, parent?: string, depth = 0, prior?: Tab): { id: string; status: Tab["status"] } {
    if (this.closed) throw new Error("Session closed")
    const existing = this.tabs.get(request.id)
    if (existing !== undefined) {
      if (existing.prompt !== request.prompt || existing.seat !== seat) throw new Error("Request id already belongs to another task")
      return { id: existing.id, status: existing.status }
    }
    const records = prior === undefined ? [] : this.priorRecords(prior)
    const writer = Session.create(this.options.host.cwd, "worker", prior === undefined ? {} : { parent: prior.file, seed: records })
    const { model: _model, ...task } = request
    const tab: Tab = {
      ...task,
      ...(parent === undefined ? {} : { parent }),
      depth,
      seat,
      file: writer.file,
      status: [...this.tabs.values()].filter(active).length >= seats ? "queued" : "requested",
      startedAt: prior?.startedAt ?? Date.now()
    }
    // Persist FIRST; a receipt here acknowledges only the request, not the launch.
    this.save(tab)
    void this.describe(tab)
    const history = [...this.options.history(), ...(prior === undefined ? [] : this.continuation(prior, records))]
    if (tab.status === "queued") this.queue.push({ id: tab.id, writer, history })
    else queueMicrotask(() => this.launch(tab, writer, history))
    return { id: tab.id, status: tab.status }
  }
  private priorRecords(tab: Tab): ReadonlyArray<Session.Record> {
    try { return Session.load(tab.file).filter((record) => record.type !== "session") }
    catch { return [] }
  }
  private continuation(tab: Tab, records: ReadonlyArray<Session.Record>): ReadonlyArray<Context.Entry> {
    const transcript = records.length === 0 ? this.transcript(tab.id) : Session.restore(records).transcript
    const worked = transcript.items.flatMap((item) => item.kind === "cell"
      ? [`Step ${item.index}: ${item.source}\n${item.printed}${item.error === undefined ? "" : `\n${item.error}`}`]
      : item.kind === "user" ? [`User: ${item.text}`] : item.kind === "error" ? [`Error: ${item.text}`] : [])
    const lastError = records.findLast((record) => record.type === "outcome")
    return [{ kind: "exchange", user: tab.prompt,
      answer: `Continue the same worker task from this prior run. Do not repeat completed steps.\n${worked.join("\n").slice(-24_000)}${lastError?.type === "outcome" && lastError.outcome.message !== undefined ? `\nLast error: ${lastError.outcome.message}` : ""}` }]
  }
  private relaunch(tab: Tab): void {
    if (this.closed) return
    this.tabs.delete(tab.id)
    this.open({ id: tab.id, title: tab.title, prompt: tab.prompt }, tab.seat, tab.parent, tab.depth, tab)
  }
  private scheduleResume(tab: Tab): void {
    const resume = () => {
      if (!this.closed && this.tabs.get(tab.id)?.file === tab.file &&
        (this.tabs.get(tab.id)?.status === "parked" || this.tabs.get(tab.id)?.status === "running" ||
          this.tabs.get(tab.id)?.status === "requested" || this.tabs.get(tab.id)?.status === "waiting")) this.relaunch(tab)
    }
    if (tab.status === "parked" && (tab.wakeAt ?? 0) > Date.now()) setTimeout(resume, tab.wakeAt! - Date.now())
    else queueMicrotask(resume)
  }
  private async describe(tab: Tab): Promise<void> {
    let description = tab.title.replace(/\s+/g, " ").trim().slice(0, 80)
    // The worker's own seat: the task never goes to a provider the user did not pick for it.
    if (!tab.seat.startsWith("replay:")) {
      try {
        const generated = await this.options.host.describe?.({ title: tab.title, prompt: tab.prompt, seat: tab.seat })
        description = generated?.replace(/\s+/g, " ").trim().slice(0, 80) || description
      } catch { /* Keep the title when the seat cannot describe it. */ }
    }
    const current = this.tabs.get(tab.id)
    if (current === undefined || current.file !== tab.file || this.closed) return
    this.save({ ...current, description })
  }
  private launch(tab: Tab, writer: Session.Writer, history: ReadonlyArray<Context.Entry>) {
    if (this.closed || this.tabs.get(tab.id)?.status !== "requested") return
    const at = Date.now()
    let transcript = Transcript.user(this.transcripts.get(tab.id) ?? Transcript.empty, tab.prompt, false, at)
    this.transcripts.set(tab.id, transcript)
    try {
      writer.append({ type: "user", at, text: tab.prompt })
      const handle = this.options.host.run({
        prompt: tab.prompt,
        seat: tab.seat,
        source: tab.id,
        history,
        role: "worker",
        runtime: {
          publish: (panel) => this.publish({ ...panel, id: `${tab.id}/${panel.id}` }),
          delegate: (request) => this.requestChild(tab, request),
          read: (id) => this.read(id.startsWith(`${tab.id}/`) ? id : `${tab.id}/${id}`),
          list: () => this.snapshot().tabs.filter((child) => child.parent === tab.id),
          wait: (ids) => this.wait(tab.id, ids)
        },
        onCaption: (prose) => {
          writer.append({ type: "caption", prose })
          transcript = Transcript.caption(transcript, prose)
          this.transcripts.set(tab.id, transcript)
          this.changed()
        },
        onPatch: (receipt) => {
          writer.append({ type: "patch", receipt })
          transcript = Transcript.patched(transcript, receipt)
          this.transcripts.set(tab.id, transcript)
          this.changed()
        },
        onEvent: (event) => {
          const at = Date.now()
          if (event._tag !== "model-delta" && event._tag !== "aborted") writer.append({ type: "event", at, event })
          if (event._tag !== "aborted") transcript = Transcript.apply(transcript, event, at)
          this.transcripts.set(tab.id, transcript)
          if (event._tag === "seat-failed-over") this.save({ ...(this.tabs.get(tab.id) ?? tab), activeSeat: event.to })
          if (event._tag === "model-parked") this.save({ ...(this.tabs.get(tab.id) ?? tab), status: "parked", wakeAt: event.wakeAt, activeSeat: event.seat })
          if (event._tag === "model-unparked") this.save({ ...(this.tabs.get(tab.id) ?? tab), status: "running", wakeAt: undefined, activeSeat: event.seat })
          this.changed()
        }
      })
      this.handles.set(tab.id, handle)
      this.save({ ...(this.tabs.get(tab.id) ?? tab), status: this.tabs.get(tab.id)?.status === "parked" ? "parked" : "running", launchedAt: at })
      void handle.done.then((outcome) => {
        this.handles.delete(tab.id)
        const requestedCancel = this.cancelRequested.delete(tab.id)
        if (this.closed || this.tabs.get(tab.id)?.file !== writer.file) return
        const current = this.tabs.get(tab.id)
        if (outcome._tag === "cancelled" && current?.status === "parked" && !requestedCancel) {
          this.scheduleResume(current)
          return
        }
        const at = Date.now()
        const failure = outcome._tag === "failed" ? FailureCopy.describe(outcome.error ?? outcome.message, this.tabs.get(tab.id)?.activeSeat ?? tab.seat) : undefined
        writer.append({ type: "outcome", at, prompt: tab.prompt,
          outcome: outcome._tag === "done"
            ? { _tag: "done", answer: outcome.answer }
            : outcome._tag === "failed"
            ? { _tag: "failed", message: outcome.message, headline: failure!.headline }
            : { _tag: "cancelled" } })
        if (outcome._tag !== "done") {
          transcript = Transcript.failure(transcript, outcome._tag === "failed" ? failure!.headline : "Stopped", at)
          this.transcripts.set(tab.id, transcript)
        }
        this.save({
          ...(this.tabs.get(tab.id) ?? tab),
          status: outcome._tag,
          endedAt: at,
          ...(outcome._tag === "done"
            ? { answer: outcome.answer }
            : outcome._tag === "failed"
            ? { message: outcome.message, detail: outcome.detail, failure, wakeAt: resetAt(outcome.error) }
            : {})
        })
      }).catch((error) => this.fail(tab, writer, error))
    } catch (error) {
      this.fail(tab, writer, error)
    }
  }
  /** Settles the tab, its timeline and its worker file as failed. */
  private fail(tab: Tab, writer: Session.Writer, error: unknown) {
    this.handles.delete(tab.id)
    const at = Date.now()
    const message = String(error)
    const failure = FailureCopy.describe(error, this.tabs.get(tab.id)?.activeSeat ?? tab.seat)
    try {
      writer.append({ type: "outcome", at, prompt: tab.prompt, outcome: { _tag: "failed", message, headline: failure.headline } })
    } catch { /* The tab row still settles when the worker file cannot be written. */ }
    this.transcripts.set(tab.id, Transcript.failure(this.transcript(tab.id), failure.headline, at))
    this.save({ ...(this.tabs.get(tab.id) ?? tab), status: "failed", endedAt: at, message, failure, detail: error instanceof Error ? error.stack : undefined })
  }
  /** Records an undo of a tab's calls in its own file and transcript. */
  undone = (id: string, calls: ReadonlyArray<string>, paths: ReadonlyArray<string>, at: number): void => {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error("Unknown tab")
    Session.reopen(tab.file).append({ type: "undo", at, calls, paths })
    this.transcripts.set(id, Transcript.undone(this.transcript(id), calls, paths, at))
    this.changed()
  }
  /** A worker's own transcript, for the chat timeline to interleave. */
  transcript = (id: string): Transcript.Transcript => this.transcripts.get(id) ?? Transcript.empty
  read = (id: string) => {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error("Unknown tab")
    const panel = this.panel(id)
    return {
      id: tab.id,
      title: tab.title,
      status: tab.status,
      answer: tab.answer?.slice(0, 8000),
      message: tab.message,
      summary: panel.summary,
      turns: panel.rows.slice(-8).map((row) => ({
        label: row.label,
        status: row.status,
        details: row.details.slice(0, 4).map((block) =>
          block.kind === "code"
            ? { ...block, code: block.code.slice(0, 4000) }
            : block.kind === "text"
            ? { ...block, text: block.text.slice(0, 4000) }
            : block.kind === "diff"
            ? { ...block, patch: block.patch.slice(0, 4000) }
            : { ...block, rows: block.rows.slice(0, 10) }
        )
      }))
    }
  }
  panel = (id: string): Panels.Panel => {
    const tab = this.tabs.get(id)
    const panel = Summary.panel(this.transcripts.get(id) ?? Transcript.empty, `tab:${id}`, tab?.title ?? id)
    const summary = (tab?.status === "failed" ? tab.failure?.headline ?? "Worker stopped unexpectedly" : undefined) ??
      (tab?.status === "done"
        ? Summary.sentence(tab.answer ?? panel.summary)
        : tab?.status === "requested"
        ? "Requested."
        : tab?.status === "queued"
        ? "Queued."
        : tab?.status === "parked"
        ? `waits for ${seatProvider(tab.activeSeat ?? tab.seat)} reset · ${new Date(tab.wakeAt ?? Date.now()).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`
        : tab?.status === "cancelled"
        ? "Stopped."
        : panel.summary)
    return { ...panel, summary }
  }
  /** Projects a root and descendants from current tab state. */
  tree = (rootId: string): Panels.Panel => Tree.panel(rootId, [...this.tabs.values()], (id) => this.transcript(id))
  /**
   * What every coordinator turn is told about the tabs: every unsettled tab,
   * and the newest settled ones with a bounded answer. Older tabs keep only
   * their status; `tab.read` returns any tab in full.
   */
  context = (): string => {
    const settledTabs = [...this.tabs.values()].filter(settled).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const recent = new Set(settledTabs.slice(0, contextAnswers))
    return JSON.stringify(
      [...this.tabs.values()].map((tab) => {
        const full = !settled(tab) || recent.has(tab)
        return {
          id: tab.id,
          title: tab.title,
          status: tab.status,
          ...(full && tab.answer !== undefined ? { answer: tab.answer.slice(0, contextAnswerChars) } : {}),
          ...(full && tab.message !== undefined ? { message: tab.message.slice(0, 500) } : {})
        }
      })
    )
  }
  cancel = (id: string): void => {
    const tab = this.tabs.get(id)
    if (tab?.status === "requested" || tab?.status === "queued" || (tab?.status === "parked" && !this.handles.has(id))) {
      this.save({ ...tab, status: "cancelled", endedAt: Date.now() })
    }
    else if (this.handles.has(id)) {
      this.cancelRequested.add(id)
      this.handles.get(id)!.cancel()
    }
  }
  /** Runs a failed or stopped tab's task again, on the seat it asked for. */
  retry = (id: string, seat?: string): { id: string; status: Tab["status"] } => {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error("Unknown tab")
    if (tab.status !== "failed" && tab.status !== "cancelled") throw new Error(`Only a failed or stopped tab can be retried; ${id} is ${tab.status}`)
    this.tabs.delete(id)
    return this.open({ id, title: tab.title, prompt: tab.prompt }, seat ?? tab.seat, tab.parent, tab.depth, tab)
  }
  /** Parks a failed worker until its known reset, then continues the same task. */
  waitForReset = (id: string): void => {
    const tab = this.tabs.get(id)
    if (tab?.status !== "failed") throw new Error("Only a failed tab can wait")
    const wakeAt = Math.max(Date.now(), tab.wakeAt ?? Date.now() + 15 * 60_000)
    this.save({ ...tab, status: "parked", wakeAt, endedAt: undefined })
    setTimeout(() => {
      if (this.tabs.get(id)?.status === "parked" && this.tabs.get(id)?.file === tab.file) this.relaunch(tab)
    }, wakeAt - Date.now())
  }
  dispose = (): void => {
    this.closed = true
    for (const [id, tab] of this.tabs) {
      if (tab.status === "queued") this.save({ ...tab, status: "cancelled", endedAt: Date.now() })
      this.handles.get(id)?.cancel()
    }
  }
}
/** A tab's toast text after its glyph. */
const seatProvider = (seat: string): string => seat.startsWith("openai:") ? "ChatGPT" :
  seat.startsWith("anthropic:") ? "Anthropic" : seat.split(":")[0] ?? "model"

export const tabToast = (tab: Tab): string =>
  `${tab.title} · ${
    tab.status === "failed" ? tab.failure?.headline ?? "Worker stopped unexpectedly" :
    tab.status === "parked" ? `waits for ${seatProvider(tab.activeSeat ?? tab.seat)} reset · ${new Date(tab.wakeAt ?? Date.now()).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}` : tab.status
  }`

/** The failure card's single progress and file-impact line. */
export const failureLine = (tab: Tab, transcript: Transcript.Transcript): string => {
  const steps = transcript.items.filter((item) => item.kind === "cell" && item.status !== "writing").length
  const changed = transcript.items.some((item) => item.kind === "cell" && item.calls.some((call) =>
    (call.patches?.length ?? 0) > 0 && call.undone !== true))
  const prefix = tab.failure?.line ?? "The worker stopped before finishing."
  return `${prefix} ${steps} of ~40 steps done. ${changed ? "Files changed." : "No files changed."}`
}
