/**
 * The terminal UI: a transcript of cells above a composer.
 *
 * Keys and commands follow pi (`badlogic/pi-mono` coding-agent) wherever the
 * cell harness has the same idea; `editor.ts` lists them.
 */
import type { KeyBinding, KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/react"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { useCallback, useEffect, useRef, useState } from "react"
import * as Clipboard from "./clipboard.ts"
import type * as Context from "./context.ts"
import * as Editor from "./editor.ts"
import type * as Host from "./host.ts"
import type { Model } from "./models.ts"
import * as Session from "./session.ts"
import * as Shell from "./shell.ts"
import * as Steering from "./steering.ts"
import { color, spinner, syntax } from "./theme.ts"
import * as Transcript from "./transcript.ts"

type Cell = Extract<Transcript.Item, { kind: "cell" }>
type ShellItem = Extract<Transcript.Item, { kind: "shell" }>

const composerKeys: Array<KeyBinding> = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" }
]

/** A settled cell shows this many lines of code until expanded. */
const foldedLines = 12
/** Printed output shows its tail until expanded: this many lines, at most `printedChars`. */
const printedLines = 6
const printedChars = 480
/** A shell block shows its last lines until expanded (pi's `PREVIEW_LINES`). */
const shellLines = 20

/** The tail of printed output; one long line (a JSON dump) is cut by characters. */
const fold = (text: string): string => {
  const tail = text.split("\n").slice(-printedLines).join("\n")
  return tail.length > printedChars ? tail.slice(-printedChars) : tail
}

