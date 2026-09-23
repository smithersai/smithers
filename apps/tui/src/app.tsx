/**
 * The terminal UI: a transcript of cells above a composer.
 *
 * Keys and commands follow pi (`badlogic/pi-mono` coding-agent) wherever the
 * cell harness has the same idea; `editor.ts` lists them. `view.tsx` draws.
 */
import type { KeyBinding, KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Clipboard from "./clipboard.ts"
import * as Complete from "./complete.ts"
import type * as Context from "./context.ts"
import * as Editor from "./editor.ts"
import * as Files from "./files.ts"
import * as Fuzzy from "./fuzzy.ts"
import type * as Host from "./host.ts"
import type { Model } from "./models.ts"
import { PanelView } from "./panel-view.tsx"
import * as Panels from "./panels.ts"
import * as Session from "./session.ts"
import * as Shell from "./shell.ts"
import * as Steering from "./steering.ts"
import * as Summary from "./summary.ts"
import { activeTheme, color, isTheme, loadTheme, saveTheme, setTheme, spinner, themes } from "./theme.ts"
import * as Transcript from "./transcript.ts"
import * as View from "./view.tsx"
import { Workspace } from "./workspace.ts"

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
  readonly models: ReadonlyArray<Model>
  readonly contextWindow: (seat: string) => number
  /** A session file to continue, or undefined for a new one. */
  readonly resume?: string
  /** Open the session picker at start (`--resume`). */
  readonly pickSession?: boolean
  readonly branch?: string
}

interface TurnState {
  readonly handle: Host.Turn
  readonly startedAt: number
  readonly steering: Steering.Queue
}

type Picker =
  | { readonly kind: "model"; readonly query: string; readonly selected: number }
  | { readonly kind: "theme"; readonly query: string; readonly selected: number }
  | {
    readonly kind: "resume"
    readonly query: string
    readonly selected: number
    readonly sessions: ReadonlyArray<Session.Summary>
  }

interface Toast {
  readonly text: string
  readonly tone: "info" | "warning" | "danger"
}

