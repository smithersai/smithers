/** Background work outlives a chat turn. Each tab has its own durable transcript. */
import type * as Context from "./context.ts"
import type * as Host from "./host.ts"
import { delegateModels, type DelegateModel } from "./models.ts"
import * as Panels from "./panels.ts"
import * as Session from "./session.ts"
import * as Summary from "./summary.ts"
import * as Transcript from "./transcript.ts"

export interface Tab {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly prompt: string
  readonly seat: string
  readonly file: string
  readonly status: "queued" | "requested" | "running" | "done" | "failed" | "cancelled"
  readonly startedAt: number
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
export const seats = 3
const active = (tab: Tab): boolean => tab.status === "running" || tab.status === "requested"
const settled = (tab: Tab): boolean => tab.status === "done" || tab.status === "failed" || tab.status === "cancelled"
export class Workspace {
  private queue: Array<{ readonly id: string; readonly writer: Session.Writer; readonly history: ReadonlyArray<Context.Entry> }> = []
  private tabs = new Map<string, Tab>()
  private panels = new Map<string, Panels.Panel>()
  private transcripts = new Map<string, Transcript.Transcript>()
  private handles = new Map<string, Host.Turn>()
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
    for (const tab of options.restored?.tabs ?? []) {
      let records: ReadonlyArray<Session.Record> = []
      let transcript: Transcript.Transcript | undefined
      try {
        records = Session.load(tab.file)
        transcript = Session.restore(records).transcript
      } catch { /* A persisted request can precede creation of its worker file. */ }
      let settled = tab
      if (tab.status === "running" || tab.status === "requested" || tab.status === "queued") {
        // Prefer the worker's own receipt if the process exited before the parent saved it.
        const receipt = records.findLast((record) => record.type === "outcome")
        const outcome = receipt?.type === "outcome" ? receipt.outcome : undefined
        settled = receipt === undefined || outcome === undefined
          ? { ...tab, status: "failed", message: "Interrupted; retry to continue.", endedAt: Date.now() }
          : outcome._tag === "done"
          ? { ...tab, status: "done", answer: outcome.answer ?? "", endedAt: receipt.at }
          : outcome._tag === "cancelled"
          ? { ...tab, status: "cancelled", endedAt: receipt.at }
          : { ...tab, status: "failed", message: outcome.message ?? "Failed", endedAt: receipt.at }
      }
      // A worker whose host died has no outcome in its file; its timeline must not stay live.
      if (transcript !== undefined && settled.status !== "done" && transcript.activity?.status === "running") {
        transcript = Transcript.failure(
          transcript,
          settled.status === "cancelled" ? "Stopped" : settled.message ?? "Failed",
          settled.endedAt ?? Date.now()
        )
      }
      if (transcript !== undefined) this.transcripts.set(tab.id, transcript)
      if (settled === tab) this.tabs.set(tab.id, tab)
      else this.save(settled)
    }
    for (const panel of options.restored?.panels ?? []) this.panels.set(panel.id, panel)
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
    return [...this.tabs.values()].some((tab) => active(tab) || tab.status === "queued")
  }
  private save(tab: Tab) {
    this.options.persist({ type: "tab", tab })
    this.tabs.set(tab.id, tab)
    this.changed()
    if (settled(tab)) this.drain()
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
  publish = (value: Panels.Panel): void => {
    const panel = Panels.decode(value)
    if (!this.panels.has(panel.id) && this.panels.size >= 24) {
      throw new Error("Limit of 24 views reached; reuse an existing panel id")
    }
    this.options.persist({ type: "panel", panel })
    this.panels.set(panel.id, panel)
    this.changed()
  }
  request = (request: Request): { id: string; status: Tab["status"] } => this.open(request, this.seat(request))
  private seat(request: Request): string {
    return request.model === undefined ? this.options.workerSeat : delegateModels[request.model]
  }
  private open(request: Request, seat: string): { id: string; status: Tab["status"] } {
    if (this.closed) throw new Error("Session closed")
    const existing = this.tabs.get(request.id)
    if (existing !== undefined) {
      if (existing.prompt !== request.prompt || existing.seat !== seat) throw new Error("Request id already belongs to another task")
      return { id: existing.id, status: existing.status }
    }
    const writer = Session.create(this.options.host.cwd, "worker")
    const { model: _model, ...task } = request
    const tab: Tab = {
      ...task,
      seat,
      file: writer.file,
      status: [...this.tabs.values()].filter(active).length >= seats ? "queued" : "requested",
      startedAt: Date.now()
    }
    // Persist FIRST; a receipt here acknowledges only the request, not the launch.
    this.save(tab)
    void this.describe(tab)
    const history = [...this.options.history()]
    if (tab.status === "queued") this.queue.push({ id: tab.id, writer, history })
    else queueMicrotask(() => this.launch(tab, writer, history))
    return { id: tab.id, status: tab.status }
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
    let transcript = Transcript.user(Transcript.empty, tab.prompt, false, at)
    this.transcripts.set(tab.id, transcript)
    try {
      writer.append({ type: "user", at, text: tab.prompt })
      const handle = this.options.host.run({
        prompt: tab.prompt,
        seat: tab.seat,
        source: tab.id,
        history,
        role: "worker",
        runtime: { publish: (panel) => this.publish({ ...panel, id: `${tab.id}/${panel.id}` }) },
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
          if (event._tag !== "model-delta") writer.append({ type: "event", at, event })
          transcript = Transcript.apply(transcript, event, at)
          this.transcripts.set(tab.id, transcript)
          this.changed()
        }
      })
      this.handles.set(tab.id, handle)
      this.save({ ...(this.tabs.get(tab.id) ?? tab), status: "running" })
      void handle.done.then((outcome) => {
        this.handles.delete(tab.id)
        const at = Date.now()
        writer.append({ type: "outcome", at, prompt: tab.prompt, outcome })
        if (outcome._tag !== "done") {
          transcript = Transcript.failure(transcript, outcome._tag === "failed" ? outcome.message : "Stopped", at)
          this.transcripts.set(tab.id, transcript)
        }
        this.save({
          ...(this.tabs.get(tab.id) ?? tab),
          status: outcome._tag,
          endedAt: at,
          ...(outcome._tag === "done"
            ? { answer: outcome.answer }
            : outcome._tag === "failed"
            ? { message: outcome.message }
            : {})
        })
      }).catch((error) => this.fail(tab, writer, String(error)))
    } catch (error) {
      this.fail(tab, writer, String(error))
    }
  }
  /** Settles the tab, its timeline and its worker file as failed. */
  private fail(tab: Tab, writer: Session.Writer, message: string) {
    this.handles.delete(tab.id)
    const at = Date.now()
    try {
      writer.append({ type: "outcome", at, prompt: tab.prompt, outcome: { _tag: "failed", message } })
    } catch { /* The tab row still settles when the worker file cannot be written. */ }
    this.transcripts.set(tab.id, Transcript.failure(this.transcript(tab.id), message, at))
    this.save({ ...(this.tabs.get(tab.id) ?? tab), status: "failed", endedAt: at, message })
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
    const summary = tab?.message ??
      (tab?.status === "done"
        ? Summary.sentence(tab.answer ?? panel.summary)
        : tab?.status === "requested"
        ? "Requested."
        : tab?.status === "queued"
        ? "Queued."
        : tab?.status === "cancelled"
        ? "Stopped."
        : panel.summary)
    return { ...panel, summary }
  }
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
    if (tab?.status === "requested" || tab?.status === "queued") this.save({ ...tab, status: "cancelled", endedAt: Date.now() })
    else this.handles.get(id)?.cancel()
  }
  /** Runs a failed or stopped tab's task again, on the seat it asked for. */
  retry = (id: string): { id: string; status: Tab["status"] } => {
    const tab = this.tabs.get(id)
    if (tab === undefined) throw new Error("Unknown tab")
    if (tab.status !== "failed" && tab.status !== "cancelled") throw new Error(`Only a failed or stopped tab can be retried; ${id} is ${tab.status}`)
    this.tabs.delete(id)
    return this.open({ id, title: tab.title, prompt: tab.prompt }, tab.seat)
  }
  dispose = (): void => {
    this.closed = true
    for (const id of this.tabs.keys()) this.cancel(id)
  }
}
/** A tab's toast text after its glyph. */
export const tabToast = (tab: Tab): string =>
  `${tab.title} · ${
    tab.status === "failed" && tab.message !== undefined ? tab.message.split("\n")[0]!.slice(0, 80) : tab.status
  }`
