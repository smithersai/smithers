import * as Log from "./log.ts"
/**
 * The terminal UI: a transcript of cells above a composer.
 *
 * Keys and commands follow pi (`badlogic/pi-mono` coding-agent) wherever the
 * cell harness has the same idea; `editor.ts` lists them. `view.tsx` draws.
 */
import type { KeyBinding, KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Agents from "./agents.ts"
import * as Approvals from "./approvals.ts"
import * as Clipboard from "./clipboard.ts"
import * as Complete from "./complete.ts"
import * as DragScroll from "./drag-scroll.ts"
import * as Context from "./context.ts"
import * as Contributions from "./contributions.ts"
import * as Extension from "./extension.ts"
import * as Editor from "./editor.ts"
import * as Estimate from "./estimate.ts"
import * as External from "./external.ts"
import * as Files from "./files.ts"
import { FlowRuns, type Listed, type Port as FlowPort, type Run, running as flowRunning } from "./flows.ts"
import * as Form from "./form.ts"
import * as Fuzzy from "./fuzzy.ts"
import * as Monitors from "./monitors.ts"
import * as Improve from "./improve.ts"
import type * as Host from "./host.ts"
import * as Keys from "./keys.ts"
import * as Models from "./models.ts"
import { FailureCard, PanelView } from "./panel-view.tsx"
import * as Palette from "./palette.ts"
import * as Panels from "./panels.ts"
import * as Search from "./search.ts"
import * as Session from "./session.ts"
import * as Shell from "./shell.ts"
import * as Steering from "./steering.ts"
import * as Smithers from "./smithers.ts"
import * as Summary from "./summary.ts"
import { activeTheme, color, isTheme, lane, loadTheme, saveTheme, setTheme, spinner, themes } from "./theme.ts"
import * as Timeline from "./timeline.ts"
import * as Activity from "./activity.ts"
import { ActivityView } from "./activity-view.tsx"
import * as Scrubber from "./scrubber.ts"
import * as Transcript from "./transcript.ts"
import * as Undo from "./undo.ts"
import * as View from "./view.tsx"
import * as Watch from "./watch.ts"
import { seats, type Snapshot, type Tab, tabToast, Workspace } from "./workspace.ts"

const composerKeys: Array<KeyBinding> = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" }
]

/** The transcript and composer never grow wider than this, like the app's chat column. */
const columnWidth = 120
/** Completion rows shown at once. */
const menuRows = 8

export interface AppProps {
  readonly host: Host.Host
  readonly seat: string
  readonly workerSeat?: string
  readonly models: ReadonlyArray<Models.Model>
  /** Resolves a custom agent's `model:`; default `Models.seatOf` over `models`. Replay pins every seat. */
  readonly seatOf?: (declared: string) => string | undefined
  readonly contextWindow: (seat: string) => number
  /** A session file to continue, or undefined for a new one. */
  readonly resume?: string
  /** Open the session picker at start (`--resume`). */
  readonly pickSession?: boolean
  readonly branch?: string
  /** The directory's file flows; absent where flows cannot run. */
  readonly flows?: FlowPort
}

interface TurnState {
  readonly handle: Host.Turn
  readonly startedAt: number
  readonly steering: Steering.Queue
  /** The turn's id in the estimate ledger. */
  readonly estimate: string
}

type Picker =
  | { readonly kind: "model"; readonly query: string; readonly selected: number }
  | { readonly kind: "worker-model"; readonly id: string; readonly query: string; readonly selected: number }
  | { readonly kind: "theme"; readonly query: string; readonly selected: number }
  | { readonly kind: "flows"; readonly query: string; readonly selected: number }
  | { readonly kind: "agents"; readonly query: string; readonly selected: number }
  | { readonly kind: "filter"; readonly query: string; readonly selected: number }
  | {
    readonly kind: "resume"
    readonly query: string
    readonly selected: number
    readonly sessions: ReadonlyArray<Session.Summary>
  }
  | {
    readonly kind: "palette"
    readonly query: string
    readonly selected: number
    /** Read on the first `session:`; undefined until then. */
    readonly sessions?: ReadonlyArray<Session.Summary>
  }
  | {
    readonly kind: "fork"
    readonly query: string
    readonly selected: number
    readonly turns: ReadonlyArray<Session.Turn>
  }
  | { readonly kind: "undo"; readonly query: ""; readonly selected: number; readonly target: Undo.Target; readonly tab?: string }

/** A `text:` search in the palette, from launch through its real settlement. */
interface TextSearch {
  readonly query: string
  readonly startedAt: number
  readonly status: "running" | "done"
  readonly hits: ReadonlyArray<Search.Hit>
  /** rg stopped at `Search.limit`. */
  readonly truncated: boolean
}

/** A flow run's inline form for its missing input. */
interface FlowForm {
  readonly id: string
  readonly flow: string
  readonly fields: ReadonlyArray<Form.Field>
  readonly draft: Record<string, Form.Value>
  readonly focus: number
  readonly error?: string
}

/** A tab's name; an agent's tab leads with the agent. */
const tabTitle = (tab: Tab): string => (tab.agent === undefined ? tab.title : `${tab.agent.name}: ${tab.title}`)

const flowGlyph = (status: Run["status"]): string =>
  status === "done" ? "✓ " : status === "failed" ? "✗ " : status === "cancelled" ? "■ " : status === "queued" ? "… " : "◌ "

interface Toast {
  readonly text: string
  readonly tone: "info" | "warning" | "danger"
}

/** A dialog's rows and the value each one picks. */
const pickerRows = (
  picker: Picker,
  models: ReadonlyArray<Models.Model>,
  seat: string,
  filter: Timeline.Filter,
  tabs: ReadonlyArray<Tab>,
  files: () => ReadonlyArray<string>,
  hits: ReadonlyArray<Search.Hit>,
  flows: ReadonlyArray<Listed>,
  actions: NonNullable<Palette.Sources["actions"]> = []
): ReadonlyArray<View.Row & { readonly value: string }> => {
  if (picker.kind === "agents") {
    return Fuzzy.filter(flows.filter(Extension.isAgent), picker.query, (agent) => agent.name).map((agent) => {
      const declared = agent.seat === undefined ? undefined : Models.seatOf(agent.seat, models)
      return {
        key: agent.name,
        label: agent.name,
        hint: declared === undefined ? agent.seat ?? "" : Models.labelOf(declared, models),
        detail: agent.description,
        value: agent.name
      }
    })
  }
  if (picker.kind === "flows") {
    return Fuzzy.filter(flows, picker.query, (flow) => flow.name).map((flow) => ({
      key: flow.name,
      label: flow.name,
      detail: flow.description,
      value: flow.name
    }))
  }
  if (picker.kind === "palette") {
    const sources = { commands: Editor.commands, files, sessions: picker.sessions, tabs, hits, now: Date.now(), actions }
    // The value is the JSON of a `Palette.Value`, so every dialog picks a string.
    return Palette.rows(Palette.parse(picker.query), sources).map((row) => ({ ...row, value: JSON.stringify(row.value) }))
  }
  if (picker.kind === "filter") {
    const rows = [
      { key: "source:chat", label: "Chat", current: !filter.sources.includes(Timeline.chat), value: `source:${Timeline.chat}` },
      ...tabs.map((tab) => ({
        key: `source:${tab.id}`,
        label: `↳ ${tab.title}`,
        hint: tab.status,
        current: !filter.sources.includes(tab.id),
        value: `source:${tab.id}`
      })),
      ...Timeline.kinds.map(([kind, label]) => ({
        key: `kind:${kind}`,
        label,
        current: !filter.kinds.includes(kind),
        value: `kind:${kind}`
      }))
    ]
    return [
      // Always first, so toggling never moves the selected row.
      { key: "all", label: "Show all", value: "all" },
      ...Fuzzy.filter(rows, picker.query, (row) => row.label)
    ]
  }
  if (picker.kind === "theme") return Fuzzy.filter(Object.keys(themes), picker.query, (name) => name).map((name) => ({
    key: name, label: name, current: name === activeTheme(), value: name
  }))
  if (picker.kind === "model" || picker.kind === "worker-model") {
    const listed = Fuzzy.filter(models, picker.query, (model) => `${model.label} ${model.seat} ${model.provider}`)
    const custom = picker.query.includes(":") && !models.some((model) => model.seat === picker.query)
    return [
      ...(custom ? [{ key: picker.query, label: picker.query, hint: "any seat", value: picker.query }] : []),
      ...listed.map((model) => ({
        key: model.seat,
        label: model.label,
        hint: model.provider,
        detail: model.seat,
        current: model.seat === seat,
        value: model.seat
      }))
    ]
  }
  if (picker.kind === "undo") {
    return [{ key: "undo", label: "Undo", value: "undo" }, { key: "cancel", label: "Cancel", value: "cancel" }]
  }
  if (picker.kind === "fork") {
    const now = Date.now()
    return Fuzzy.filter(picker.turns, picker.query, (turn) => turn.text).map((turn) => ({
      key: String(turn.index),
      label: turn.text.split("\n")[0]!.slice(0, 60),
      detail: View.ago(turn.at, now),
      value: String(turn.index)
    }))
  }
  return Palette.sessionRows(picker.sessions, picker.query, Date.now()).map(({ file, ...row }) => ({ ...row, value: file }))
}