export interface AppProps {
  readonly host: Host.Host
  readonly seat: string
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
  | { readonly kind: "model"; readonly query: string }
  | { readonly kind: "resume"; readonly sessions: ReadonlyArray<Session.Summary> }

export function App(props: AppProps) {
  const renderer = useRenderer()
  const restored = useRef(props.resume === undefined ? undefined : Session.restore(Session.load(props.resume)))
  const [transcript, setTranscript] = useState(restored.current?.transcript ?? Transcript.empty)
  const [seat, setSeat] = useState(props.seat)
  const [thinking, setThinking] = useState<Editor.Thinking>(undefined)
  const [turn, setTurn] = useState<TurnState | undefined>()
  const [shell, setShell] = useState<Shell.Running | undefined>()
  const [followUps, setFollowUps] = useState<ReadonlyArray<string>>([])
  const [picker, setPicker] = useState<Picker | undefined>(
    props.pickSession === true ? { kind: "resume", sessions: Session.list(props.host.cwd) } : undefined
  )
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<string | undefined>()
  const [draft, setDraft] = useState("")
  const [name, setName] = useState(restored.current?.name)
  const [now, setNow] = useState(Date.now())
  const entries = useRef<Array<Context.Entry>>(restored.current?.entries ?? [])
  const history = useRef(new Editor.History(restored.current?.prompts ?? []))
  const writer = useRef<Session.Writer>(
    props.resume === undefined ? Session.create(props.host.cwd) : Session.reopen(props.resume)
  )
  const composer = useRef<TextareaRenderable>(null)
  const scroll = useRef<ScrollBoxRenderable>(null)
  const lastCtrlC = useRef(0)
  // Key handlers read the latest values through these, never a stale render.
  const live = useRef({ turn, shell, followUps, seat, thinking, picker })
  live.current = { turn, shell, followUps, seat, thinking, picker }

  useEffect(() => {
    renderer.setTerminalTitle(`smithers - ${basename(props.host.cwd)}`)
  }, [renderer, props.host.cwd])

  useEffect(() => Clipboard.copyOnSelect(renderer, Clipboard.write, () => setStatus("Copied")), [renderer])

  // One clock drives every spinner and running duration, only while working.
  useEffect(() => {
    if (turn === undefined && shell === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [turn, shell])

  useEffect(() => {
    if (status === undefined) return
    const timer = setTimeout(() => setStatus(undefined), 3000)
    return () => clearTimeout(timer)
  }, [status])

  const setText = useCallback((text: string) => {
    const input = composer.current
    if (input === null) return
    input.setText(text)
    input.gotoBufferEnd()
    setDraft(text)
  }, [])

  const quit = useCallback(() => {
    live.current.turn?.handle.cancel()
    live.current.shell?.cancel()
    renderer.destroy()
    void props.host.dispose().finally(() => process.exit(0))
  }, [renderer, props.host])

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
    setTurn(state)
    void handle.done.then((outcome) => {
      const at = Date.now()
      const said = [prompt, ...steered].join("\n\n")
      writer.current.append({ type: "outcome", at, prompt: said, outcome })
      if (outcome._tag === "done") entries.current.push({ kind: "exchange", user: said, answer: outcome.answer })
      if (outcome._tag === "failed") setTranscript((current) => Transcript.failure(current, outcome.message, at))
      if (outcome._tag === "cancelled") setTranscript((current) => Transcript.failure(current, "Stopped", at))
      setTurn(undefined)
      if (outcome._tag === "cancelled") return
      // Steers no boundary reached, then follow-ups, go next, one turn each.
      const undelivered = steering.take()
      const next = undelivered.length > 0 ? undelivered.join("\n\n") : live.current.followUps[0]
      if (undelivered.length === 0 && next !== undefined) setFollowUps((queued) => queued.slice(1))
      if (next !== undefined) startTurnRef.current(next)
    })
  }, [props.host])
  const startTurnRef = useRef(startTurn)
  startTurnRef.current = startTurn

  const runShell = useCallback((command: string, excluded: boolean) => {
    if (live.current.shell !== undefined) {
      setStatus("A shell command is already running. Press esc to cancel it first.")
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
  }, [props.host.cwd])

  const switchSeat = useCallback((next: string) => {
    setSeat(next)
    setStatus(`Switched to ${props.models.find((model) => model.seat === next)?.label ?? next}`)
  }, [props.models])

  const newSession = useCallback(() => {
    writer.current = Session.create(props.host.cwd)
    entries.current = []
    setName(undefined)
    setTranscript(Transcript.empty)
    setStatus("New session started")
  }, [props.host.cwd])

  const openSession = useCallback((file: string) => {
    const state = Session.restore(Session.load(file))
    writer.current = Session.reopen(file)
    entries.current = state.entries
    history.current = new Editor.History(state.prompts)
    setName(state.name)
    setTranscript(state.transcript)
    setStatus(`Resumed ${state.name ?? basename(file)}`)
  }, [])

  const command = useCallback((text: string): boolean => {
    const parsed = Editor.parseCommand(text)
    if (parsed === undefined) return false
    const { name: verb, argument } = parsed
    switch (verb) {
      case "model":
        setPicker({ kind: "model", query: argument })
        return true
      case "thinking": {
        const level = argument === "" || argument === "default" ? undefined : argument
        if (level !== undefined && !(Editor.thinkingLevels as ReadonlyArray<string>).includes(level)) {
          setStatus(`Thinking levels: default, ${Editor.thinkingLevels.join(", ")}`)
          return true
        }
        setThinking(level as Editor.Thinking)
        setStatus(`Thinking level: ${level ?? "default"}`)
        return true
      }
      case "new":
        if (live.current.turn !== undefined) setStatus("Stop the running turn first (esc)")
        else newSession()
        return true
      case "resume":
        setPicker({ kind: "resume", sessions: Session.list(props.host.cwd) })
        return true
      case "session": {
        const usage = transcript.usage
        setTranscript((current) =>
          Transcript.note(
            current,
            `${writer.current.file}\n${entries.current.length} exchanges · ↑${Editor.tokens(usage.input)} ↓${Editor.tokens(usage.output)} R${Editor.tokens(usage.cached)}`
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
          setStatus("No answer to copy")
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
        setStatus(`Unknown command /${verb}`)
        return true
    }
  }, [transcript, name, newSession, quit, props.host.cwd])

  const submit = useCallback((followUp = false) => {
    const input = composer.current
    if (input === null) return
    const text = input.plainText.trim()
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

  /** pi's restore: queued messages go back into the editor, above the draft. */
  const restoreQueued = useCallback((extra: ReadonlyArray<string> = []) => {
    const queued = [...extra, ...live.current.followUps]
    if (queued.length === 0) return
    setFollowUps([])
    const current = composer.current?.plainText ?? ""
    setText([...queued, ...(current === "" ? [] : [current])].join("\n\n"))
    setStatus(`Restored ${queued.length} queued message${queued.length === 1 ? "" : "s"} to editor`)
  }, [setText])

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
      setStatus("Only one model available")
      return
    }
    const at = props.models.findIndex((model) => model.seat === live.current.seat)
    const next = props.models[(at + step + props.models.length) % props.models.length]!
    switchSeat(next.seat)
  }, [props.models, switchSeat])

  useKeyboard((key: KeyEvent) => {
    const { turn: running, shell: shellRunning, picker: open } = live.current
    const text = composer.current?.plainText ?? ""
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      const at = Date.now()
      if (at - lastCtrlC.current < Editor.exitWindowMs) return quit()
      lastCtrlC.current = at
      if (open !== undefined) setPicker(undefined)
      setText("")
      return
    }
    if (open !== undefined) {
      if (key.name === "escape") setPicker(undefined)
      return
    }
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
    if (key.name === "tab" && Editor.matching(text).length > 0) {
      key.preventDefault()
      return setText(`/${Editor.matching(text)[0]!.name} `)
    }
    if (key.ctrl && key.name === "l") return setPicker({ kind: "model", query: "" })
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
  const label = props.models.find((model) => model.seat === seat)?.label ??
    (seat.startsWith("replay:") ? `replay ${basename(seat)}` : seat)
  const bashMode = draft.startsWith("!")
  const menu = Editor.matching(draft)
  const window = props.contextWindow(seat)
  const percent = window > 0 ? (transcript.usage.context / window) * 100 : 0
  const usage = transcript.usage

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}>
      <scrollbox ref={scroll} stickyScroll stickyStart="bottom" style={{ flexGrow: 1 }}>
        <Header expanded={expanded} />
        {transcript.items.map((item) => <Entry key={item.id} item={item} now={now} tick={tick} expanded={expanded} />)}
        {working && transcript.thinking ? <text fg={color.muted}>{tick} thinking</text> : null}
      </scrollbox>
      {followUps.length === 0 ? null : (
        <box style={{ marginTop: 1 }}>
          {followUps.map((text, index) => (
            <text key={index} fg={color.muted}>Follow-up: {text.split("\n")[0]}</text>
          ))}
          <text fg={color.faint}>↳ alt+up to edit all queued messages</text>
        </box>
      )}
      {menu.length === 0 ? null : (
        <box style={{ marginTop: 1 }}>
          {menu.map((entry) => (
            <text key={entry.name}>
              <span fg={color.brand}>/{entry.name}</span>
              <span fg={color.faint}>{entry.args === undefined ? "" : ` ${entry.args}`}  {entry.description}</span>
            </text>
          ))}
        </box>
      )}
      {status === undefined ? null : <text fg={color.warning}>{status}</text>}
      <box
        style={{ border: true, borderStyle: "rounded", marginTop: 1, minHeight: 3 }}
        borderColor={bashMode ? color.success : working ? color.faint : color.brand}
      >
        <textarea
          ref={composer}
          focused={picker === undefined}
          placeholder={working ? "enter steers the next cell · alt+enter queues · esc stops" : "Ask Smithers to change this repository"}
          placeholderColor={color.faint}
          textColor={color.text}
          focusedTextColor={color.text}
          keyBindings={composerKeys}
          onSubmit={() => submit(false)}
          onContentChange={() => setDraft(composer.current?.plainText ?? "")}
          style={{ minHeight: 1, maxHeight: 10 }}
        />
      </box>
      <text fg={color.faint}>
        {props.host.cwd.replace(homedir(), "~")}
        {props.branch === undefined ? "" : ` (${props.branch})`}
        {name === undefined ? "" : ` • ${name}`}
      </text>
      <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1 }}>
        <text>
          {working ? <span fg={color.brand}>{tick} {Transcript.duration(now - turn.startedAt)}  </span> : null}
          <span fg={color.faint}>
            ↑{Editor.tokens(usage.input)} ↓{Editor.tokens(usage.output)} R{Editor.tokens(usage.cached)}
          </span>
          {window > 0
            ? (
              <span fg={percent > 90 ? color.danger : percent > 70 ? color.warning : color.faint}>
                {"  "}{percent.toFixed(1)}%/{Editor.tokens(window)}
              </span>
            )
            : null}
        </text>
        <text>
          <span fg={color.muted}>{label}</span>
          <span fg={color.faint}> • {thinking === undefined ? "thinking default" : `thinking ${thinking}`}</span>
        </text>
      </box>
      {picker?.kind === "model"
        ? (
          <ModelPicker
            seat={seat}
            models={props.models}
            query={picker.query}
            onPick={(picked) => {
              switchSeat(picked)
              setPicker(undefined)
            }}
          />
        )
        : null}
      {picker?.kind === "resume"
        ? (
          <SessionPicker
            sessions={picker.sessions}
            onPick={(file) => {
              setPicker(undefined)
              if (live.current.turn === undefined) openSession(file)
              else setStatus("Stop the running turn first (esc)")
            }}
          />
        )
        : null}
    </box>
  )
}

function Header(props: { readonly expanded: boolean }) {
  return (
    <box style={{ paddingTop: 1, paddingBottom: 1 }}>
      <text fg={color.brand}>
        <strong>smithers</strong>
      </text>
      {props.expanded
        ? Editor.keys.map(([key, action]) => (
          <text key={key}>
            <span fg={color.muted}>{key.padEnd(22)}</span>
            <span fg={color.faint}>{action}</span>
          </text>
        ))
        : (
          <text fg={color.faint}>
            esc interrupt · ctrl+c clear · ctrl+c twice exit · / commands · ! bash · ctrl+o more
          </text>
        )}
    </box>
  )
}

function Entry(props: { readonly item: Transcript.Item; readonly now: number; readonly tick: string; readonly expanded: boolean }) {
  const { item } = props
  switch (item.kind) {
    case "user":
      return (
        <box
          style={{ border: ["left"], paddingLeft: 1, marginTop: 1, marginBottom: 1 }}
          borderColor={item.queued === true ? color.faint : color.brand}
          customBorderChars={bar}
        >
          <text fg={item.queued === true ? color.muted : color.text}>{item.text}</text>
          {item.queued === true ? <text fg={color.faint}>steering · delivered before the next cell</text> : null}
        </box>
      )
    case "cell":
      return <CellView cell={item} now={props.now} tick={props.tick} expanded={props.expanded} />
    case "shell":
      return <ShellView item={item} tick={props.tick} expanded={props.expanded} />
    case "answer":
      return (
        <box style={{ marginTop: 1, marginBottom: 1 }}>
          <markdown content={item.text} syntaxStyle={syntax} />
        </box>
      )
    case "error":
      return <text fg={color.danger}>✗ {item.text}</text>
    case "note":
      return item.text === "" ? null : <text fg={color.faint}>{item.text}</text>
  }
}

const bar = {
  topLeft: " ",
  topRight: " ",
  bottomLeft: " ",
  bottomRight: " ",
  horizontal: " ",
  vertical: "┃",
  topT: " ",
  bottomT: " ",
  leftT: " ",
  rightT: " ",
  cross: " "
}

const statusColor: Record<Transcript.CellStatus, string> = {
  writing: color.brand,
  running: color.info,
  done: color.success,
  failed: color.danger,
  rejected: color.warning
}

function ShellView(props: { readonly item: ShellItem; readonly tick: string; readonly expanded: boolean }) {
  const { item } = props
  const lines = item.output.replace(/\n+$/, "").split("\n")
  const hidden = props.expanded ? 0 : Math.max(0, lines.length - shellLines)
  const shown = lines.slice(hidden).join("\n")
  const result = item.result
  return (
    <box
      style={{ border: true, borderStyle: "rounded", paddingLeft: 1, paddingRight: 1, marginBottom: 1 }}
      borderColor={item.excluded ? color.faint : color.success}
      title={` $ ${item.command.split("\n")[0]} `}
    >
      {hidden > 0 ? <text fg={color.faint}>... {hidden} more lines (ctrl+o to expand)</text> : null}
      {shown === "" ? null : <text fg={color.muted}>{shown}</text>}
      {result === undefined ? <text fg={color.info}>{props.tick} Running... (esc to cancel)</text> : null}
      {result?.cancelled === true ? <text fg={color.warning}>(cancelled)</text> : null}
      {result !== undefined && !result.cancelled && result.exitCode !== 0
        ? <text fg={color.warning}>(exit {result.exitCode ?? "?"})</text>
        : null}
      {result?.fullOutputPath === undefined ? null : (
        <text fg={color.faint}>Output truncated. Full output: {result.fullOutputPath}</text>
      )}
    </box>
  )
}

function CellView(props: { readonly cell: Cell; readonly now: number; readonly tick: string; readonly expanded: boolean }) {
  const { cell } = props
  const live = cell.status === "writing" || cell.status === "running"
  const elapsed = (cell.endedAt ?? props.now) - cell.startedAt
  const lines = cell.source.split("\n")
  const folded = !props.expanded && !live && lines.length > foldedLines
  const source = folded ? lines.slice(0, foldedLines).join("\n") : cell.source
  const printed = cell.printed.trimEnd().split("\n")
  const shownPrinted = props.expanded ? printed.join("\n") : fold(cell.printed.trimEnd())
  return (
    <box
      style={{ border: ["left"], paddingLeft: 1, marginBottom: 1 }}
      borderColor={statusColor[cell.status]}
      customBorderChars={bar}
    >
      <text>
        <span fg={statusColor[cell.status]}>{live ? props.tick : cell.status === "done" ? "●" : "✗"} </span>
        <span fg={color.muted}>cell {cell.index}</span>
        <span fg={color.faint}>  {cell.status === "writing" ? "writing" : cell.status === "running" ? "running" : ""}{live ? " " : ""}{Transcript.duration(elapsed)}</span>
      </text>
      {cell.prose === "" ? null : <text fg={color.muted}><em>{cell.prose}</em></text>}
      {cell.source === "" ? null : (
        <box style={{ backgroundColor: color.surface, paddingLeft: 1, paddingRight: 1, marginTop: 1 }}>
          <code content={source} filetype="javascript" syntaxStyle={syntax} streaming={cell.status === "writing"} />
          {folded ? <text fg={color.faint}>… +{lines.length - foldedLines} lines</text> : null}
        </box>
      )}
      {cell.calls.length === 0 ? null : (
        <box style={{ marginTop: 1 }}>
          {cell.calls.map((call, index) => <CallLine key={index} call={call} now={props.now} tick={props.tick} />)}
        </box>
      )}
      {cell.printed.trim() === "" ? null : (
        <box style={{ marginTop: 1 }}>
          {!props.expanded && shownPrinted.length < cell.printed.trimEnd().length
            ? <text fg={color.faint}>… +{printed.length > printedLines ? `${printed.length - printedLines} lines` : "more"}</text>
            : null}
          <text fg={color.muted}>{shownPrinted}</text>
        </box>
      )}
      {cell.error === undefined ? null : <text fg={cell.status === "rejected" ? color.warning : color.danger}>{cell.error}</text>}
    </box>
  )
}

function CallLine(props: { readonly call: Transcript.Call; readonly now: number; readonly tick: string }) {
  const { call } = props
  const mark = call.status === "running" ? props.tick : call.status === "ok" ? "✓" : "✗"
  const tone = call.status === "running" ? color.info : call.status === "ok" ? color.success : color.danger
  const subject = call.subject.split("\n")[0]!
  return (
    <text>
      <span fg={tone}>{mark} </span>
      <span fg={color.text}>{call.flow} </span>
      <span fg={color.muted}>{subject.length > 80 ? `${subject.slice(0, 79)}…` : subject}</span>
      <span fg={color.faint}>  {Transcript.duration((call.endedAt ?? props.now) - call.startedAt)}</span>
      {call.exit === undefined ? null : <span fg={color.warning}>  exit {call.exit}</span>}
      {call.message === undefined ? null : <span fg={color.danger}>  {call.message.split("\n")[0]}</span>}
    </text>
  )
}

function Dialog(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <box
      style={{
        position: "absolute",
        top: 2,
        left: 4,
        right: 4,
        border: true,
        borderStyle: "rounded",
        padding: 1,
        backgroundColor: color.surface,
        zIndex: 10
      }}
      borderColor={color.brand}
      title={` ${props.title} `}
    >
      {props.children}
    </box>
  )
}

