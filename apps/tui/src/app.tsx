/**
 * The terminal UI: a transcript of cells above a composer.
 */
import type { KeyBinding, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/react"
import { homedir } from "node:os"
import { useCallback, useEffect, useRef, useState } from "react"
import type * as Host from "./host.ts"
import type { Model } from "./models.ts"
import { color, spinner, syntax } from "./theme.ts"
import * as Transcript from "./transcript.ts"

type Cell = Extract<Transcript.Item, { kind: "cell" }>

const composerKeys: Array<KeyBinding> = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "linefeed", action: "newline" }
]

/** A settled cell shows this many lines of code until expanded. */
const foldedLines = 12
/** Printed output shows its tail until expanded: this many lines, at most `printedChars`. */
const printedLines = 6
const printedChars = 480

/** The tail of printed output; one long line (a JSON dump) is cut by characters. */
const fold = (text: string): string => {
  const tail = text.split("\n").slice(-printedLines).join("\n")
  return tail.length > printedChars ? tail.slice(-printedChars) : tail
}

export function App(props: { readonly host: Host.Host; readonly seat: string; readonly models: ReadonlyArray<Model> }) {
  const renderer = useRenderer()
  const [transcript, setTranscript] = useState(Transcript.empty)
  const [seat, setSeat] = useState(props.seat)
  const [turn, setTurn] = useState<{ readonly handle: Host.Turn; readonly startedAt: number } | undefined>()
  const [picking, setPicking] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now())
  const history = useRef<Array<Host.Exchange>>([])
  const composer = useRef<TextareaRenderable>(null)
  const scroll = useRef<ScrollBoxRenderable>(null)

  // One clock drives every spinner and running duration, only while working.
  useEffect(() => {
    if (turn === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [turn])

  const quit = useCallback(() => {
    turn?.handle.cancel()
    renderer.destroy()
    void props.host.dispose().finally(() => process.exit(0))
  }, [turn, renderer, props.host])

  const send = useCallback((prompt: string) => {
    const startedAt = Date.now()
    setTranscript((current) => Transcript.user(current, prompt))
    const handle = props.host.run({
      prompt,
      seat,
      history: history.current,
      onEvent: (event) => setTranscript((current) => Transcript.apply(current, event, Date.now()))
    })
    setTurn({ handle, startedAt })
    void handle.done.then((outcome) => {
      setTurn(undefined)
      if (outcome._tag === "done") history.current.push({ user: prompt, answer: outcome.answer })
      if (outcome._tag === "failed") {
        setTranscript((current) => Transcript.failure(current, outcome.message, Date.now()))
      }
      if (outcome._tag === "cancelled") {
        setTranscript((current) => Transcript.failure(current, "Stopped", Date.now()))
      }
    })
  }, [props.host, seat])

  const submit = useCallback(() => {
    const input = composer.current
    if (input === null) return
    const text = input.plainText.trim()
    if (text === "") return
    if (text === "/exit" || text === "/quit") return quit()
    if (text === "/new") {
      if (turn !== undefined) return
      input.clear()
      history.current = []
      setTranscript(Transcript.empty)
      return
    }
    if (text === "/model") {
      input.clear()
      setPicking(true)
      return
    }
    if (text.startsWith("/model ")) {
      input.clear()
      setSeat(text.slice("/model ".length).trim())
      return
    }
    if (turn !== undefined) return
    input.clear()
    send(text)
  }, [turn, send, quit])

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return quit()
    if (picking) {
      if (key.name === "escape") setPicking(false)
      return
    }
    if (key.name === "escape" && turn !== undefined) return turn.handle.cancel()
    if (key.ctrl && key.name === "p") return setPicking(true)
    if (key.ctrl && key.name === "o") return setExpanded((value) => !value)
    if (key.name === "pageup") return scroll.current?.scrollBy(-0.5, "viewport")
    if (key.name === "pagedown") return scroll.current?.scrollBy(0.5, "viewport")
  })

  const working = turn !== undefined
  const tick = spinner[Math.floor(now / 100) % spinner.length]!
  const label = props.models.find((model) => model.seat === seat)?.label ?? seat

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1, paddingRight: 1 }}>
      <scrollbox ref={scroll} stickyScroll stickyStart="bottom" style={{ flexGrow: 1 }}>
        {transcript.items.length === 0 ? <Welcome /> : null}
        {transcript.items.map((item) => <Entry key={item.id} item={item} now={now} tick={tick} expanded={expanded} />)}
        {working && transcript.thinking ? <text fg={color.muted}>{tick} thinking</text> : null}
      </scrollbox>
      <box
        style={{ border: true, borderStyle: "rounded", marginTop: 1, minHeight: 3 }}
        borderColor={working ? color.faint : color.brand}
      >
        <textarea
          ref={composer}
          focused={!picking}
          placeholder={working ? "esc to stop" : "Ask Smithers to change this repository"}
          placeholderColor={color.faint}
          textColor={color.text}
          focusedTextColor={color.text}
          keyBindings={composerKeys}
          onSubmit={submit}
          style={{ minHeight: 1, maxHeight: 10 }}
        />
      </box>
      <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1 }}>
        <text fg={color.faint}>{props.host.cwd.replace(homedir(), "~")}</text>
        <text>
          {working ? <span fg={color.brand}>{tick} {Transcript.duration(now - turn.startedAt)}  </span> : null}
          <span fg={color.muted}>{label}</span>
          <span fg={color.faint}>{working ? "  esc stop" : "  ^p model  ^o expand"}</span>
        </text>
      </box>
      {picking
        ? (
          <ModelPicker
            seat={seat}
            models={props.models}
            onPick={(picked) => {
              setSeat(picked)
              setPicking(false)
            }}
          />
        )
        : null}
    </box>
  )
}

function Welcome() {
  return (
    <box style={{ paddingTop: 1, paddingBottom: 1 }}>
      <text fg={color.brand}>
        <strong>smithers</strong>
      </text>
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
          borderColor={color.brand}
          customBorderChars={bar}
        >
          <text fg={color.text}>{item.text}</text>
        </box>
      )
    case "cell":
      return <CellView cell={item} now={props.now} tick={props.tick} expanded={props.expanded} />
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

function ModelPicker(props: {
  readonly seat: string
  readonly models: ReadonlyArray<Model>
  readonly onPick: (seat: string) => void
}) {
  const listed = props.models.some((model) => model.seat === props.seat)
  const options = [
    ...(listed ? [] : [{ name: props.seat, description: props.seat, value: props.seat }]),
    ...props.models.map((model) => ({ name: model.label, description: `${model.provider} · ${model.seat}`, value: model.seat }))
  ]
  const selected = Math.max(0, options.findIndex((option) => option.value === props.seat))
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
      title=" model "
    >
      <select
        focused
        options={options}
        selectedIndex={selected}
        onSelect={(_, option) => option !== null && props.onPick(String(option.value))}
        style={{ height: options.length * 2 }}
        backgroundColor={color.surface}
        focusedBackgroundColor={color.surface}
        textColor={color.text}
        selectedBackgroundColor={color.brand}
        selectedTextColor={color.surface}
        descriptionColor={color.faint}
        selectedDescriptionColor={color.surface}
      />
      <text fg={color.faint}>/model provider:id for any other seat</text>
    </box>
  )
}