export function App(props: AppProps) {
  const renderer = useRenderer()
  const [, refreshTheme] = useState(0)
  useState(() => setTheme(loadTheme()))
  const [restored] = useState((): {
    current: ReturnType<typeof Session.restore> | undefined
    file: string | undefined
    damaged?: string
  } => {
    if (props.resume === undefined) return { current: undefined, file: undefined }
    try {
      return { current: Session.restore(Session.load(props.resume)), file: props.resume }
    } catch (error) {
      return { current: undefined, file: undefined, damaged: Session.quarantine(props.resume, error) }
    }
  })
  const [transcript, setTranscript] = useState(restored.current?.transcript ?? Transcript.empty)
  const [compact, setCompact] = useState<number | undefined>()
  const [seat, setSeat] = useState(props.seat)
  const [thinking, setThinking] = useState<Editor.Thinking>(undefined)
  const [turn, setTurn] = useState<TurnState | undefined>()
  const [shell, setShell] = useState<Shell.Running | undefined>()
  /** When an undo started; set from the confirm until its real settlement. */
  const [undoing, setUndoing] = useState<number | undefined>()
  const [followUps, setFollowUps] = useState<ReadonlyArray<string>>([])
  const [picker, setPicker] = useState<Picker | undefined>(
    props.pickSession === true
      ? { kind: "resume", query: "", selected: 0, sessions: Session.list(props.host.cwd) }
      : undefined
  )
  const [expanded, setExpanded] = useState(false)
  const [toast, setToast] = useState<Toast | undefined>()
  const [search, setSearch] = useState<TextSearch | undefined>()
  const searchGeneration = useRef(0)
  const [draft, setDraft] = useState("")
  const [cursor, setCursor] = useState(0)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const [name, setName] = useState(restored.current?.name)
  const [now, setNow] = useState(Date.now())
  const [approvals, setApprovals] = useState<ReadonlyArray<Approvals.Pending>>([])
  // Answered but maybe still listed: a poll can land before the store drops it.
  const answered = useRef(new Set<string>())
  // When the front row starts taking y, n and a; see `Approvals.Arming`.
  const arming = useRef(Approvals.idle)
  const entries = useRef<Array<Context.Entry>>(restored.current?.entries ?? [])
  const history = useRef(new Editor.History(restored.current?.prompts ?? []))
  // A record the disk refused never stops the screen: the row says what went unsaved.
  const unsaved = useCallback((failure: Session.WriteFailed) => {
    const text = `Session not saved: ${failure.message}`
    setToast({ text, tone: "danger" })
    setTranscript((current) => Transcript.alert(current, text, Date.now()))
  }, [])
  const writer = useRef<Session.Writer>(
    Session.guarded(restored.file === undefined ? Session.create(props.host.cwd) : Session.reopen(restored.file), unsaved)
  )
  /** Status items, keys and plugin panels from every owner; runtime panels stay in the workspace. */
  const [contributions] = useState(() => {
    const store = new Contributions.Store({ taken: Keys.taken })
    for (const each of restored.current?.contributions ?? []) {
      try { store.runtime(each.owner, each.contribution) } catch { /* A key a newer built-in took stays off. */ }
    }
    return store
  })
  /** A cell's status item or key: shown, then persisted; a refusal reaches the cell instead. */
  const contribute = useCallback((owner: string, contribution: Extension.Contribution) => {
    contributions.runtime(owner, contribution)
    if (contribution.kind !== "panel") writer.current.append({ type: "contribution", owner, contribution })
  }, [contributions])
  // Agents read the current session's flow runs: their listing, and a fresh one at launch.
  const runsRef = useRef<FlowRuns | undefined>(undefined)
  const makeWorkspace = (restoredTabs?: Snapshot) =>
    new Workspace({
      host: props.host,
      workerSeat: props.workerSeat ?? props.seat,
      history: () => entries.current,
      persist: writer.current.append,
      ...(restoredTabs === undefined ? {} : { restored: restoredTabs }),
      ...(props.flows === undefined ? {} : {
        agents: Agents.port({
          known: () => runsRef.current?.known(),
          listing: () => runsRef.current?.listing() ?? Promise.reject(new Error("Flows unavailable"))
        }, props.flows)
      }),
      seatOf: props.seatOf ?? ((declared) => Models.seatOf(declared, props.models)),
      contribute
    })
  const [workspace, setWorkspace] = useState(() => makeWorkspace(restored.current?.workspace))
  const [revision, setRevision] = useState(0)
  const [runs, setRuns] = useState(() =>
    new FlowRuns({ port: props.flows, persist: writer.current.append, restored: restored.current?.flows })
  )
  /** Monitor updates reach the screen through this; it is set once the toast exists. */
  const deliver = useRef<(delivery: Monitors.Delivery) => void>(() => {})
  const makeMonitors = (
    tabs: Workspace,
    flows: FlowRuns,
    persist: Session.Writer["append"],
    restoredMonitors?: ReadonlyArray<Monitors.Monitor>
  ) =>
    new Monitors.Monitors({
      judged: props.host.judged && props.host.monitor !== undefined,
      observe: Monitors.observer({
        tab: tabs.read,
        run: flows.read,
        shell: (command) => {
          const running = Shell.run({ command, cwd: props.host.cwd, onOutput: () => {} })
          const timer = setTimeout(running.cancel, 30_000)
          return running.done.finally(() => clearTimeout(timer))
        }
      }),
      judge: (input) => props.host.monitor!.judge(input),
      compose: (input) => props.host.monitor!.compose(input),
      deliver: (delivery) => deliver.current(delivery),
      persist,
      subscribe: (source, listener) =>
        source.kind === "tab" ? tabs.subscribe(listener) : source.kind === "run" ? flows.subscribe(listener) : () => {},
      ...(restoredMonitors === undefined ? {} : { restored: restoredMonitors }),
      // A restored shell monitor asks again under this session's approval mode.
      ...(props.host.approvals === undefined ? {} : {
        authorize: Approvals.restored((requests) => props.host.approvals!.authorize(requests))
      })
    })
  const [monitors, setMonitors] = useState(() =>
    makeMonitors(workspace, runs, writer.current.append, restored.current?.monitors)
  )
  useEffect(() => () => monitors.dispose(), [monitors])
  // One ledger per directory: every session's work calibrates the next estimate.
  // Its failures toast once each; `setStatus` is defined below, so they go through a ref.
  const estimateProblem = useRef((_: string) => {})
  const [estimator] = useState(() =>
    new Estimate.Estimator({
      ledger: new Improve.Ledger(Estimate.ledgerFile(props.host.cwd), {
        onWriteError: (error) => estimateProblem.current(`Estimates not saved: ${error instanceof Error ? error.message : String(error)}`)
      }),
      model: props.host.complete === undefined
        ? undefined
        : (request) => props.host.complete!({ ...request, seat: Models.delegateModels.luna }),
      onFailure: (failure) => estimateProblem.current(`Estimate model failed: ${failure.message.split("\n")[0]!.slice(0, 80)}`)
    })
  )
  runsRef.current = runs
  /** Runs the user started here; their form opens without a key. */
  const userRuns = useRef(new Set<string>())
  const formOpened = useRef(new Set<string>())
  const [form, setForm] = useState<FlowForm | undefined>()
  // Keys read the form through this, so typing then Enter never submits a stale draft.
  const liveForm = useRef<FlowForm | undefined>(undefined)
  const changeForm = useCallback((next: FlowForm | undefined) => {
    liveForm.current = next
    setForm(next)
  }, [])
  const [surface, setSurface] = useState("chat")
  const [panelFocus, setPanelFocus] = useState(false)
  const [whichKey, setWhichKey] = useState(false)
  const whichKeyRef = useRef(false)
  const setWhichKeyOpen = useCallback((open: boolean) => {
    whichKeyRef.current = open
    setWhichKey(open)
  }, [])
  const [navigation, setNavigation] = useState(Panels.initial)
  const [filter, setFilter] = useState(Timeline.all)
  /** The chat card `tab` focused, by timeline row key; `enter` opens it. */
  const [cardFocus, setCardFocus] = useState<string | undefined>()
  const [inspection, setInspection] = useState<{ source: string; seq: number; first: Activity.Activity["records"][number] } | undefined>()
  useEffect(() => workspace.subscribe(() => setRevision((value) => value + 1)), [workspace])
  useEffect(() => () => workspace.dispose(), [workspace])
  useEffect(() => runs.subscribe(() => setRevision((value) => value + 1)), [runs])
  useEffect(() => contributions.subscribe(() => setRevision((value) => value + 1)), [contributions])
  useEffect(() => {
    runs.refresh()
    const warm = setTimeout(() => runs.warm(), 0)
    return () => { clearTimeout(warm); void runs.dispose() }
  }, [runs])
  // Every listing replaces the `repo:` contributions; `metadata.tui` is metadata, so nothing is imported.
  useEffect(() => {
    const sync = () => contributions.repo(runs.listed().map(Extension.declared))
    sync()
    return runs.subscribe(sync)
  }, [runs, contributions])
  // Hot reload: a new or edited flow re-lists within one debounce.
  const flowWatch = useRef<Watch.Watcher | undefined>(undefined)
  useEffect(() => {
    if (props.flows === undefined) return
    const watcher = Watch.flows(props.host.cwd, () => runs.refresh())
    flowWatch.current = watcher
    return () => watcher.dispose()
  }, [runs, props.flows, props.host.cwd])
  const flowRuns = runs.snapshot()
  useEffect(() => estimator.subscribe(() => setRevision((value) => value + 1)), [estimator])
  useEffect(() => {
    const timer = setTimeout(() => estimator.seed(join(Session.directory(props.host.cwd), "workers")), 0)
    return () => clearTimeout(timer)
  }, [estimator, props.host.cwd])
  useEffect(() => {
    estimator.tabs(workspace.snapshot().tabs)
    estimator.flows(runs.snapshot(), (flow) => runs.listed().find((listed) => listed.name === flow)?.description)
  }, [estimator, workspace, runs, revision])
  /** Opens a run's form for its missing input. */
  const openForm = useCallback((id: string) => {
    const run = runs.get(id)
    if (run?.status !== "input") return
    const schema = runs.schema(id)
    const fields = schema === undefined ? [] : Form.fields(schema)
    setPanelFocus(false)
    changeForm({ id, flow: run.flow, fields, draft: Form.draft(fields, run.input), focus: 0 })
  }, [runs, changeForm])
  useEffect(() => {
    const open = liveForm.current
    if (open !== undefined) {
      const status = runs.get(open.id)?.status
      // A pending tool approval takes the keys; the run stays parked and `a` in its tab reopens the form.
      if (status !== "input" || approvals.length > 0) changeForm(undefined)
      return
    }
    // Never pull the keyboard away from a draft, a dialog or an approval; a later render opens it.
    if (draft !== "" || picker !== undefined || approvals.length > 0) return
    for (const run of flowRuns) {
      const key = `${run.id}:${run.status}`
      if (!userRuns.current.has(run.id) || run.status !== "input") continue
      if (formOpened.current.has(key)) continue
      formOpened.current.add(key)
      return openForm(run.id)
    }
  }, [revision, runs, openForm, changeForm, approvals, picker, draft])
  const snapshot = workspace.snapshot()
  const eta = (id: string, status: string, startedAt: number) => {
    if (status === "done" || status === "failed" || status === "cancelled" || status === "parked" || status === "waiting") return ""
    // Queued work has not started: its label is the whole estimate.
    const text = Estimate.label(estimator.get(id), status === "queued" ? now : startedAt, now)
    return text === "" ? "" : ` ${text}`
  }
  const cardIds = new Set(snapshot.cards ?? [])
  /**
   * A repository flow's latest run or agent tab, as the status item
   * `metadata.tui.status` asks for. An agent tab names its agent in `agent`.
   */
  const liveStatus = (flow: string): Extension.Status | undefined => {
    const latest = [
      ...flowRuns.filter((each) => each.flow === flow).map((run) => ({
        at: run.startedAt,
        surface: `flow:${run.id}`,
        status: run.status === "done" || run.status === "failed" || run.status === "cancelled" ? run.status : "running"
      })),
      ...snapshot.tabs.filter((tab) => tab.agent?.name === flow).map((tab) => ({
        at: tab.startedAt,
        surface: `tab:${tab.id}`,
        status: tab.status === "done" || tab.status === "failed" || tab.status === "cancelled" ? tab.status : "running"
      }))
    ].sort((a, b) => b.at - a.at)[0]
    return latest === undefined ? undefined : {
      id: flow,
      text: `${latest.status === "done" ? "✓" : latest.status === "failed" ? "✗" : latest.status === "cancelled" ? "■" : "◌"} ${flow}`.slice(0, 24),
      tone: latest.status === "failed" ? "danger" : latest.status === "done" ? "success" : "info",
      action: { kind: "open", surface: latest.surface }
    }
  }
  const extensions = contributions.snapshot(liveStatus)
  const extensionPanel: Panels.Panel | undefined = extensions.problems.length === 0 ? undefined : {
    id: "extensions",
    title: "Extensions",
    summary: `${extensions.problems.length} ${extensions.problems.length === 1 ? "problem" : "problems"}.`,
    rows: extensions.problems.map((problem, index) => ({ id: String(index), label: problem, status: "failed", details: [] }))
  }
  /** `ui:<id>` views: runtime tabs, plugin panels, the problems view, and any card while it is open. */
  const uiPanels: ReadonlyArray<Panels.Panel> = [
    ...snapshot.panels.filter((each) => !cardIds.has(each.id) || surface === `ui:${each.id}`),
    ...extensions.panels.filter((each) => each.placement === "tab" || surface === `ui:${each.panel.id}`).map((each) => each.panel),
    ...(extensionPanel === undefined ? [] : [extensionPanel])
  ]
  /** A card's panel as it is now: a workspace panel, a plugin card, or a flow run's view. */
  const livePanel = (card: Panels.Panel): Panels.Panel =>
    card.id.startsWith("flow:") && runs.has(card.id.slice(5))
      ? { ...runs.panel(card.id.slice(5)), id: card.id }
      : snapshot.panels.find((each) => each.id === card.id) ??
        extensions.panels.find((each) => each.panel.id === card.id)?.panel ?? card
  const statusItems: ReadonlyArray<Extension.Status> = [
    ...(extensionPanel === undefined ? [] : [{
      id: "extensions",
      text: `✗ ${extensions.problems.length} ${extensions.problems.length === 1 ? "extension" : "extensions"}`,
      tone: "danger" as const,
      action: { kind: "open" as const, surface: "ui:extensions" }
    }]),
    ...extensions.status.map((each) => each.status)
  ].slice(0, Contributions.limits.shownStatus)
  const merged = Keys.bindings(extensions.keys)
  // A plugin's tab shows only while open: tab keys never stop on it (`/smithers` opens Smithers).
  const pluginPanels = uiPanels.filter((panel) => extensions.panels.some((each) => each.placement === "tab" && each.panel === panel))
  const pluginTabs = pluginPanels.filter((panel) => surface === `ui:${panel.id}`)
  // Built-in plugin: the Smithers surface, a `plugin:smithers` tab over the flow runs.
  const smithersPanel = props.flows === undefined && flowRuns.length === 0 ? undefined : Smithers.panel(runs.listed(), flowRuns)
  const smithersKey = smithersPanel === undefined ? "" : JSON.stringify(smithersPanel)
  useEffect(() => {
    contributions.plugin("smithers", smithersPanel === undefined ? [] : [{ kind: "panel", placement: "tab", panel: smithersPanel }])
  }, [contributions, smithersKey])
  // Built-in plugin: monitors, one `plugin:monitors` status item while any is active.
  useEffect(() => {
    const sync = () => {
      const active = monitors.list().filter((each) => each.status === "active")
      contributions.plugin("monitors", active.length === 0 ? [] : [{
        kind: "status",
        status: {
          id: "monitors",
          text: (active.length === 1 ? `◉ ${active[0]!.title}` : `◉ ${active.length} monitors`).slice(0, 24),
          tone: "info"
        }
      }])
    }
    sync()
    return monitors.subscribe(sync)
  }, [monitors, contributions])
  // `metadata.tui.card`: each run of that flow started here shows as a live card in the chat.
  const mountedAt = useRef(Date.now())
  const carded = useRef(new Set<string>())
  const cardFlows = extensions.cards.join("\n")
  useEffect(() => {
    if (cardFlows === "") return
    for (const run of flowRuns) {
      if (run.startedAt < mountedAt.current || carded.current.has(run.id) || !extensions.cards.includes(run.flow)) continue
      carded.current.add(run.id)
      const card = runs.panel(run.id)
      setTranscript((current) => Transcript.card(current, card, run.startedAt))
    }
  }, [revision, runs, cardFlows])
  const surfaces = [
    { id: "chat", title: "Chat" },
    { id: "summary", title: "Summary" },
    // Built-in plugins' tabs sit beside Summary while open; runtime and problem views follow the work tabs.
    ...pluginTabs.map((panel) => ({ id: `ui:${panel.id}`, title: panel.title })),
    ...snapshot.tabs.map((tab) => ({
      id: `tab:${tab.id}`,
      title: `${
        tab.status === "running" || tab.status === "requested" || tab.status === "waiting"
          ? "◌ "
          : tab.status === "parked"
          ? "⏸ "
          : tab.status === "queued"
          ? "… "
          : tab.status === "failed"
          ? "✗ "
          : tab.status === "done"
          ? "✓ "
          : "■ "
      }${tab.status === "failed" ? tab.failure?.headline ?? tabTitle(tab) : tab.status === "parked" ? tabToast(tab) : tabTitle(tab)}${eta(Estimate.tabId(tab), tab.status, Estimate.tabStart(tab))}`
    })),
    ...snapshot.tabs.filter((tab) => tab.parent === undefined && snapshot.tabs.some((child) => child.parent === tab.id) &&
      !snapshot.panels.some((panel) => panel.bind?.tree === tab.id))
      .map((tab) => ({ id: `tree:${tab.id}`, title: `Tree: ${tab.title}` })),
    ...flowRuns.map((run) => ({
      id: `flow:${run.id}`,
      title: `${flowGlyph(run.status)}${run.flow}${eta(Estimate.runId(run), run.status, run.launchedAt ?? run.startedAt)}`
    })),
    ...uiPanels.filter((panel) => !pluginPanels.includes(panel)).map((panel) => ({ id: `ui:${panel.id}`, title: panel.title }))
  ]
  const showTab = (id: string) => {
    setSurface(id)
    setPanelFocus(id !== "chat")
    setNavigation(Panels.initial())
  }
  const clickTab = (id: string) => {
    if (liveForm.current !== undefined) changeForm(undefined)
    showTab(id)
  }
  const basePanel = surface === "summary"
    ? Summary.panel(transcript)
    : surface.startsWith("tab:")
    ? workspace.panel(surface.slice(4))
    : surface.startsWith("flow:")
    ? runs.panel(surface.slice(5))
    : surface.startsWith("tree:")
    ? workspace.tree(surface.slice(5))
    : uiPanels.find((panel) => `ui:${panel.id}` === surface)
  const panel = basePanel?.bind === undefined ? basePanel : (() => {
    const tree = workspace.tree(basePanel.bind.tree)
    return { ...basePanel, rows: [...tree.rows, ...basePanel.rows.map((row) => ({ ...row, id: `${basePanel.id}/${row.id}` }))] }
  })()
  const focusMain = basePanel?.placement === "main"
  /** Approval keys the focused panel acts on: its `a` runs the selected row's action or opens a flow's form. */
  const panelKeys = panelFocus && panel !== undefined &&
      (surface.startsWith("flow:") || panel.rows[Math.min(navigation.selected, panel.rows.length - 1)]?.action !== undefined)
    ? ["a"]
    : []
  const lanes = new Map(snapshot.tabs.map((tab, index) => [tab.id, { title: tabTitle(tab), tone: lane(index) }]))
  const timeline = Timeline.merge(
    [
      { id: Timeline.chat, transcript },
      ...snapshot.tabs.map((tab) => ({ id: tab.id, transcript: workspace.transcript(tab.id) }))
    ],
    filter
  )  /** Cards in the chat, oldest first; `tab` on an empty composer walks them. */
  const cardKeys = surface === "chat" && panel === undefined
    ? timeline.filter((row) => row.item.kind === "card").map((row) => row.key)
    : []
  const focusedCard = cardFocus !== undefined && cardKeys.includes(cardFocus) ? cardFocus : undefined

  const activitySources = [
    { id: "chat", title: "Chat", activity: transcript.activity },
    ...snapshot.tabs.map(tab => ({ id: tab.id, title: tabTitle(tab), activity: workspace.transcript(tab.id).activity }))
  ].filter((source): source is { id: string; title: string; activity: Activity.Activity } =>
    source.activity !== undefined && source.activity.records.length > 0)
  const latestActivity = [...activitySources].sort((a, b) =>
    (b.activity.records.at(-1)?.occurredAt ?? 0) - (a.activity.records.at(-1)?.occurredAt ?? 0))
  // A new turn or restored session cannot inherit a cursor from an old turn.
  const pinnedActivity = activitySources.find(source => source.id === inspection?.source &&
    source.activity.records[0] === inspection.first)
  const monitored = (surface.startsWith("tab:") ? activitySources.find(source => source.id === surface.slice(4)) : pinnedActivity)
    ?? latestActivity.find(source => source.activity.status === "running") ?? latestActivity[0]
  const showActivity = monitored !== undefined && (panel === undefined || surface.startsWith("tab:"))
  const activeInspection = showActivity && pinnedActivity === monitored ? inspection : undefined
  const transcriptOf = (source: string) => source === Timeline.chat ? transcript : workspace.transcript(source)
  /** The chat row a scrubber position lands on. */
  const jumpTarget = activeInspection === undefined ? undefined : (() => {
    const id = Scrubber.target(transcriptOf(activeInspection.source), activeInspection.seq)
    return id === undefined ? undefined : `${activeInspection.source}:${id}`
  })()
  const reveal = (key: string) => {
    const box = scroll.current
    const child = box?.content.findDescendantById(key)
    if (box === null || box === undefined || child === undefined) return
    box.scrollTop = Math.max(0, box.scrollTop + child.y - box.viewport.y - 1)
  }
  const inspectActivity = (seq: number, jump = true) => {
    if (monitored === undefined) return
    setPanelFocus(false)
    setInspection({ source: monitored.id, seq, first: monitored.activity.records[0]! })
    const id = Scrubber.target(transcriptOf(monitored.id), seq)
    if (id === undefined || !jump) return
    if (surface !== "chat") setSurface("chat")
    const key = `${monitored.id}:${id}`
    reveal(key)
    // A surface switch mounts the chat first; lay it out, then aim again.
    setTimeout(() => reveal(key), 60)
  }
  const followLive = () => {
    setInspection(undefined)
    const box = scroll.current
    if (box !== null) box.scrollTop = box.scrollHeight
  }
  const panelScroll = useRef<((direction: number) => void) | undefined>(undefined)
  const composer = useRef<TextareaRenderable>(null)
  const scroll = useRef<ScrollBoxRenderable>(null)
  const dragScroll = useMemo(() => DragScroll.make(() => renderer.getSelection()?.isDragging === true), [renderer])
  const lastCtrlC = useRef(0)
  const files = useRef(Files.lister(props.host.cwd, Date.now, () => setRevision((value) => value + 1)))
  /** The draft a palette command with an argument displaced; restored by the next submit. */
  const parkedDraft = useRef<string | undefined>(undefined)
  const dimensions = useTerminalDimensions()
  const setStatus = useCallback((text: string, tone: Toast["tone"] = "info") => setToast({ text, tone }), [])
  useEffect(() => Log.subscribe((message) => setStatus(message, "danger")), [setStatus])
  const discoveryFailure = runs.failure()
  useEffect(() => {
    if (discoveryFailure !== undefined) setStatus(discoveryFailure.message, "danger")
  }, [discoveryFailure, setStatus])
  deliver.current = (delivery) => {
    const text = `${delivery.title}: ${delivery._tag === "update" ? delivery.text : Monitors.message(delivery.failure)}`
    setStatus(text, delivery._tag === "update" ? "info" : "danger")
    setTranscript((current) =>
      delivery._tag === "update" ? Transcript.note(current, text, delivery.at) : Transcript.alert(current, text, delivery.at))
  }
  useEffect(() => {
    if (restored.damaged !== undefined) setStatus(restored.damaged, "danger")
  }, [])
  estimateProblem.current = (text) => setStatus(text, "warning")

  const completion = useMemo(
    () => (menuDismissed
      ? undefined
      : Complete.complete(draft, cursor, {
        models: props.models,
        files: () => files.current(),
        flows: runs.listed,
        agents: () => runs.listed().filter(Extension.isAgent)
      })),
    [draft, cursor, menuDismissed, props.models, runs, revision]
  )
  const menu = completion !== undefined && (completion.items.length > 0 || completion.kind !== "file")
    ? completion
    : undefined
  const menuIdentity = menu === undefined ? "" : `${menu.kind}:${menu.query}`
  useEffect(() => setMenuIndex(0), [menuIdentity])

  // A dialog's rows follow the dialog and its sources, never the 100 ms clock: the palette ranks every file.
  const tabsKey = snapshot.tabs.map((tab) => `${tab.id}\0${tab.title}\0${tab.status}`).join("\n")
  /** Contributed keys and status items the palette can run. */
  const paletteActions: NonNullable<Palette.Sources["actions"]> = [
    ...extensions.keys.map(({ key }) => ({ key: `key:${key.id}`, label: key.label, hint: key.key, action: key.action })),
    ...statusItems.flatMap((item) => item.action === undefined ? [] : [{ key: `status:${item.id}`, label: item.text, action: item.action }])
  ]
  const actionsKey = JSON.stringify(paletteActions)
  const rows = useMemo(
    () => picker === undefined
      ? []
      : pickerRows(picker, props.models, seat, filter, snapshot.tabs, files.current, search?.hits ?? [], runs.listed(), paletteActions),
    [picker, props.models, seat, filter, tabsKey, search?.hits, runs, revision, actionsKey]
  )

  // Key handlers read the latest values through these, never a stale render.
  // `now` is the clock the approval row rendered with, so its keys and its hints agree.
  const live = useRef({ turn, shell, undoing, followUps, seat, thinking, picker, menu, menuIndex, approvals, now, whichKey })
  live.current = { turn, shell, undoing, followUps, seat, thinking, picker, menu, menuIndex, approvals, now, whichKey }

  useEffect(() => {
    renderer.setTerminalTitle(`smithers - ${basename(props.host.cwd)}`)
  }, [renderer, props.host.cwd])

  useEffect(() =>
    Clipboard.copyOnSelect(
      renderer,
      (text) => Clipboard.write(text),
      () => setStatus("Copied"),
      () => setStatus("Copy failed: no pbcopy, wl-copy, xclip or xsel", "warning")
    ), [renderer])

  // One clock drives foreground and background progress through real settlement.
  const clockRunning = turn !== undefined || shell !== undefined || undoing !== undefined || workspace.busy ||
    runs.busy || flowRuns.some((run) => run.endedAt !== undefined && now - run.endedAt < 3000) ||
    search?.status === "running" ||
    snapshot.tabs.some((tab) => tab.endedAt !== undefined && now - tab.endedAt < 3000)
  useEffect(() => {
    if (!clockRunning) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [clockRunning])

  // The store has no subscription; a request exists only while work runs, so
  // it is read on its own slower poll while the work clock runs.
  useEffect(() => {
    const ports = props.host.approvals
    if (ports === undefined || ports.mode !== "ask") return
    if (!clockRunning) return setApprovals((current) => (current.length === 0 ? current : []))
    let active = true
    const stop = Approvals.poll(() =>
      ports.pending().then(
        (listed) => {
          if (!active) return
          arming.current = Approvals.shown(arming.current, listed, Date.now(), answered.current)
          const next = listed.filter((request) => !answered.current.has(request.requestId))
          setApprovals((current) =>
            current.length === next.length && current.every((each, index) => each.requestId === next[index]!.requestId)
              ? current
              : next
          )
        },
        (error) => setStatus(String(error), "danger")
      )
    )
    return () => {
      active = false
      stop()
    }
  }, [clockRunning, props.host, setStatus])

  useEffect(() => {
    // A failure stays until another notice replaces it or the next submit.
    if (toast === undefined || toast.tone === "danger") return
    const timer = setTimeout(() => setToast(undefined), 3000)
    return () => clearTimeout(timer)
  }, [toast])

  // `text:` runs rg in the background; a newer query, leaving text mode, or closing cancels it.
  const parsedPalette = picker?.kind === "palette" ? Palette.parse(picker.query) : undefined
  const textQuery = parsedPalette?.mode === "text" && parsedPalette.query.length >= 2 ? parsedPalette : undefined
  const textKey = textQuery === undefined ? "" : `${textQuery.query}\0${textQuery.regex ?? ""}`
  useEffect(() => {
    const generation = ++searchGeneration.current
    setSearch(undefined)
    if (textQuery === undefined) return
    let running: ReturnType<typeof Search.run> | undefined
    const timer = setTimeout(() => {
      running = Search.run({
        cwd: props.host.cwd,
        query: textQuery.query,
        ...(textQuery.regex === undefined ? {} : { regex: textQuery.regex })
      })
      setSearch({ query: textQuery.query, startedAt: Date.now(), status: "running", hits: [], truncated: false })
      void running.done.then((outcome) => {
        if (generation !== searchGeneration.current || outcome._tag === "cancelled") return
        if (outcome._tag === "done") {
          setSearch({ query: textQuery.query, startedAt: 0, status: "done", hits: outcome.hits, truncated: outcome.truncated })
          return
        }
        setSearch(undefined)
        setStatus(
          outcome.reason === "missing-rg"
            ? "rg not found"
            : outcome.reason === "bad-pattern"
            ? `Bad pattern: ${outcome.message}`
            : `rg: ${outcome.message}`,
          "danger"
        )
      })
    }, 150)
    return () => {
      clearTimeout(timer)
      running?.cancel()
    }
  }, [textKey, props.host.cwd])

  // `session:` reads the session files once per palette opening.
  const needsSessions = parsedPalette?.mode === "sessions" && picker?.kind === "palette" && picker.sessions === undefined
  useEffect(() => {
    if (!needsSessions) return
    let sessions: ReadonlyArray<Session.Summary> = []
    try {
      sessions = Session.list(props.host.cwd)
    } catch (error) {
      setStatus(String(error), "danger")
    }
    setPicker((current) => (current?.kind === "palette" ? { ...current, sessions } : current))
  }, [needsSessions, props.host.cwd])

  const setText = useCallback((text: string, at?: number) => {
    const input = composer.current
    if (input === null) return
    input.setText(text)
    if (at === undefined) input.gotoBufferEnd()
    else input.cursorOffset = at
    arming.current = Approvals.edited(arming.current, Date.now())
    setDraft(text)
    setCursor(input.cursorOffset)
  }, [])

  const quit = useCallback(() => {
    flowWatch.current?.dispose()
    workspace.dispose()
    monitors.dispose()
    const stopped = runs.dispose()
    live.current.turn?.handle.cancel()
    live.current.shell?.cancel()
    renderer.destroy()
    void External.bounded(stopped.then(() => Promise.allSettled([props.host.dispose(), props.flows?.dispose()])))
      .then(() => process.exit(0))
  }, [renderer, props.host, props.flows, workspace, runs, monitors])

  const startTurn = useCallback((prompt: string) => {
    const steering = Steering.make()
    const steered: Array<string> = []
    const startedAt = Date.now()
    const estimate = `turn:${writer.current.file}:${startedAt}`
    let tokens: number | undefined
    estimator.request({ id: estimate, kind: "turn", key: `turn:${live.current.seat}`, subject: prompt, startedAt })
    writer.current.append({ type: "user", at: startedAt, text: prompt })
    setTranscript((current) => Transcript.user(current, prompt, false, startedAt))
    const handle = props.host.run({
      prompt,
      seat: live.current.seat,
      history: entries.current,
      ...(live.current.seat.startsWith("replay:") ? {} : { role: "coordinator" as const }),
      workerSeat: props.workerSeat ?? props.seat,
      background: `${workspace.context()}\nFlow runs: ${runs.context()}\nMonitors: ${monitors.context()}\nAgents: ${Agents.context(runs.listed())}`,
      runtime: {
        publish: (contribution) => {
          if (contribution.kind !== "panel") return contribute("runtime:chat", contribution)
          if (contribution.placement === "tab") {
            const first = !workspace.snapshot().panels.some((shown) => shown.id === contribution.panel.id)
            const panel = workspace.publish(contribution.panel)
            if (first && panel.placement === "main") {
              setSurface((current) => current === "chat" ? `ui:${panel.id}` : current)
              setPanelFocus(false)
            }
            return
          }
          const at = Date.now()
          const panel = workspace.publish(contribution.panel, "card", at)
          setTranscript((current) => Transcript.card(current, panel, at))
        },
        delegate: workspace.request,
        read: (id) => (runs.has(id) ? runs.read(id) : workspace.read(id)),
        list: () => [...workspace.snapshot().tabs, ...runs.snapshot()],
        retry: (id) => (runs.has(id) ? runs.retry(id) : workspace.retry(id)),
        monitors,
        eta: () => estimator.eta(Estimate.active(workspace.snapshot().tabs, runs.snapshot()), Date.now(), seats),
        ...(props.flows === undefined ? {} : {
          flows: {
            list: () => runs.describe((flow) => flow.modelInvocable),
            run: (request: { id: string; flow: string; input?: Record<string, unknown> }) =>
              runs.request({ id: request.id, flow: request.flow, input: request.input ?? {}, by: "agent" }),
            inspect: runs.read
          }
        })
      },
      onCaption: (prose) => {
        writer.current.append({ type: "caption", prose })
        setTranscript((current) => Transcript.caption(current, prose))
      },
      onPatch: (receipt) => {
        writer.current.append({ type: "patch", receipt })
        setTranscript((current) => Transcript.patched(current, receipt))
      },
      steering: steering.source,
      ...(live.current.thinking === undefined ? {} : { thinking: live.current.thinking }),
      onEvent: (event) => {
        const at = Date.now()
        if (event._tag !== "model-delta") writer.current.append({ type: "event", at, event })
        if (event._tag === "model-settled") tokens = (tokens ?? 0) + (Estimate.usage([{ type: "event", at, event }]) ?? 0)
        if (event._tag === "steering-drained") {
          for (const message of event.messages) {
            steered.push(message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""))
          }
        }
        setTranscript((current) => Transcript.apply(current, event, at))
      }
    })
    const state: TurnState = { handle, startedAt, steering, estimate }
    live.current.turn = state
    setTurn(state)
    void handle.done.then((outcome) => {
      const at = Date.now()
      const said = [prompt, ...steered].join("\n\n")
      writer.current.append({ type: "outcome", at, prompt: said, outcome })
      estimator.settle(estimate, { ms: at - startedAt, ...(tokens === undefined ? {} : { tokens }) }, outcome._tag, at)
      if (outcome._tag === "done") entries.current.push({ kind: "exchange", user: said, answer: outcome.answer })
      if (outcome._tag === "failed") setTranscript((current) => Transcript.failure(current, outcome.message, at))
      if (outcome._tag === "cancelled") setTranscript((current) => Transcript.failure(current, "Stopped", at))
      live.current.turn = undefined
      setTurn(undefined)
      if (outcome._tag === "cancelled") return
      // Steers no boundary reached, then follow-ups, go next, one turn each.
      const undelivered = steering.take()
      const next = undelivered.length > 0 ? undelivered.join("\n\n") : live.current.followUps[0]
      if (undelivered.length === 0 && next !== undefined) setFollowUps((queued) => queued.slice(1))
      if (next !== undefined) startTurnRef.current(next)
    })
  }, [props.host, props.flows, workspace, runs, monitors, estimator, contribute])
  const startTurnRef = useRef(startTurn)
  startTurnRef.current = startTurn

  const runShell = useCallback((command: string, excluded: boolean) => {
    if (live.current.shell !== undefined) {
      setStatus("A shell command is already running. Press esc to cancel it first.", "warning")
      return
    }
    let id = ""
    setTranscript((current) => {
      id = Transcript.nextId(current)
      return Transcript.shellStart(current, command, excluded, Date.now())
    })
    const running = Shell.run({
      command,
      cwd: props.host.cwd,
      onOutput: (text) => setTranscript((current) => Transcript.shellOutput(current, id, text))
    })
    setShell(running)
    void running.done.then((result) => {
      writer.current.append({ type: "shell", at: Date.now(), result: Shell.persisted(result, excluded), excluded })
      if (!excluded) entries.current.push({ kind: "shell", text: Shell.contextText(result) })
      setTranscript((current) => Transcript.shellDone(current, id, result))
      setShell(undefined)
    })
  }, [props.host.cwd, setStatus])

  /** Reverses a Summary or worker tab row's captured changes in the background; the composer stays usable. */
  const runUndo = useCallback((target: Undo.Target, tab: string | undefined) => {
    const current = live.current
    if (current.turn !== undefined || current.shell !== undefined || current.undoing !== undefined || workspace.busy || runs.busy) {
      return setStatus(Undo.message({ _tag: "Busy" }), "warning")
    }
    const startedAt = Date.now()
    live.current.undoing = startedAt
    setUndoing(startedAt)
    const cwd = props.host.cwd
    void Undo.plan(cwd, target)
      .then((plan) => ("_tag" in plan ? plan : Undo.commit(cwd, plan).then((failure) => failure ?? plan)))
      .catch((error): Undo.Failure => ({ _tag: "WriteFailed", path: "", message: String(error), restored: false }))
      .then((settled) => {
        if ("_tag" in settled) {
          setStatus(Undo.message(settled), settled._tag === "Conflict" || settled._tag === "WriteFailed" ? "danger" : "warning")
        } else {
          const at = Date.now()
          const paths = settled.files.map((file) => file.path)
          try {
            if (tab !== undefined) workspace.undone(tab, settled.calls, paths, at)
            writer.current.append({ type: "undo", at, calls: settled.calls, paths, ...(tab === undefined ? {} : { tab }) })
            entries.current.push({ kind: "undo", paths })
            if (tab === undefined) setTranscript((current) => Transcript.undone(current, settled.calls, paths, at))
            setStatus(Undo.done(settled))
          } catch (error) {
            setStatus(`${Undo.done(settled)} · not recorded: ${error instanceof Error ? error.message : String(error)}`, "danger")
          }
        }
        live.current.undoing = undefined
        setUndoing(undefined)
        // A prompt sent while undoing waited, so the model never races the undo's writes.
        const next = live.current.followUps[0]
        if (next !== undefined && live.current.turn === undefined) {
          setFollowUps((queued) => queued.slice(1))
          startTurnRef.current(next)
        }
      })
  }, [props.host.cwd, workspace, runs, setStatus])

  const switchSeat = useCallback((next: string) => {
    setSeat(next)
    setStatus(`Switched to ${props.models.find((model) => model.seat === next)?.label ?? next}`)
  }, [props.models, setStatus])

  /**
   * Switches the screen, context, workers and every per-session view state to
   * `next`, whose records are `records`. Prompt history carries over when
   * `records` has none (`/new`).
   */
  const adopt = useCallback((next: Session.Writer, records: ReadonlyArray<Session.Record>) => {
    const state = Session.restore(records)
    writer.current = Session.guarded(next, unsaved)
    entries.current = state.entries
    if (records.length > 0) history.current = new Editor.History(state.prompts)
    const nextRuns = new FlowRuns({ port: props.flows, persist: writer.current.append, restored: state.flows })
    setRuns(nextRuns)
    // Agents list the next session's flows, before the render that would set this.
    runsRef.current = nextRuns
    // Everything below belongs to one session; none of it may leak into the next.
    changeForm(undefined)
    userRuns.current = new Set()
    formOpened.current = new Set()
    setFollowUps([])
    setFilter(Timeline.all)
    setInspection(undefined)
    setNavigation(Panels.initial())
    setCompact(undefined)
    const nextWorkspace = makeWorkspace(state.workspace)
    setWorkspace(nextWorkspace)
    setMonitors(makeMonitors(nextWorkspace, nextRuns, writer.current.append, state.monitors))
    contributions.clearRuntime()
    for (const each of state.contributions) {
      try { contributions.runtime(each.owner, each.contribution) } catch { /* A key a newer built-in took stays off. */ }
    }
    setSurface("chat")
    setPanelFocus(false)
    setName(state.name)
    setTranscript(state.transcript)
    return state
  }, [props.flows, changeForm, unsaved, contribute, contributions])

  const newSession = useCallback(() => {
    adopt(Session.create(props.host.cwd), [])
    setStatus("New session started")
  }, [adopt, props.host.cwd, setStatus])

  const openSession = useCallback((file: string) => {
    let records: ReadonlyArray<Session.Record>
    try {
      records = Session.load(file)
    } catch (error) {
      return setStatus(Session.quarantine(file, error), "danger")
    }
    const state = adopt(Session.reopen(file), records)
    setStatus(`Resumed ${state.name ?? basename(file)}`)
  }, [adopt, setStatus])

  const forkSession = useCallback((turn: Session.Turn) => {
    let result: Session.Fork
    try {
      result = Session.fork(writer.current.file, props.host.cwd, turn)
    } catch (error) {
      return setStatus(`Fork failed: ${error instanceof Error ? error.message : String(error)}`, "danger")
    }
    if (result._tag === "Stale") return setStatus("Session changed; fork again", "warning")
    adopt(result.writer, result.records)
    setText(result.text)
    setStatus("Forked to new session")
  }, [adopt, setText, setStatus, props.host.cwd])

  /** `/new`, `/resume` and `/fork` wait for a turn, a `!cmd`, an undo, workers and flow runs, from any door. */
  const occupied = () =>
    live.current.turn !== undefined || live.current.shell !== undefined || live.current.undoing !== undefined ||
    workspace.busy || runs.busy

  const command = useCallback((text: string): boolean => {
    const parsed = Editor.parseCommand(text)
    if (parsed === undefined) return false
    const { name: verb, argument } = parsed
    switch (verb) {
      case "summary":
        setSurface("summary")
        setPanelFocus(true)
        setNavigation(Panels.initial())
        return true
      case "smithers":
        runs.refresh()
        setSurface(`ui:${Smithers.id}`)
        setPanelFocus(true)
        setNavigation(Panels.initial())
        return true
      case "tabs":
        setSurface(snapshot.tabs[0] === undefined ? "summary" : `tab:${snapshot.tabs[0].id}`)
        setPanelFocus(true)
        setNavigation(Panels.initial())
        return true
      case "chat":
        setSurface("chat")
        setPanelFocus(false)
        return true
      case "filter":
        setSurface("chat")
        setPanelFocus(false)
        setPicker({ kind: "filter", query: "", selected: 0 })
        return true
      case "grep":
        setSurface("chat")
        setPanelFocus(false)
        setFilter((current) => ({ ...current, query: argument }))
        return true
      case "retry":
      case "stop": {
        if (argument === "") {
          const ids = [...workspace.snapshot().tabs.map((tab) => tab.id), ...runs.snapshot().map((run) => run.id)]
          setStatus(ids.length === 0 ? "No tabs" : `/${verb} <id>: ${ids.join(", ")}`, "warning")
          return true
        }
        if (!runs.has(argument) && !workspace.snapshot().tabs.some((tab) => tab.id === argument)) {
          setStatus(`Unknown tab: ${argument}`, "warning")
          return true
        }
        try {
          if (verb === "retry") {
            if (runs.has(argument)) runs.retry(argument)
            else workspace.retry(argument)
          } else if (runs.has(argument)) runs.cancel(argument)
          else workspace.cancel(argument)
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), "warning")
        }
        return true
      }
      case "flows":
        runs.refresh()
        setPicker({ kind: "flows", query: "", selected: 0 })
        return true
      case "flow": {
        const space = argument.search(/\s/)
        const flow = space < 0 ? argument : argument.slice(0, space)
        if (flow === "") {
          runs.refresh()
          setPicker({ kind: "flows", query: "", selected: 0 })
          return true
        }
        const parsed = Form.parseArgs(space < 0 ? "" : argument.slice(space + 1))
        if ("error" in parsed) {
          setStatus(parsed.error, "warning")
          return true
        }
        try {
          userRuns.current.add(runs.request({ flow, input: parsed.input, by: "user" }).id)
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), "warning")
        }
        return true
      }
      case "agent": {
        const space = argument.search(/\s/)
        const agent = space < 0 ? argument : argument.slice(0, space)
        const prompt = space < 0 ? "" : argument.slice(space + 1).trim()
        if (agent === "") {
          runs.refresh()
          setPicker({ kind: "agents", query: "", selected: 0 })
          return true
        }
        // The prompt is the agent's one field: without it, the composer asks for it.
        if (prompt === "") {
          setText(`/agent ${agent} `)
          return true
        }
        try {
          workspace.request({
            id: `${agent}-${Date.now().toString(36)}`,
            title: prompt.replace(/\s+/g, " ").slice(0, 60),
            prompt,
            agent,
            by: "user"
          })
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), "warning")
        }
        return true
      }
      case "ui": {
        const target = uiPanels.find((panel) => panel.id === argument) ?? uiPanels[0]
        if (target === undefined) setStatus("No custom views")
        else {
          setSurface(`ui:${target.id}`)
          setPanelFocus(true)
          setNavigation(Panels.initial())
        }
        return true
      }
      case "model":
        if (argument.includes(":")) switchSeat(argument)
        else setPicker({ kind: "model", query: argument, selected: 0 })
        return true
      case "theme":
        setPicker({ kind: "theme", query: "", selected: 0 })
        return true
      case "thinking": {
        const level = argument === "" || argument === "default" ? undefined : argument
        if (level !== undefined && !(Editor.thinkingLevels as ReadonlyArray<string>).includes(level)) {
          setStatus(`Thinking levels: default, ${Editor.thinkingLevels.join(", ")}`, "warning")
          return true
        }
        setThinking(level as Editor.Thinking)
        setStatus(`Thinking level: ${level ?? "default"}`)
        return true
      }
      case "new":
        if (occupied()) {
          setStatus("Stop running work first", "warning")
        } else newSession()
        return true
      case "resume":
        setPicker({ kind: "resume", query: "", selected: 0, sessions: Session.list(props.host.cwd) })
        return true
      case "fork": {
        if (occupied()) {
          setStatus("Stop running work first", "warning")
          return true
        }
        let turns: ReadonlyArray<Session.Turn>
        try {
          turns = existsSync(writer.current.file) ? Session.turns(Session.load(writer.current.file)) : []
        } catch (error) {
          setStatus(`Fork failed: ${error instanceof Error ? error.message : String(error)}`, "danger")
          return true
        }
        if (turns.length === 0) setStatus("No messages to fork from")
        else setPicker({ kind: "fork", query: "", selected: 0, turns })
        return true
      }
      case "session": {
        const usage = transcript.usage
        setTranscript((current) =>
          Transcript.note(
            current,
            `${writer.current.file}\n${Log.path()}\n${entries.current.length} exchanges · ↑${Editor.tokens(usage.input)} ↓${
              Editor.tokens(usage.output)
            } R${Editor.tokens(usage.cached)}`,
            Date.now()
          )
        )
        return true
      }
      case "compact": {
        if (live.current.turn !== undefined) {
          setStatus("Stop running work first", "warning")
          return true
        }
        const dropped = Context.compactable(entries.current, compact ?? Math.round(transcript.usage.context / 2))
        if (dropped === 0) {
          setStatus("Nothing to compact")
          return true
        }
        entries.current.splice(0, dropped)
        writer.current.append({ type: "compact", at: Date.now(), dropped })
        setCompact(undefined)
        setStatus(`Dropped the ${dropped} oldest context entries`)
        return true
      }
      case "name":
        if (argument === "") {
          setStatus(name === undefined ? "This session has no name" : `Session: ${name}`)
          return true
        }
        writer.current.append({ type: "name", name: argument })
        setName(argument)
        return true
      case "copy": {
        const answer = transcript.items.findLast((item) => item.kind === "answer")
        if (answer === undefined || answer.kind !== "answer") {
          setStatus("No answer to copy", "warning")
          return true
        }
        void Clipboard.write(answer.text).then((copied) =>
          copied
            ? setStatus("Copied the last answer")
            : setStatus("Copy failed: no pbcopy, wl-copy, xclip or xsel", "warning")
        )
        return true
      }
      case "hotkeys":
        setTranscript((current) =>
          Transcript.note(current, Keys.sheet(), Date.now())
        )
        return true
      case "quit":
      case "exit":
        quit()
        return true
      default:
        setStatus(`Unknown command /${verb}`, "warning")
        return true
    }
  }, [transcript, name, newSession, quit, switchSeat, setStatus, setText, props.host.cwd, workspace, runs, revision])

  /** A prompt for the agent, taken literally: never a `!` shell line or a `/` command. */
  const send = useCallback((text: string, followUp = false) => {
    const running = live.current.turn
    if (running === undefined && live.current.undoing !== undefined) {
      setFollowUps((queued) => [...queued, text])
      return
    }
    if (running === undefined) return startTurn(text)
    if (followUp) {
      setFollowUps((queued) => [...queued, text])
      return
    }
    running.steering.steer(text)
    writer.current.append({ type: "user", at: Date.now(), text, steered: true })
    setTranscript((current) => Transcript.user(current, text, true, Date.now()))
  }, [startTurn])

  const submit = useCallback((followUp = false, typed?: string) => {
    const input = composer.current
    if (input === null) return
    const text = (typed ?? input.plainText).trim()
    if (text === "") return
    setToast((current) => (current?.tone === "danger" ? undefined : current))
    const shellLine = Shell.parse(text)
    const parked = parkedDraft.current
    parkedDraft.current = undefined
    history.current.add(text)
    setText(parked ?? "")
    if (shellLine !== undefined) {
      if (shellLine.command !== "") runShell(shellLine.command, shellLine.excluded)
      return
    }
    if (text.startsWith("/") && command(text)) return
    send(text, followUp)
  }, [setText, runShell, command, send])

  /**
   * Runs a contributed action for the person who chose it: a key, a status
   * item, a card row or a palette row. It never awaits: a prompt starts a turn
   * or queues, a flow returns its `requested` receipt, and the toast settles
   * with the run.
   */
  const perform = (action: Extension.Action) => {
    switch (action.kind) {
      case "prompt":
        setPanelFocus(false)
        if (live.current.turn === undefined && live.current.undoing === undefined) return startTurnRef.current(action.prompt)
        return setFollowUps((queued) => [...queued, action.prompt])
      case "flow":
        try {
          userRuns.current.add(runs.request({ flow: action.flow, input: action.input ?? {}, by: "user" }).id)
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), "warning")
        }
        return
      case "agent":
        // Agent input is a form whose one field is the prompt: without one, the composer asks.
        if (action.prompt !== undefined && action.prompt.trim() !== "") {
          command(`/agent ${action.agent} ${action.prompt}`)
          return
        }
        setPanelFocus(false)
        return setText(`/agent ${action.agent} `)
      case "open": {
        const target = action.surface === "smithers" ? `ui:${Smithers.id}` : action.surface
        const card = target.startsWith("ui:") && cardIds.has(target.slice(3))
        if (target !== "chat" && !card && !surfaces.some((each) => each.id === target)) {
          return setStatus(`No view ${target}`, "warning")
        }
        if (liveForm.current !== undefined) changeForm(undefined)
        return showTab(target)
      }
    }
  }
  /** Which owner a surface belongs to, so a `panel` key works only on its owner's own views. */
  const ownerOf = (id: string): string | undefined => {
    if (id.startsWith("flow:")) {
      const run = runs.get(id.slice(5))
      return run === undefined ? undefined : `repo:${run.flow}`
    }
    if (id.startsWith("tab:")) return `runtime:${id.slice(4)}`
    if (!id.startsWith("ui:")) return undefined
    const plugin = extensions.panels.find((each) => `ui:${each.panel.id}` === id)
    if (plugin !== undefined) return plugin.owner
    const slash = id.indexOf("/")
    return slash < 0 ? "runtime:chat" : `runtime:${id.slice(3, slash)}`
  }

  /** Tab inserts the selected completion; Enter also runs it when it is a whole command. */
  const acceptCompletion = useCallback((run: boolean) => {
    const { menu: open, menuIndex: index } = live.current
    const input = composer.current
    if (open === undefined || input === null) return
    const suggestion = open.items[index]
    if (suggestion === undefined) return
    const next = Complete.apply(input.plainText, open, suggestion)
    if (run && suggestion.submit) return submit(false, next.text)
    setText(next.text, next.cursor)
  }, [setText, submit])

  /** pi's restore: queued messages go back into the editor, above the draft. */
  const restoreQueued = useCallback((extra: ReadonlyArray<string> = []) => {
    const queued = [...extra, ...live.current.followUps]
    if (queued.length === 0) return
    setFollowUps([])
    const current = composer.current?.plainText ?? ""
    setText([...queued, ...(current === "" ? [] : [current])].join("\n\n"))
    setStatus(`Restored ${queued.length} queued message${queued.length === 1 ? "" : "s"} to editor`)
  }, [setText, setStatus])

  const externalEditor = useCallback(() => {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "nano"
    renderer.suspend()
    let edited: string | undefined
    try {
      edited = External.edit(composer.current?.plainText ?? "", editor)
    } finally {
      renderer.resume()
    }
    if (edited !== undefined) setText(edited)
  }, [renderer, setText])

  const cycleModel = useCallback((step: number) => {
    if (props.models.length < 2) {
      setStatus("Only one model available", "warning")
      return
    }
    const at = props.models.findIndex((model) => model.seat === live.current.seat)
    const next = props.models[(at + step + props.models.length) % props.models.length]!
    switchSeat(next.seat)
  }, [props.models, switchSeat, setStatus])

  const resumeGuarded = (file: string) => {
    if (!occupied()) openSession(file)
    else setStatus("Stop running work first", "warning")
  }

  const pick = useCallback((open: Picker, value: string) => {
    if (open.kind === "filter") {
      // Toggles keep the dialog open, like a log view's filter menu.
      if (value === "all") return setFilter(Timeline.all)
      const split = value.indexOf(":")
      const id = value.slice(split + 1)
      return setFilter((current) =>
        value.startsWith("source:") ? Timeline.toggleSource(current, id) : Timeline.toggleKind(current, id as Timeline.Kind)
      )
    }
    setPicker(undefined)
    if (open.kind === "undo") {
      if (value === "undo") runUndo(open.target, open.tab)
      return
    }
    if (open.kind === "fork") {
      const turn = open.turns.find((each) => String(each.index) === value)
      if (turn === undefined) return
      if (occupied()) {
        return setStatus("Stop running work first", "warning")
      }
      return forkSession(turn)
    }
    if (open.kind === "model") return switchSeat(value)
    if (open.kind === "worker-model") return workspace.retry(open.id, value)
    if (open.kind === "flows") {
      // An agent runs in a worker tab; its one field is the prompt.
      if (runs.listed().some((flow) => flow.name === value && Extension.isAgent(flow))) return setText(`/agent ${value} `)
      command(`/flow ${value}`)
      return
    }
    if (open.kind === "agents") return setText(`/agent ${value} `)
    if (open.kind === "theme") {
      if (!isTheme(value)) return
      setTheme(value)
      refreshTheme((count) => count + 1)
      try { saveTheme(value) } catch { setStatus("Could not save theme", "warning") }
      return
    }
    if (open.kind === "palette") {
      const chosen = JSON.parse(value) as Palette.Value
      switch (chosen.kind) {
        case "file":
        case "hit": {
          const input = composer.current
          if (input === null) return
          const next = Palette.insertAt(
            input.plainText,
            input.cursorOffset,
            Palette.mention(chosen.path, chosen.kind === "hit" ? chosen.line : undefined)
          )
          setPanelFocus(false)
          return setText(next.text, next.cursor)
        }
        case "command": {
          const found = Editor.commands.find((each) => each.name === chosen.name)
          if (found !== undefined && Editor.takesArgument(found)) {
            // The command takes the composer; the draft comes back on the next submit.
            const draft = composer.current?.plainText ?? ""
            if (draft.trim() !== "") parkedDraft.current = draft
            setPanelFocus(false)
            return setText(`/${chosen.name} `)
          }
          // Run it beside the draft, never through the composer or its history.
          command(`/${chosen.name}`)
          return
        }
        case "session":
          return resumeGuarded(chosen.file)
        case "tab":
          setSurface(`tab:${chosen.id}`)
          setPanelFocus(true)
          setNavigation(Panels.initial())
          return
        case "prefix":
          return setPicker({ kind: "palette", query: chosen.prefix, selected: 0 })
        case "action":
          return perform(chosen.action)
      }
    }
    resumeGuarded(value)
  }, [switchSeat, openSession, forkSession, runUndo, setStatus, workspace, runs, setText, command])

  /** Keys while a flow form is open; its focused input takes the typing. */
  const formKey = (key: KeyEvent, open: FlowForm) => {
    const field = open.fields[open.focus]
    const move = (step: number) => {
      key.preventDefault()
      if (open.fields.length > 0) changeForm({ ...open, focus: (open.focus + step + open.fields.length) % open.fields.length })
    }
    if (key.name === "escape") {
      // Closes only; the run stays parked (`a` in its tab reopens, `x` stops it).
      key.preventDefault()
      return changeForm(undefined)
    }
    if ((key.name === "tab" && !key.shift) || key.name === "down") return move(1)
    if ((key.name === "tab" && key.shift) || key.name === "up") return move(-1)
    if (key.name === "space" && field?.kind === "boolean") {
      key.preventDefault()
      return changeForm({ ...open, draft: { ...open.draft, [field.name]: open.draft[field.name] !== true }, error: undefined })
    }
    if ((key.name === "left" || key.name === "right") && field?.kind === "select" && field.options !== undefined) {
      key.preventDefault()
      const options = field.options
      const at = options.indexOf(open.draft[field.name] ?? "")
      const next = options[(at + (key.name === "left" ? -1 : 1) + options.length) % options.length]!
      return changeForm({ ...open, draft: { ...open.draft, [field.name]: next }, error: undefined })
    }
    if (key.name === "return" || key.name === "kpenter") {
      key.preventDefault()
      const schema = runs.schema(open.id)
      const run = runs.get(open.id)
      if (schema === undefined || run === undefined) return changeForm(undefined)
      const result = Form.payload(schema, open.fields, run.input, open.draft)
      if ("error" in result) return changeForm({ ...open, error: result.error })
      changeForm(undefined)
      runs.fill(open.id, result.payload)
    }
  }

  /** Keys while a dialog is open: its filter input takes the typing, these move and pick. */
  const dialogKey = (key: KeyEvent, open: Picker) => {
    const move = (step: number) => {
      key.preventDefault()
      if (rows.length > 0) setPicker((current) => current === undefined ? current : { ...current, selected: (current.selected + step + rows.length) % rows.length })
    }
    if (key.name === "escape") return setPicker(undefined)
    if (key.name === "up" || (key.ctrl && key.name === "p")) return move(-1)
    if (key.name === "down" || (key.ctrl && key.name === "n")) return move(1)
    if (key.name === "pageup") return move(-Math.min(10, open.selected))
    if (key.name === "pagedown") return move(Math.min(10, rows.length - 1 - open.selected))
    if (key.name === "return" || key.name === "kpenter") {
      key.preventDefault()
      const row = rows[open.selected]
      if (row !== undefined) pick(open, row.value)
    }
  }

  /** Keys while the completion menu is open; true when the menu took the key. */
  const menuKey = (key: KeyEvent, open: Complete.Completion): boolean => {
    const count = open.items.length
    const move = (step: number) => {
      key.preventDefault()
      if (count > 0) setMenuIndex((index) => (index + step + count) % count)
      return true
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) return move(-1)
    if (key.name === "down" || (key.ctrl && key.name === "n")) return move(1)
    if (key.name === "escape") {
      key.preventDefault()
      setMenuDismissed(true)
      return true
    }
    if (count === 0) return false
    if (key.name === "tab" && !key.shift) {
      key.preventDefault()
      acceptCompletion(false)
      return true
    }
    if ((key.name === "return" || key.name === "kpenter") && !key.shift && !key.meta && !key.option) {
      key.preventDefault()
      acceptCompletion(true)
      return true
    }
    return false
  }

  /** Which keys act right now, in the order `handleKey` tries them. */
  const keyContext = (): Keys.KeyContext => {
    if (live.current.picker !== undefined) return "picker"
    if (activeInspection !== undefined) return "selection"
    if (liveForm.current !== undefined) return "form"
    if (live.current.approvals.length > 0 && composer.current?.plainText === "") return "approval"
    if (panelFocus && panel !== undefined) return "panel"
    if (live.current.menu !== undefined) return "completion"
    if (focusedCard !== undefined) return "card"
    if (live.current.shell !== undefined || composer.current?.plainText.startsWith("!") === true) return "shell"
    if (live.current.turn !== undefined) return "working"
    return "composer"
  }

  const handleKey = (key: KeyEvent): void => {
    const { turn: running, shell: shellRunning, picker: open, menu: completing } = live.current
    const text = composer.current?.plainText ?? ""
    // `?` on an empty composer opens the key panel. Any key closes it: esc and
    // `?` only close, a listed key then acts, and other typing becomes `?` plus
    // that character, so a message that starts with `?` is never lost.
    if (whichKeyRef.current) {
      setWhichKeyOpen(false)
      const binding = Keys.bindingFor(key, keyContext(), merged)
      if (key.name === "escape" || binding?.id === "keys") return key.preventDefault()
      const typed = key.sequence
      if (binding === undefined && !key.ctrl && !key.meta && !key.option && typed.length === 1 && typed >= " " && typed !== "\x7f") {
        key.preventDefault()
        return setText(`?${typed}`)
      }
    } else if (key.name === "?" && text === "" && open === undefined && liveForm.current === undefined) {
      key.preventDefault()
      return setWhichKeyOpen(true)
    }
    if (key.ctrl && key.name === "t" && showActivity && monitored !== undefined && open === undefined) {
      key.preventDefault()
      if (activeInspection !== undefined) followLive()
      else inspectActivity(monitored.activity.records.at(-1)!.sequence!, false)
      return
    }
    if (activeInspection !== undefined && monitored !== undefined && open === undefined &&
      !key.ctrl && !key.meta && !key.option &&
      ["left", "right", "up", "down", "home", "end", "escape", "return", "[", "]"].includes(key.name)) {
      key.preventDefault()
      if (key.name === "escape" || key.name === "return") return followLive()
      // Shift steps milestone to milestone, the way brackets do.
      const name = key.shift && key.name === "left" ? "[" : key.shift && key.name === "right" ? "]" : key.name
      const next = Scrubber.key(monitored.activity, activeInspection.seq, name)
      if (next !== undefined) inspectActivity(next)
      return
    }
    if (focusedCard !== undefined && open === undefined && !key.ctrl && !key.meta && !key.option) {
      if (key.name === "return" || key.name === "kpenter") {
        key.preventDefault()
        setCardFocus(undefined)
        const row = timeline.find((each) => each.key === focusedCard)
        if (row?.item.kind !== "card") return
        const id = row.item.panel.id
        return perform({ kind: "open", surface: id.startsWith("flow:") ? id : `ui:${id}` })
      }
      if (key.name === "escape") {
        key.preventDefault()
        return setCardFocus(undefined)
      }
      if (key.name === "up" || key.name === "down" || key.name === "tab") {
        key.preventDefault()
        const back = key.name === "up" || (key.name === "tab" && key.shift)
        const next = cardKeys[(cardKeys.indexOf(focusedCard) + (back ? -1 : 1) + cardKeys.length) % cardKeys.length]!
        setCardFocus(next)
        return reveal(next)
      }
      // Anything else goes back to the composer.
      setCardFocus(undefined)
    } else if (
      key.name === "tab" && !key.shift && !key.ctrl && !key.meta && !key.option && text === "" &&
      open === undefined && completing === undefined && liveForm.current === undefined && cardKeys.length > 0 &&
      keyContext() === "composer"
    ) {
      key.preventDefault()
      const last = cardKeys.at(-1)!
      setCardFocus(last)
      return reveal(last)
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      const at = Date.now()
      if (at - lastCtrlC.current < Editor.exitWindowMs) return quit()
      lastCtrlC.current = at
      if (open !== undefined) setPicker(undefined)
      setPanelFocus(false)
      setCardFocus(undefined)
      setText("")
      return
    }
    const filling = liveForm.current
    if (filling !== undefined && open === undefined) {
      // Palette, summary and tab switching still work: they close the form and leave the run parked.
      if (!(key.ctrl && ["k", "s", "left", "right", "]", "\\"].includes(key.name))) return formKey(key, filling)
      changeForm(undefined)
    }
    if (key.ctrl && key.name === "k") {
      // Also keeps the composer's default Ctrl+K (delete to line end) from firing.
      key.preventDefault()
      setPicker(open?.kind === "palette" ? undefined : { kind: "palette", query: "", selected: 0 })
      return
    }
    if (key.ctrl && key.name === "s") {
      key.preventDefault()
      if (!focusMain) setSurface(surface === "chat" ? "summary" : surface)
      setPanelFocus(!panelFocus)
      return
    }
    if (focusMain && key.ctrl && key.name === "\\") {
      key.preventDefault()
      showTab("chat")
      return
    }
    if (
      (key.ctrl && ["right", "left", "]", "\\"].includes(key.name)) || (key.name === "tab" && panelFocus && !key.shift)
    ) {
      key.preventDefault()
      const index = surfaces.findIndex((tab) => tab.id === surface)
      const back = key.name === "left" || key.name === "\\"
      showTab(surfaces[(index + (back ? -1 : 1) + surfaces.length) % surfaces.length]!.id)
      return
    }
    // Contributed keys never shadow a built-in one (`Contributions` refused those), and a
    // panel key works only on its owner's own view.
    const contributed = open === undefined && liveForm.current === undefined
      ? Keys.bindingFor(key, keyContext(), merged)
      : undefined
    if (contributed?.action !== undefined && (contributed.context !== "panel" || ownerOf(surface) === contributed.owner)) {
      key.preventDefault()
      return perform(contributed.action)
    }
    const choice = Approvals.key(key.name, {
      draft: text,
      shift: key.shift,
      ctrl: key.ctrl,
      meta: key.meta || key.option,
      armed: open === undefined && Approvals.armed(arming.current, live.current.approvals[0]?.requestId, live.current.now),
      pending: live.current.approvals,
      reserved: panelKeys
    })
    if (choice !== undefined && props.host.approvals !== undefined) {
      key.preventDefault()
      const [first, ...rest] = live.current.approvals
      const requestId = first!.requestId
      answered.current.add(requestId)
      arming.current = Approvals.answered(requestId)
      live.current.approvals = rest
      setApprovals(rest)
      // A refused answer leaves the call waiting: show its row again.
      const retry = (code: string) => {
        answered.current.delete(requestId)
        arming.current = Approvals.failed(arming.current, requestId)
        setStatus(`Approval failed: ${code}`, "warning")
      }
      props.host.approvals.reply(first!, choice).then(
        (code) => code === undefined ? undefined : retry(code),
        (error) => retry(String(error))
      )
      return
    }
    if (panelFocus && panel !== undefined && open === undefined && !key.ctrl && !key.meta && !key.option) {
      key.preventDefault()
      if (key.name === "escape") {
        setSurface("chat")
        setPanelFocus(false)
        return
      }
      if (key.name === "i") {
        setPanelFocus(false)
        return
      }
      if (key.name === "r" && (surface.startsWith("tab:") || surface.startsWith("flow:"))) {
        try {
          if (surface.startsWith("flow:")) runs.retry(surface.slice(5))
          else workspace.retry(surface.slice(4))
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), "warning")
        }
        return
      }
      if (key.name === "m" && surface.startsWith("tab:")) {
        setPicker({ kind: "worker-model", id: surface.slice(4), query: "", selected: 0 })
        return
      }
      if (key.name === "w" && surface.startsWith("tab:")) {
        try { workspace.waitForReset(surface.slice(4)) }
        catch (error) { setStatus(error instanceof Error ? error.message : String(error), "warning") }
        return
      }
      if (key.name === "x" && (surface.startsWith("tab:") || surface.startsWith("flow:"))) {
        if (surface.startsWith("flow:")) runs.cancel(surface.slice(5))
        else workspace.cancel(surface.slice(4))
        return
      }
      if (key.name === "a" && surface.startsWith("flow:")) return openForm(surface.slice(5))
      if (key.name === "u" && (surface === "summary" || surface.startsWith("tab:"))) {
        const current = live.current
        if (current.turn !== undefined || current.shell !== undefined || current.undoing !== undefined || workspace.busy || runs.busy) {
          return setStatus(Undo.message({ _tag: "Busy" }), "warning")
        }
        const row = panel.rows[Math.min(navigation.selected, panel.rows.length - 1)]
        const tab = surface.startsWith("tab:") ? surface.slice(4) : undefined
        const found = row === undefined
          ? { _tag: "NothingToUndo" as const }
          : Undo.target(tab === undefined ? transcript : workspace.transcript(tab), row.id)
        if ("_tag" in found) {
          return setStatus(
            Undo.message(found),
            found._tag === "NothingToUndo" || found._tag === "AlreadyUndone" ? "warning" : "danger"
          )
        }
        return setPicker({ kind: "undo", query: "", selected: 0, target: found, ...(tab === undefined ? {} : { tab }) })
      }
      if (key.name === "a") {
        const action = panel.rows[Math.min(navigation.selected, panel.rows.length - 1)]?.action
        if (action === undefined) return
        // An agent wrote this prompt: it goes to the agent as text, never through `!` or `/` parsing.
        if ("prompt" in action) {
          if (action.prompt.trim() === "") return
          setPanelFocus(false)
          return send(action.prompt.trim())
        }
        return perform(action.action)
      }
      if (key.name === "pageup" || key.name === "pagedown") {
        panelScroll.current?.(key.name === "pageup" ? -1 : 1)
        return
      }
      setNavigation((current) => Panels.navigate(current, key.name, panel.rows))
      return
    }
    if (open !== undefined) return dialogKey(key, open)
    if (completing !== undefined && menuKey(key, completing)) return
    if (key.name === "escape") {
      if (running !== undefined) {
        restoreQueued(running.steering.take())
        return running.handle.cancel()
      }
      if (shellRunning !== undefined) return shellRunning.cancel()
      if (text.startsWith("!")) return setText("")
      return
    }
    if (key.ctrl && key.name === "d") {
      if (text === "") {
        key.preventDefault()
        quit()
      }
      return
    }
    if ((key.meta || key.option) && (key.name === "return" || key.name === "enter")) {
      key.preventDefault()
      return submit(true)
    }
    if ((key.meta || key.option) && key.name === "up") {
      key.preventDefault()
      return restoreQueued()
    }
    if (key.name === "tab" && key.shift) {
      key.preventDefault()
      const next = Editor.nextThinking(live.current.thinking)
      setThinking(next)
      setStatus(`Thinking level: ${next ?? "default"}`)
      return
    }
    if (key.ctrl && key.name === "l") return setPicker({ kind: "model", query: "", selected: 0 })
    if (key.ctrl && key.name === "p") return cycleModel(key.shift ? -1 : 1)
    if (key.ctrl && key.name === "o") return setExpanded((value) => !value)
    if (key.ctrl && key.name === "g") return externalEditor()
    if (key.shift && (key.name === "up" || key.name === "down")) {
      key.preventDefault()
      return scroll.current?.scrollBy(key.name === "up" ? -1 : 1)
    }
    if (key.name === "pageup") return scroll.current?.scrollBy(-0.5, "viewport")
    if (key.name === "pagedown") return scroll.current?.scrollBy(0.5, "viewport")
    // History only from an empty editor or while already browsing (pi's rule).
    if (key.name === "up" && !key.ctrl && (text === "" || history.current.browsing)) {
      const older = history.current.up(text)
      if (older !== undefined) {
        key.preventDefault()
        setText(older)
      }
      return
    }
    if (key.name === "down" && !key.ctrl && history.current.browsing) {
      const newer = history.current.down()
      if (newer !== undefined) {
        key.preventDefault()
        setText(newer)
      }
    }
  }

  useKeyboard(handleKey)

  const working = turn !== undefined
  const tick = spinner[Math.floor(now / 100) % spinner.length]!
  const model = props.models.find((each) => each.seat === seat)
  const label = model?.label ?? (seat.startsWith("replay:") ? `replay ${basename(seat)}` : seat)
  const bashMode = draft.startsWith("!")
  const window = props.contextWindow(seat)
  const percent = window > 0 ? (transcript.usage.context / window) * 100 : 0
  useEffect(() => {
    let active = true
    setCompact(undefined)
    void props.host.compaction(transcript.usage.context, window).then((amount) => {
      if (active) setCompact(amount)
    })
    return () => { active = false }
  }, [props.host, transcript.usage.context, window, writer.current.file])
  const usage = transcript.usage
  const activeTabs = snapshot.tabs.filter((tab) =>
    tab.status === "queued" || tab.status === "requested" || tab.status === "running" || tab.status === "waiting" || tab.status === "parked"
  )
  const sideChat = focusMain && dimensions.width >= 120
  const showSidebar = dimensions.width >= 100 && activeTabs.length > 0 && (!focusMain || sideChat)
  const width = sideChat ? 40 : Math.max(20, Math.min(columnWidth, dimensions.width - 2 - (showSidebar ? 24 : 0)))
  const mainWidth = Math.max(20, dimensions.width - width - (showSidebar ? 24 : 0) - 2)
  const accent = bashMode ? color.success : working ? color.faint : color.brand
  const tabsWidth = width - (focusMain ? 6 : 0)
  const tabCount = Math.max(1, Math.floor(tabsWidth / 24))
  const tabTitleWidth = Math.min(22, Math.max(1, Math.floor(tabsWidth / tabCount) - 2))
  const firstTab = Math.max(
    0,
    Math.min(surfaces.findIndex((tab) => tab.id === surface) - Math.floor(tabCount / 2), surfaces.length - tabCount)
  )
  const visibleTabs = surfaces.slice(firstTab, firstTab + tabCount)
  const footerContext = keyContext()
  const footerHints = footerContext === "panel" && panel !== undefined
    ? [
      ...Keys.panelHints({
        worker: surface.startsWith("tab:") || surface.startsWith("flow:"),
        undo: surface === "summary" || surface.startsWith("tab:"),
        action: panel.rows[Math.max(0, Math.min(navigation.selected, panel.rows.length - 1))]?.action?.label
      }),
      // A contributed panel key works only on its owner's view; a global one works here too.
      ...Keys.hintsFor("panel", merged).filter((binding) =>
        binding.owner !== undefined && (binding.context !== "panel" || binding.owner === ownerOf(surface))
      )
    ]
    : Keys.hintsFor(footerContext, merged)
  const meter = {
    context: transcript.contextAssessment?.outdated || transcript.contextAssessment?.irrelevant
      ? `context: ${[
        transcript.contextAssessment.outdated ? "outdated" : "",
        transcript.contextAssessment.irrelevant ? "irrelevant" : ""
      ].filter(Boolean).join(" + ")} · compact?  `
      : "",
    usage: `↑${Editor.tokens(usage.input)} ↓${Editor.tokens(usage.output)}${usage.cached === 0 ? "" : ` R${Editor.tokens(usage.cached)}`}`,
    window: window > 0
      ? `  ${percent.toFixed(1)}%/${Editor.tokens(window)}${compact === undefined ? "" : ` · compact ${Editor.tokens(compact)}`}`
      : ""
  }
  // The hints get the row less its padding, the margins, the status items and the meter; the path gives way first.
  const hintColumns = width - 5 -
    statusItems.reduce((total, item) => total + Bun.stringWidth(item.text) + 2, 0) -
    Bun.stringWidth(meter.context + meter.usage + meter.window)
  const toastRows = [
    ...snapshot.tabs.filter((tab) =>
      now - tab.startedAt >= 300 && (tab.endedAt === undefined || now - tab.endedAt < 3000)
    ).map((tab) => ({
      id: tab.id,
      text: `${
        tab.status === "running" || tab.status === "requested" || tab.status === "waiting"
          ? tick
          : tab.status === "parked"
          ? "⏸"
          : tab.status === "queued"
          ? "…"
          : tab.status === "done"
          ? "✓"
          : "✗"
      } ${approvals.some((request) => request.source === tab.id) ? `${tabTitle(tab)} · approval` : tabToast(tab)}`,
      tone: tab.status === "failed" ? "danger" as const : "info" as const
    })),
    ...flowRuns.filter((run) =>
      run.status === "input" || now - run.startedAt >= 300 && (run.endedAt === undefined || now - run.endedAt < 3000)
    ).map((run) => ({
      id: `flow:${run.id}`,
      text: `${flowRunning(run) ? `${tick} ` : flowGlyph(run.status)}${run.flow} · ${run.status}`,
      tone: run.status === "failed" ? "danger" as const : "info" as const
    })),
    ...(search?.status === "running" && now - search.startedAt >= 300
      ? [{ id: "search", text: `${tick} text: ${search.query}`, tone: "info" as const }]
      : []),
    ...(undoing !== undefined && now - undoing >= 300
      ? [{ id: "undo", text: `${tick} Undoing`, tone: "info" as const }]
      : []),
    ...(toast === undefined ? [] : [{ id: "notice", ...toast }])
  ]
  const toastWidth = Math.min(60, mainWidth - 2)
  const toastHeight = Math.min(Math.floor(dimensions.height / 2), Math.max(1, toastRows.length * 3))

  return (
    <box style={{ width: "100%", height: "100%", alignItems: "center" }} backgroundColor={color.page} {...dragScroll}>
      <box style={{ flexDirection: focusMain && !sideChat ? "column" : "row", width: "100%", height: "100%", justifyContent: "center" }}>
        {showSidebar ? (
          <box style={{ width: 22, marginRight: 2, paddingTop: 1, flexDirection: "column", flexShrink: 0 }}>
            {activeTabs.map((tab) => {
              const name = tab.description ?? tab.title
              const time = eta(Estimate.tabId(tab), tab.status, Estimate.tabStart(tab)).trim()
              const room = time === "" ? 22 : 21 - time.length
              const shown = name.length > room ? `${name.slice(0, room - 1)}…` : name
              return (
                <text key={tab.id} wrapMode="none" fg={surface === `tab:${tab.id}` ? color.brand : color.faint}
                  onMouseDown={() => clickTab(`tab:${tab.id}`)}>
                  {shown}
                  {time === "" ? null : <span fg={color.faint}>{" ".repeat(22 - shown.length - time.length)}{time}</span>}
                </text>
              )
            })}
          </box>
        ) : null}
      {focusMain && panel !== undefined ? (
        <box style={{ flexDirection: "column", width: sideChat ? mainWidth : "100%", height: sideChat ? "100%" : "45%", paddingTop: 1, paddingLeft: 1, flexShrink: 0 }}>
          <text fg={color.brand} style={{ marginBottom: 1 }}>{panel.title}</text>
          <PanelView panel={panel} navigation={navigation} height={sideChat ? dimensions.height - 4 : Math.floor(dimensions.height * 0.45) - 3}
            width={sideChat ? mainWidth : dimensions.width - 2} scrollRef={panelScroll} />
        </box>
      ) : null}
      <box style={{ flexDirection: "column", height: focusMain && !sideChat ? "55%" : "100%", width, paddingTop: 1 }}>
        <box style={{ flexDirection: "row", flexShrink: 0, marginBottom: 1, width }}>
          {focusMain ? <text fg={color.brand} style={{ flexShrink: 0 }}>Chat  </text> : null}
          {visibleTabs.map((tab) => (
            <text key={tab.id} wrapMode="none" fg={surface === tab.id ? color.brand : color.faint} onMouseDown={() => clickTab(tab.id)}>
              {" "}{tab.title.length > tabTitleWidth ? `${tab.title.slice(0, tabTitleWidth - 1)}…` : tab.title}{" "}
            </text>
          ))}
          {Timeline.active(filter) && surface === "chat"
            ? <text fg={color.warning} wrapMode="none" style={{ flexShrink: 0 }}>{filter.query === "" ? " filtered" : ` grep ${filter.query}`}</text>
            : null}
        </box>
        {panel !== undefined && !focusMain ?
          (<>
            {surface.startsWith("tab:") ? (() => {
              const tab = snapshot.tabs.find((entry) => entry.id === surface.slice(4))
              return tab?.status === "failed"
                ? <FailureCard tab={tab} transcript={workspace.transcript(tab.id)} details={expanded} />
                : null
            })() : null}
            <PanelView
              panel={panel}
              navigation={navigation}
              height={dimensions.height - 10}
              width={width}
              scrollRef={panelScroll}
              hideSummary={surface.startsWith("tab:") && snapshot.tabs.some((tab) => tab.id === surface.slice(4) && tab.status === "failed")}
            />
          </>) :
          timeline.length === 0 && !Timeline.active(filter)
          ? <View.Home expanded={expanded} />
          : (
            <scrollbox
              ref={scroll}
              stickyScroll
              stickyStart="bottom"
              style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, scrollbarOptions: { visible: false } }}
            >
              {timeline.map((row, index) => {
                const worker = lanes.get(row.source)
                const card = row.item.kind === "card" ? livePanel(row.item.panel) : undefined
                const step = row.item.kind === "cell" ? Scrubber.step(transcriptOf(row.source), row.item) : undefined
                const entry = card !== undefined
                  ? <View.Card panel={card} focused={row.key === focusedCard} onOpen={() => perform({ kind: "open", surface: card.id.startsWith("flow:") ? card.id : `ui:${card.id}` })} />
                  : <View.Entry item={row.item} now={now} tick={tick} expanded={expanded} selected={row.key === jumpTarget}
                    {...(step === undefined ? {} : { step })} {...(worker === undefined ? {} : { tone: worker.tone })} />
                return worker === undefined
                  ? <box key={row.key} id={row.key}>{entry}</box>
                  : (
                    <View.Lane key={row.key} id={row.key} title={worker.title} tone={worker.tone} first={timeline[index - 1]?.source !== row.source}>
                      {entry}
                    </View.Lane>
                  )
              })}
              {working && transcript.thinking
                ? <text fg={color.muted} style={{ paddingLeft: 2 }}>{tick} thinking</text>
                : null}
            </scrollbox>
          )}
        {!showActivity || monitored === undefined ? null :
          <ActivityView activity={monitored.activity} width={width} now={now} title={monitored.title}
            focused={activeInspection !== undefined} cursor={activeInspection?.seq} onSelect={inspectActivity}
            onPause={() => activeInspection !== undefined ? followLive() : inspectActivity(monitored.activity.records.at(-1)!.sequence!, false)} />}
        {followUps.length === 0 ? null : (
          <box style={{ marginTop: 1, paddingLeft: 2, flexShrink: 0 }}>
            {followUps.map((text, index) => <text key={index} fg={color.muted}>Follow-up: {text.split("\n")[0]}</text>)}
            <text fg={color.faint}>↳ alt+up to edit all queued messages</text>
          </box>
        )}
        {form === undefined ? null : (
          <box style={{ border: ["left"], marginTop: 1, flexShrink: 0 }} borderColor={color.brand} customBorderChars={View.bar}>
            <box style={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }} backgroundColor={color.element}>
              <text fg={color.text} wrapMode="none">{form.flow}</text>
              {form.fields.map((field, index) => {
                const value = form.draft[field.name]
                const focused = index === form.focus
                return (
                  <box key={field.name} style={{ flexDirection: "row" }}>
                    <text fg={focused ? color.brand : color.muted} wrapMode="none" style={{ width: 16, flexShrink: 0 }}>
                      {field.label}
                    </text>
                    {focused && (field.kind === "text" || field.kind === "number")
                      ? (
                        <input
                          focused
                          value={value === undefined ? "" : String(value)}
                          textColor={color.text}
                          backgroundColor={color.surface}
                          focusedBackgroundColor={color.surface}
                          cursorColor={color.brand}
                          style={{ flexGrow: 1 }}
                          onInput={(text: string) => {
                            const current = liveForm.current
                            if (current !== undefined) {
                              changeForm({ ...current, draft: { ...current.draft, [field.name]: text }, error: undefined })
                            }
                          }}
                        />
                      )
                      : (
                        <text fg={color.text} wrapMode="none">
                          {field.kind === "boolean" ? (value === true ? "✓" : "✗") : value === undefined ? "" : String(value)}
                        </text>
                      )}
                  </box>
                )
              })}
              {form.error === undefined ? null : <text fg={color.danger}>{form.error}</text>}
            </box>
          </box>
        )}
        {menu === undefined || panelFocus || form !== undefined ?
          null :
          (
            <box
              style={{ border: ["left"], marginTop: 1, flexShrink: 0 }}
              borderColor={color.element}
              customBorderChars={View.bar}
            >
              <box style={{ paddingTop: 0 }} backgroundColor={color.element}>
                <View.List
                  rows={menu.items.map((item, index) => ({
                    key: `${index}:${item.label}`,
                    label: item.label,
                    ...(item.hint === undefined ? {} : { hint: item.hint }),
                    ...(item.detail === undefined ? {} : { detail: item.detail }),
                    ...(menu.kind === "argument" &&
                        (item.insert === `/model ${seat}` || item.insert === `/thinking ${thinking ?? "default"}`)
                      ? { current: true }
                      : {})
                  }))}
                  selected={menuIndex}
                  height={Math.min(menuRows, Math.max(1, menu.items.length))}
                  background={color.element}
                  empty={menu.kind === "command" ? "No matching commands" : "No matches"}
                />
              </box>
            </box>
          )}
        {approvals[0] === undefined ? null : (
          <View.Approval
            request={approvals[0]}
            scope={Approvals.scope(approvals[0])}
            all={!panelKeys.includes("a")}
            armed={picker === undefined && form === undefined && Approvals.ready(arming.current, approvals[0].requestId, now, draft)}
            more={approvals.length - 1}
            {...(approvals[0].source === "chat"
              ? {}
              : { worker: snapshot.tabs.find((tab) => tab.id === approvals[0]!.source)?.title ??
                flowRuns.find((run) => `flow:${run.id}` === approvals[0]!.source)?.flow ?? approvals[0].source })}
          />
        )}
        <box
          style={{ border: ["left"], marginTop: 1, flexShrink: 0 }}
          borderColor={accent}
          customBorderChars={View.bar}
        >
          <box style={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1 }} backgroundColor={color.surface}>
            <textarea
              ref={composer}
              focused={picker === undefined && !panelFocus && form === undefined}
              placeholder={working
                ? "Steer, or alt+enter to queue"
                : "Ask Smithers to change this repository"}
              placeholderColor={color.faint}
              textColor={color.text}
              focusedTextColor={color.text}
              backgroundColor={color.surface}
              focusedBackgroundColor={color.surface}
              cursorColor={color.brand}
              keyBindings={composerKeys}
              onSubmit={() => submit(false)}
              onContentChange={() => {
                arming.current = Approvals.edited(arming.current, Date.now())
                setDraft(composer.current?.plainText ?? "")
                setCursor(composer.current?.cursorOffset ?? 0)
                setMenuDismissed(false)
              }}
              onCursorChange={() => setCursor(composer.current?.cursorOffset ?? 0)}
              style={{ minHeight: 1, maxHeight: Math.max(6, Math.floor(dimensions.height / 3)) }}
            />
            <text style={{ marginTop: 1, marginBottom: 1 }}>
              {bashMode
                ? (
                  <>
                    <span fg={color.success}>{"shell"}</span>
                    <span fg={color.faint}>{"  ·  "}</span>
                  </>
                )
                : null}
              <span fg={color.text}>{label}</span>
              {model === undefined ? null : <span fg={color.faint}>{" "}{model.provider}</span>}
              {thinking === undefined ? null : <span fg={color.warning}>{"  "}{thinking}</span>}
            </text>
          </box>
        </box>
        <box
          style={{ flexDirection: "row", justifyContent: "space-between", height: 1, paddingLeft: 1, flexShrink: 0 }}
        >
          <box style={{ flexDirection: "row", flexShrink: 1, marginRight: 2 }}>
            {/* The path gives way before the hints do. */}
            <text wrapMode="none" style={{ flexShrink: 100, marginRight: 2 }}>
              {working
                ? (
                  <>
                    <span fg={color.brand}>{tick} {Transcript.duration(now - turn.startedAt)}</span>
                    <span fg={color.faint}>{eta(turn.estimate, "running", turn.startedAt)}</span>
                  </>
                )
                : (
                  <span fg={color.faint}>
                    {props.host.cwd.replace(homedir(), "~")}
                    {props.branch === undefined ? "" : ` (${props.branch})`}
                    {name === undefined ? "" : ` • ${name}`}
                  </span>
                )}
            </text>
            <View.KeyHints bindings={Keys.fit(footerHints, hintColumns, Bun.stringWidth)} />
          </box>
          <box style={{ flexDirection: "row", flexShrink: 0 }}>
          <View.StatusItems items={statusItems} onSelect={(item) => item.action === undefined ? undefined : perform(item.action)} />
          <text wrapMode="none" style={{ flexShrink: 0 }}>
            {meter.context === "" ? null : <span fg={color.warning}>{meter.context}</span>}
            <span fg={color.faint}>{meter.usage}</span>
            {meter.window === "" ? null : (
              <span fg={percent > 90 ? color.danger : percent > 70 ? color.warning : color.faint}>{meter.window}</span>
            )}
          </text>
          </box>
        </box>
      </box>
      </box>
      {whichKey ? <View.KeyPopup bindings={Keys.bindingsFor(footerContext, merged)} width={dimensions.width} height={dimensions.height} /> : null}
      {sideChat
        ? toastRows.length === 0 ? null : <box style={{ position: "absolute", left: mainWidth - toastWidth,
          top: dimensions.height - toastHeight - 2, width: toastWidth, height: toastHeight }}>
          <View.ToastStack rows={toastRows} />
        </box>
        : <View.ToastStack rows={toastRows} />}
      {picker === undefined ? null : (
        <View.Dialog
          title={picker.kind === "model" || picker.kind === "worker-model"
            ? "Select model"
            : picker.kind === "theme"
            ? "Select theme"
            : picker.kind === "flows"
            ? "Flows"
            : picker.kind === "agents"
            ? "Agents"
            : picker.kind === "filter"
            ? "Filter chat"
            : picker.kind === "palette"
            ? parsedPalette?.mode === "text" && search?.truncated === true ? `Search · first ${Search.limit}` : "Search"
            : picker.kind === "fork"
            ? "Fork from message"
            : picker.kind === "undo"
            ? `Undo ${picker.target.paths.length === 1 ? picker.target.paths[0] : `${picker.target.paths.length} files`}?`
            : "Resume session"}
          width={Math.min(72, dimensions.width - 4)}
          height={dimensions.height}
        >
          {picker.kind === "undo" ? null : (
          <box style={{ paddingLeft: 3, paddingRight: 3, marginBottom: 1 }}>
            <input
              focused
              value={picker.query}
              placeholder="Search"
              placeholderColor={color.faint}
              textColor={color.text}
              backgroundColor={color.surface}
              focusedBackgroundColor={color.surface}
              cursorColor={color.brand}
              onInput={(query: string) =>
                setPicker((current) => (current === undefined || current.kind === "undo" ? current : { ...current, query, selected: 0 }))}
            />
          </box>
          )}
          <box style={{ paddingLeft: 2, paddingRight: 2 }}>
            <View.List
              rows={rows}
              selected={picker.selected}
              height={Math.min(rows.length, Math.max(3, Math.floor(dimensions.height / 2) - 6))}
              background={color.surface}
              empty={picker.kind === "resume"
                ? "No sessions in this directory"
                : picker.kind === "flows"
                ? runs.failure()?.message ?? (runs.opening ? "Opening flows" : "No flows")
                : picker.kind === "agents"
                ? "No agents"
                : picker.kind === "palette"
                ? search?.status === "running" ? "Searching" : "No matches"
                : picker.kind === "fork"
                ? `No messages match "${picker.query}"`
                : `No ${picker.kind} matches "${picker.query}"`}
            />
          </box>
        </View.Dialog>
      )}
    </box>
  )
}