const selectColors = {
  backgroundColor: color.surface,
  focusedBackgroundColor: color.surface,
  textColor: color.text,
  selectedBackgroundColor: color.brand,
  selectedTextColor: color.surface,
  descriptionColor: color.faint,
  selectedDescriptionColor: color.surface
} as const

function ModelPicker(props: {
  readonly seat: string
  readonly query: string
  readonly models: ReadonlyArray<Model>
  readonly onPick: (seat: string) => void
}) {
  const query = props.query.toLowerCase()
  const listed = props.models.filter((model) =>
    `${model.label} ${model.seat} ${model.provider}`.toLowerCase().includes(query)
  )
  const custom = props.query.includes(":") && !listed.some((model) => model.seat === props.query)
  const options = [
    ...(custom ? [{ name: props.query, description: "any seat", value: props.query }] : []),
    ...listed.map((model) => ({ name: model.label, description: `${model.provider} · ${model.seat}`, value: model.seat }))
  ]
  const selected = Math.max(0, options.findIndex((option) => option.value === props.seat))
  return (
    <Dialog title="model">
      {options.length === 0 ? <text fg={color.faint}>No model matches "{props.query}"</text> : (
        <select
          focused
          options={options}
          selectedIndex={selected}
          onSelect={(_, option) => option !== null && props.onPick(String(option.value))}
          style={{ height: Math.min(options.length * 2, 20) }}
          {...selectColors}
        />
      )}
      <text fg={color.faint}>/model provider:id for any other seat</text>
    </Dialog>
  )
}

function SessionPicker(props: {
  readonly sessions: ReadonlyArray<Session.Summary>
  readonly onPick: (file: string) => void
}) {
  const options = props.sessions.map((session) => ({
    name: (session.name ?? session.firstPrompt).split("\n")[0]!.slice(0, 80),
    description: new Date(session.modified).toLocaleString(),
    value: session.file
  }))
  return (
    <Dialog title="resume">
      {options.length === 0 ? <text fg={color.faint}>No sessions in this directory</text> : (
        <select
          focused
          options={options}
          onSelect={(_, option) => option !== null && props.onPick(String(option.value))}
          style={{ height: Math.min(options.length * 2, 20) }}
          {...selectColors}
        />
      )}
    </Dialog>
  )
}