/** A dialog's rows and the value each one picks. */
const pickerRows = (
  picker: Picker,
  models: ReadonlyArray<Model>,
  seat: string
): ReadonlyArray<View.Row & { readonly value: string }> => {
  if (picker.kind === "theme") return Fuzzy.filter(Object.keys(themes), picker.query, (name) => name).map((name) => ({
    key: name, label: name, current: name === activeTheme(), value: name
  }))
  if (picker.kind === "model") {
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
  const now = Date.now()
  return Fuzzy.filter(picker.sessions, picker.query, (session) => `${session.name ?? ""} ${session.firstPrompt}`).map((
    session
  ) => ({
    key: session.file,
    label: (session.name ?? session.firstPrompt).split("\n")[0]!.slice(0, 60),
    detail: View.ago(session.modified, now),
    value: session.file
  }))
}

export function App(props: AppProps) {
  const renderer = useRenderer()
  const [, refreshTheme] = useState(0)
  useState(() => setTheme(loadTheme()))
  const [restored] = useState(() => ({
    current: props.resume === undefined ? undefined : Session.restore(Session.load(props.resume))
  }))
  const [transcript, setTranscript] = useState(restored.current?.transcript ?? Transcript.empty)
  const [seat, setSeat] = useState(props.seat)
  const [thinking, setThinking] = useState<Editor.Thinking>(undefined)
  const [turn, setTurn] = useState<TurnState | undefined>()
  const [shell, setShell] = useState<Shell.Running | undefined>()
  const [followUps, setFollowUps] = useState<ReadonlyArray<string>>([])
  const [picker, setPicker] = useState<Picker | undefined>(
    props.pickSession === true
      ? { kind: "resume", query: "", selected: 0, sessions: Session.list(props.host.cwd) }
      : undefined
  )
  const [expanded, setExpanded] = useState(false)
  const [toast, setToast] = useState<Toast | undefined>()
  const [draft, setDraft] = useState("")
  const [cursor, setCursor] = useState(0)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  const [name, setName] = useState(restored.current?.name)
  const [now, setNow] = useState(Date.now())
  const entries = useRef<Array<Context.Entry>>(restored.current?.entries ?? [])
  const history = useRef(new Editor.History(restored.current?.prompts ?? []))
  const writer = useRef<Session.Writer>(
    props.resume === undefined ? Session.create(props.host.cwd) : Session.reopen(props.resume)
  )
  const [workspace, setWorkspace] = useState(() =>
    new Workspace({
      host: props.host,
      workerSeat: props.workerSeat ?? props.seat,
      history: () => entries.current,
      persist: writer.current.append,
      restored: restored.current?.workspace
    })
  )
  const [revision, setRevision] = useState(0)
  const [surface, setSurface] = useState("chat")
  const [panelFocus, setPanelFocus] = useState(false)
  const [navigation, setNavigation] = useState(Panels.initial)
  useEffect(() => workspace.subscribe(() => setRevision((value) => value + 1)), [workspace])
  useEffect(() => () => workspace.dispose(), [workspace])
  const snapshot = workspace.snapshot()
  const surfaces = [
    { id: "chat", title: "Chat" },
    { id: "summary", title: "Summary" },
    ...snapshot.tabs.map((tab) => ({
      id: `tab:${tab.id}`,
      title: `${
        tab.status === "running" || tab.status === "requested"
          ? "◌ "
          : tab.status === "failed"
          ? "✗ "
          : tab.status === "done"
          ? "✓ "
          : "■ "
      }${tab.title}`
    })),
    ...snapshot.panels.map((panel) => ({ id: `ui:${panel.id}`, title: panel.title }))
  ]
  const panel = surface === "summary"
    ? Summary.panel(transcript)
    : surface.startsWith("tab:")
    ? workspace.panel(surface.slice(4))
    : snapshot.panels.find((panel) => `ui:${panel.id}` === surface)
  const panelScroll = useRef<((direction: number) => void) | undefined>(undefined)
  const composer = useRef<TextareaRenderable>(null)
  const scroll = useRef<ScrollBoxRenderable>(null)
  const lastCtrlC = useRef(0)
  const files = useRef(Files.lister(props.host.cwd))
  const dimensions = useTerminalDimensions()
  const setStatus = useCallback((text: string, tone: Toast["tone"] = "info") => setToast({ text, tone }), [])

  const completion = useMemo(
    () => (menuDismissed
      ? undefined
      : Complete.complete(draft, cursor, { models: props.models, files: () => files.current() })),
    [draft, cursor, menuDismissed, props.models]
  )
  const menu = completion !== undefined && (completion.items.length > 0 || completion.kind !== "file")
    ? completion
    : undefined
  const menuIdentity = menu === undefined ? "" : `${menu.kind}:${menu.query}`
  useEffect(() => setMenuIndex(0), [menuIdentity])

  // Key handlers read the latest values through these, never a stale render.
  const live = useRef({ turn, shell, followUps, seat, thinking, picker, menu, menuIndex })
  live.current = { turn, shell, followUps, seat, thinking, picker, menu, menuIndex }

  useEffect(() => {
    renderer.setTerminalTitle(`smithers - ${basename(props.host.cwd)}`)
  }, [renderer, props.host.cwd])

  useEffect(() => Clipboard.copyOnSelect(renderer, Clipboard.write, () => setStatus("Copied")), [renderer])

  // One clock drives foreground and background progress through real settlement.
  const clockRunning = turn !== undefined || shell !== undefined || workspace.busy ||
    snapshot.tabs.some((tab) => tab.endedAt !== undefined && now - tab.endedAt < 3000)
  useEffect(() => {
    if (!clockRunning) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [clockRunning])

  useEffect(() => {
    if (toast === undefined) return
    const timer = setTimeout(() => setToast(undefined), 3000)
    return () => clearTimeout(timer)
  }, [toast])

  const setText = useCallback((text: string, at?: number) => {
    const input = composer.current
    if (input === null) return
    input.setText(text)
    if (at === undefined) input.gotoBufferEnd()
    else input.cursorOffset = at
    setDraft(text)
    setCursor(input.cursorOffset)
  }, [])

  const quit = useCallback(() => {
    workspace.dispose()
    live.current.turn?.handle.cancel()
    live.current.shell?.cancel()
    renderer.destroy()
    void props.host.dispose().finally(() => process.exit(0))
  }, [renderer, props.host, workspace])

  const startTurn = useCallback((prompt: string) => {
    const steering = Steering.make()
    const steered: Array<string> = []
    const startedAt = Date.now()
    writer.current.append({ type: "user", at: startedAt, text: prompt })
    setTranscript((current) => Transcript.user(current, prompt))
    const handle = props.host.run({
      prompt,
      seat: live.current.seat,
      history: entries.current,
      ...(live.current.seat.startsWith("replay:") ? {} : { role: "coordinator" as const }),
      workerSeat: props.workerSeat ?? props.seat,
      background: workspace.context(),
      runtime: {
        publish: workspace.publish,
        delegate: workspace.request,
        read: workspace.read,
        list: () => workspace.snapshot().tabs
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
        if (event._tag === "steering-drained") {
          for (const message of event.messages) {
            steered.push(message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""))
          }
        }
        setTranscript((current) => Transcript.apply(current, event, at))
      }
    })
    const state: TurnState = { handle, startedAt, steering }
    live.current.turn = state
    setTurn(state)
    void handle.done.then((outcome) => {
      const at = Date.now()
      const said = [prompt, ...steered].join("\n\n")
      writer.current.append({ type: "outcome", at, prompt: said, outcome })
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
  }, [props.host, workspace])
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
      return Transcript.shellStart(current, command, excluded)
    })
    const running = Shell.run({
      command,
      cwd: props.host.cwd,
      onOutput: (text) => setTranscript((current) => Transcript.shellOutput(current, id, text))
    })
    setShell(running)
    void running.done.then((result) => {
      writer.current.append({ type: "shell", at: Date.now(), result, excluded })
      if (!excluded) entries.current.push({ kind: "shell", text: Shell.contextText(result) })
      setTranscript((current) => Transcript.shellDone(current, id, result))
      setShell(undefined)
    })
  }, [props.host.cwd, setStatus])

  const switchSeat = useCallback((next: string) => {
    setSeat(next)
    setStatus(`Switched to ${props.models.find((model) => model.seat === next)?.label ?? next}`)
  }, [props.models, setStatus])

  const newSession = useCallback(() => {
    writer.current = Session.create(props.host.cwd)
    entries.current = []
    setWorkspace(
      new Workspace({
        host: props.host,
        workerSeat: props.workerSeat ?? props.seat,
        history: () => entries.current,
        persist: writer.current.append
      })
    )
    setSurface("chat")
    setPanelFocus(false)
    setName(undefined)
    setTranscript(Transcript.empty)
    setStatus("New session started")
  }, [props.host.cwd, setStatus])

  const openSession = useCallback((file: string) => {
    const state = Session.restore(Session.load(file))
    writer.current = Session.reopen(file)
    entries.current = state.entries
    history.current = new Editor.History(state.prompts)
    setWorkspace(
      new Workspace({
        host: props.host,
        workerSeat: props.workerSeat ?? props.seat,
        history: () => entries.current,
        persist: writer.current.append,
        restored: state.workspace
      })
    )
    setSurface("chat")
    setPanelFocus(false)
    setName(state.name)
    setTranscript(state.transcript)
    setStatus(`Resumed ${state.name ?? basename(file)}`)
  }, [setStatus])

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
      case "tabs":
        setSurface(snapshot.tabs[0] === undefined ? "summary" : `tab:${snapshot.tabs[0].id}`)
        setPanelFocus(true)
        setNavigation(Panels.initial())
        return true
      case "chat":
        setSurface("chat")
        setPanelFocus(false)
        return true
      case "retry":
        try {
          workspace.retry(argument)
        } catch (error) {
          setStatus(String(error), "warning")
        }
        return true
      case "stop":
        workspace.cancel(argument)
        return true
      case "ui": {
        const target = snapshot.panels.find((panel) => panel.id === argument) ?? snapshot.panels[0]
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
        if (live.current.turn !== undefined || live.current.shell !== undefined || workspace.busy) {
          setStatus("Stop running work first", "warning")
        } else newSession()
        return true
      case "resume":
        setPicker({ kind: "resume", query: "", selected: 0, sessions: Session.list(props.host.cwd) })
        return true
      case "session": {
        const usage = transcript.usage
        setTranscript((current) =>
          Transcript.note(
            current,
            `${writer.current.file}\n${entries.current.length} exchanges · ↑${Editor.tokens(usage.input)} ↓${
              Editor.tokens(usage.output)
            } R${Editor.tokens(usage.cached)}`
          )
        )
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
        setStatus(Clipboard.write(answer.text) ? "Copied the last answer" : "No clipboard command")
        return true
      }
      case "hotkeys":
        setTranscript((current) =>
          Transcript.note(current, Editor.keys.map(([key, action]) => `${key.padEnd(22)} ${action}`).join("\n"))
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
  }, [transcript, name, newSession, quit, switchSeat, setStatus, props.host.cwd, workspace, revision])

  const submit = useCallback((followUp = false, typed?: string) => {
    const input = composer.current
    if (input === null) return
    const text = (typed ?? input.plainText).trim()
    if (text === "") return
    const shellLine = Shell.parse(text)
    history.current.add(text)
    setText("")
    if (shellLine !== undefined) {
      if (shellLine.command !== "") runShell(shellLine.command, shellLine.excluded)
      return
    }
    if (text.startsWith("/") && command(text)) return
    const running = live.current.turn
    if (running === undefined) return startTurn(text)
    if (followUp) {
      setFollowUps((queued) => [...queued, text])
      return
    }
    running.steering.steer(text)
    writer.current.append({ type: "user", at: Date.now(), text, steered: true })
    setTranscript((current) => Transcript.user(current, text, true))
  }, [setText, runShell, command, startTurn])

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
    const file = join(mkdtempSync(join(tmpdir(), "smithers-editor-")), "prompt.md")
    writeFileSync(file, composer.current?.plainText ?? "")
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "nano"
    renderer.suspend()
    const result = spawnSync(editor, [file], { stdio: "inherit", shell: true })
    renderer.resume()
    if (result.status === 0) setText(readFileSync(file, "utf8").replace(/\n$/, ""))
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

  const pick = useCallback((open: Picker, value: string) => {
    setPicker(undefined)
    if (open.kind === "model") return switchSeat(value)
    if (open.kind === "theme") {
      if (!isTheme(value)) return
      setTheme(value)
      refreshTheme((count) => count + 1)
      try { saveTheme(value) } catch { setStatus("Could not save theme", "warning") }
      return
    }
    if (live.current.turn === undefined && live.current.shell === undefined && !workspace.busy) openSession(value)
    else setStatus("Stop running work first", "warning")
  }, [switchSeat, openSession, setStatus, workspace])

  /** Keys while a dialog is open: its filter input takes the typing, these move and pick. */
  const dialogKey = (key: KeyEvent, open: Picker) => {
    const rows = pickerRows(open, props.models, live.current.seat)
    const move = (step: number) => {
      key.preventDefault()
      if (rows.length > 0) setPicker({ ...open, selected: (open.selected + step + rows.length) % rows.length })
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

  useKeyboard((key: KeyEvent) => {
    const { turn: running, shell: shellRunning, picker: open, menu: completing } = live.current
    const text = composer.current?.plainText ?? ""
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      const at = Date.now()
      if (at - lastCtrlC.current < Editor.exitWindowMs) return quit()
      lastCtrlC.current = at
      if (open !== undefined) setPicker(undefined)
      setPanelFocus(false)
      setText("")
      return
    }
    if (key.ctrl && key.name === "s") {
      key.preventDefault()
      setSurface(surface === "chat" ? "summary" : surface)
      setPanelFocus(!panelFocus)
      return
    }
    if (
      (key.ctrl && (key.name === "right" || key.name === "left")) || (key.name === "tab" && panelFocus && !key.shift)
    ) {
      key.preventDefault()
      const index = surfaces.findIndex((tab) => tab.id === surface)
      const next = surfaces[(index + (key.name === "left" ? -1 : 1) + surfaces.length) % surfaces.length]!
      setSurface(next.id)
      setPanelFocus(next.id !== "chat")
      setNavigation(Panels.initial())
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
      if (key.name === "r" && surface.startsWith("tab:")) {
        try {
          workspace.retry(surface.slice(4))
        } catch (error) {
          setStatus(String(error), "warning")
        }
        return
      }
      if (key.name === "x" && surface.startsWith("tab:")) {
        workspace.cancel(surface.slice(4))
        return
      }
      if (key.name === "a") {
        const action = panel.rows[Math.min(navigation.selected, panel.rows.length - 1)]?.action
        if (action !== undefined) {
          setPanelFocus(false)
          submit(false, action.prompt)
        }
        return
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
  })

  const working = turn !== undefined
  const tick = spinner[Math.floor(now / 100) % spinner.length]!
  const model = props.models.find((each) => each.seat === seat)
  const label = model?.label ?? (seat.startsWith("replay:") ? `replay ${basename(seat)}` : seat)
  const bashMode = draft.startsWith("!")
  const window = props.contextWindow(seat)
  const percent = window > 0 ? (transcript.usage.context / window) * 100 : 0
  const usage = transcript.usage
  const width = Math.max(20, Math.min(columnWidth, dimensions.width - 2))
  const accent = bashMode ? color.success : working ? color.faint : color.brand
  const rows = picker === undefined ? [] : pickerRows(picker, props.models, seat)
  const tabCount = Math.max(2, Math.floor(width / 24))
  const firstTab = Math.max(
    0,
    Math.min(surfaces.findIndex((tab) => tab.id === surface) - Math.floor(tabCount / 2), surfaces.length - tabCount)
  )
  const visibleTabs = surfaces.slice(firstTab, firstTab + tabCount)

  return (
    <box style={{ width: "100%", height: "100%", alignItems: "center" }} backgroundColor={color.page}>
      <box style={{ flexDirection: "column", height: "100%", width, paddingTop: 1 }}>
        <box style={{ flexDirection: "row", flexShrink: 0, marginBottom: 1 }}>
          <text wrapMode="none">
            {visibleTabs.map((tab) => (
              <span key={tab.id} fg={surface === tab.id ? color.brand : color.faint}>{" "}{tab.title.length > 22 ? `${tab.title.slice(0, 21)}…` : tab.title}{" "}</span>
            ))}
          </text>
        </box>
        {panel !== undefined ?
          (
            <PanelView
              panel={panel}
              navigation={navigation}
              height={dimensions.height - 10}
              width={width}
              focused={panelFocus}
              worker={surface.startsWith("tab:")}
              scrollRef={panelScroll}
            />
          ) :
          transcript.items.length === 0
          ? <View.Home expanded={expanded} />
          : (
            <scrollbox
              ref={scroll}
              stickyScroll
              stickyStart="bottom"
              style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, scrollbarOptions: { visible: false } }}
            >
              {transcript.items.map((item) => (
                <View.Entry key={item.id} item={item} now={now} tick={tick} expanded={expanded} />
              ))}
              {working && transcript.thinking
                ? <text fg={color.muted} style={{ paddingLeft: 2 }}>{tick} thinking</text>
                : null}
            </scrollbox>
          )}
        {followUps.length === 0 ? null : (
          <box style={{ marginTop: 1, paddingLeft: 2, flexShrink: 0 }}>
            {followUps.map((text, index) => <text key={index} fg={color.muted}>Follow-up: {text.split("\n")[0]}</text>)}
            <text fg={color.faint}>↳ alt+up to edit all queued messages</text>
          </box>
        )}
        {menu === undefined || panelFocus ?
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
        <box
          style={{ border: ["left"], marginTop: 1, flexShrink: 0 }}
          borderColor={accent}
          customBorderChars={View.bar}
        >
          <box style={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1 }} backgroundColor={color.surface}>
            <textarea
              ref={composer}
              focused={picker === undefined && !panelFocus}
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
                setDraft(composer.current?.plainText ?? "")
                setCursor(composer.current?.cursorOffset ?? 0)
                setMenuDismissed(false)
              }}
              onCursorChange={() => setCursor(composer.current?.cursorOffset ?? 0)}
              style={{ minHeight: 1, maxHeight: Math.max(6, Math.floor(dimensions.height / 3)) }}
            />
            <text style={{ marginTop: 1, marginBottom: 1 }}>
              <span fg={bashMode ? color.success : color.brand}>{bashMode ? "shell" : "code"}</span>
              <span fg={color.faint}>{"  ·  "}</span>
              <span fg={color.text}>{label}</span>
              {model === undefined ? null : <span fg={color.faint}>{" "}{model.provider}</span>}
              {thinking === undefined ? null : <span fg={color.warning}>{"  "}{thinking}</span>}
            </text>
          </box>
        </box>
        <box
          style={{ flexDirection: "row", justifyContent: "space-between", height: 1, paddingLeft: 1, flexShrink: 0 }}
        >
          <text wrapMode="none" style={{ flexShrink: 1 }}>
            {working
              ? (
                <>
                  <span fg={color.brand}>{tick} {Transcript.duration(now - turn.startedAt)}</span>
                  <span fg={color.text}>{"  esc"}</span>
                  <span fg={color.faint}>{" interrupt"}</span>
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
          <text wrapMode="none" style={{ flexShrink: 0 }}>
            {transcript.contextAssessment?.outdated || transcript.contextAssessment?.irrelevant
              ? <span fg={color.warning}>{"context: "}{[
                  transcript.contextAssessment.outdated ? "outdated" : "",
                  transcript.contextAssessment.irrelevant ? "irrelevant" : ""
                ].filter(Boolean).join(" + ")}{" · compact?  "}</span>
              : null}
            <span fg={color.faint}>
              ↑{Editor.tokens(usage.input)} ↓{Editor.tokens(usage.output)}
              {usage.cached === 0 ? "" : ` R${Editor.tokens(usage.cached)}`}
            </span>
            {window > 0
              ? (
                <span fg={percent > 90 ? color.danger : percent > 70 ? color.warning : color.faint}>
                  {"  "}
                  {percent.toFixed(1)}%/{Editor.tokens(window)}
                </span>
              )
              : null}
          </text>
        </box>
      </box>
      <View.ToastStack
        rows={[
          ...snapshot.tabs.filter((tab) =>
            now - tab.startedAt >= 300 && (tab.endedAt === undefined || now - tab.endedAt < 3000)
          ).map((tab) => ({
            id: tab.id,
            text: `${
              tab.status === "running" || tab.status === "requested" ? tick : tab.status === "done" ? "✓" : "✗"
            } ${tab.title} · ${tab.status}`,
            tone: tab.status === "failed" ? "danger" as const : "info" as const
          })),
          ...(toast === undefined ? [] : [{ id: "notice", ...toast }])
        ]}
      />
      {picker === undefined ? null : (
        <View.Dialog
          title={picker.kind === "model" ? "Select model" : picker.kind === "theme" ? "Select theme" : "Resume session"}
          width={Math.min(72, dimensions.width - 4)}
          height={dimensions.height}
        >
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
                setPicker((current) => (current === undefined ? current : { ...current, query, selected: 0 }))}
            />
          </box>
          <box style={{ paddingLeft: 2, paddingRight: 2 }}>
            <View.List
              rows={rows}
              selected={picker.selected}
              height={Math.min(rows.length, Math.max(3, Math.floor(dimensions.height / 2) - 6))}
              background={color.surface}
              empty={picker.kind === "resume" ? "No sessions in this directory" : `No ${picker.kind} matches "${picker.query}"`}
            />
          </box>
        </View.Dialog>
      )}
    </box>
  )
}
