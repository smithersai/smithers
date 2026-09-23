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
  readonly status: "requested" | "running" | "done" | "failed" | "cancelled"
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
export class Workspace {
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
      try {
        records = Session.load(tab.file)
        this.transcripts.set(tab.id, Session.restore(records).transcript)
      } catch { /* A persisted request can precede creation of its worker file. */ }
      if (tab.status === "running" || tab.status === "requested") {
        // Prefer a real worker completion receipt if the process exited before the parent saved it.
        const receipt = records.findLast((record) => record.type === "outcome")
        const recovered: Tab = receipt?.type === "outcome" && receipt.outcome._tag === "done"
          ? { ...tab, status: "done", answer: receipt.outcome.answer ?? "", endedAt: receipt.at }
          : { ...tab, status: "failed", message: "Interrupted; retry to continue.", endedAt: Date.now() }
        this.save(recovered)
      } else this.tabs.set(tab.id, tab)
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
    return [...this.tabs.values()].some((tab) => tab.status === "running" || tab.status === "requested")
  }
  private save(tab: Tab) {
    this.options.persist({ type: "tab", tab })
    this.tabs.set(tab.id, tab)
    this.changed()
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
  request = (request: Request): { id: string; status: Tab["status"] } => {
    if (this.closed) throw new Error("Session closed")
    const existing = this.tabs.get(request.id)
    if (existing !== undefined) {
      if (existing.prompt !== request.prompt || existing.seat !== (request.model === undefined
        ? this.options.workerSeat
        : delegateModels[request.model])) throw new Error("Request id already belongs to another task")
      return { id: existing.id, status: existing.status }
    }
    if ([...this.tabs.values()].filter((tab) => tab.status === "running" || tab.status === "requested").length >= 3) {
      throw new Error("Three workers are active; wait for a completion")
    }
    const writer = Session.create(this.options.host.cwd, "worker")
    const tab: Tab = {
      ...request,
      seat: request.model === undefined ? this.options.workerSeat : delegateModels[request.model],
      file: writer.file,
      status: "requested",
      startedAt: Date.now()
    }
    // Persist FIRST; a receipt here acknowledges only the request, not the launch.
    this.save(tab)
    void this.describe(tab)
    const history = [...this.options.history()]
    queueMicrotask(() => this.launch(tab, writer, history))
    return { id: tab.id, status: "requested" }
  }
  private async describe(tab: Tab): Promise<void> {
    let description = tab.title.replace(/\s+/g, " ").trim().slice(0, 80)
    try {
      const generated = await this.options.host.describe?.({ title: tab.title, prompt: tab.prompt, model: "luna" })
      description = generated?.replace(/\s+/g, " ").trim().slice(0, 80) || description
    } catch { /* Keep the title when Luna is unavailable. */ }
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
      }).catch((error) => this.save({ ...(this.tabs.get(tab.id) ?? tab), status: "failed", endedAt: Date.now(), message: String(error) }))
    } catch (error) {
      this.save({ ...(this.tabs.get(tab.id) ?? tab), status: "failed", endedAt: Date.now(), message: String(error) })
    }
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
        : tab?.status === "cancelled"
        ? "Stopped."
        : panel.summary)
    return { ...panel, summary }
  }
  context = (): string =>
    JSON.stringify(
      [...this.tabs.values()].map(({ id, title, status, answer, message }) => ({
        id,
        title,
        status,
        answer: answer?.slice(0, 6000),
        message
      }))
    )
  cancel = (id: string): void => {
    const tab = this.tabs.get(id)
    if (tab?.status === "requested") this.save({ ...tab, status: "cancelled", endedAt: Date.now() })
    else this.handles.get(id)?.cancel()
  }
  retry = (id: string): void => {
    const tab = this.tabs.get(id)
    if (tab === undefined || (tab.status !== "failed" && tab.status !== "cancelled")) return
    if ([...this.tabs.values()].filter((row) => row.status === "running" || row.status === "requested").length >= 3) {
      throw new Error("Three workers are active")
    }
    this.tabs.delete(id)
    this.request({ id, title: tab.title, prompt: tab.prompt })
  }
  dispose = (): void => {
    this.closed = true
    for (const id of this.tabs.keys()) this.cancel(id)
  }
}
