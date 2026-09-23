/**
 * What the screen draws, owing nothing to the app's state machine.
 *
 * The look is the Smithers app's (`apps/app`): Night Owl surfaces layered
 * page → panel → element. The user's messages keep the composer's shape. The shapes are opencode's: a left `┃` bar and a filled panel
 * instead of a boxed border, and a selected row filled with the brand color.
 */
import { RGBA } from "@opentui/core"
import type { ReactNode } from "react"
import * as Editor from "./editor.ts"
import { color, syntax } from "./theme.ts"
import * as Transcript from "./transcript.ts"

type Cell = Extract<Transcript.Item, { kind: "cell" }>
type ShellItem = Extract<Transcript.Item, { kind: "shell" }>

/** A shell block shows its last lines until expanded (pi's `PREVIEW_LINES`). */
const shellLines = 20
/** An edit's diff shows this many lines until expanded. */
const diffLines = 12
/** A finished cell's code shows this many lines until expanded; a live cell streams all of it. */
const codeLines = 8

export const bar = {
  topLeft: "",
  topRight: "",
  bottomLeft: "",
  bottomRight: "",
  horizontal: " ",
  vertical: "┃",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: ""
}


export function Home(props: { readonly expanded: boolean }) {
  return (
    <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center", paddingBottom: 2 }}>
      <text>
        <span fg={color.brand}>
          <strong>smithers</strong>
        </span>
      </text>
      {props.expanded
        ? (
          <box style={{ marginTop: 1 }}>
            {Editor.keys.map(([key, action]) => (
              <text key={key}>
                <span fg={color.text}>{key.padEnd(22)}</span>
                <span fg={color.faint}>{action}</span>
              </text>
            ))}
          </box>
        )
        : (
          <text fg={color.faint} style={{ marginTop: 1 }}>
            <span fg={color.muted}>/</span> commands  <span fg={color.muted}>@</span> files  <span fg={color.muted}>!</span> shell  <span fg={color.muted}>ctrl+o</span> keys
          </text>
        )}
    </box>
  )
}

export function Entry(props: {
  readonly item: Transcript.Item
  readonly now: number
  readonly tick: string
  readonly expanded: boolean
}) {
  const { item } = props
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} queued={item.queued === true} />
    case "cell":
      return <CellView cell={item} now={props.now} tick={props.tick} expanded={props.expanded} />
    case "shell":
      return <ShellView item={item} tick={props.tick} expanded={props.expanded} />
    case "answer":
      return (
        <box style={{ marginBottom: 1, paddingLeft: 2, paddingRight: 2 }}>
          <markdown content={item.text} syntaxStyle={syntax} />
        </box>
      )
    case "error":
      return (
        <box style={{ border: ["left"], paddingLeft: 1, marginBottom: 1 }} borderColor={color.danger} customBorderChars={bar}>
          <text fg={color.danger}>✗ {item.text}</text>
        </box>
      )
    case "note":
      return item.text === "" ? null : <text fg={color.faint} style={{ paddingLeft: 2, marginBottom: 1 }}>{item.text}</text>
  }
}

/** The user's message keeps the composer's shape: a left bar on a filled panel. */
function UserMessage(props: { readonly text: string; readonly queued: boolean }) {
  return (
    <box
      style={{ border: ["left"], marginTop: 1, marginBottom: 1 }}
      borderColor={props.queued ? color.faint : color.brand}
      customBorderChars={bar}
    >
      <box style={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }} backgroundColor={color.surface}>
        <text fg={props.queued ? color.muted : color.text}>{props.text}</text>
        {props.queued ? <text fg={color.faint} style={{ marginTop: 1 }}>steering</text> : null}
      </box>
    </box>
  )
}

const statusColor: Record<Transcript.CellStatus, string> = {
  writing: color.brand,
  running: color.info,
  done: color.faint,
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
    <box style={{ border: ["left"], marginBottom: 1 }} borderColor={item.excluded ? color.faint : color.success} customBorderChars={bar}>
      <box style={{ paddingLeft: 1, paddingRight: 1 }} backgroundColor={color.surface}>
        <text fg={color.success}>$ {item.command.split("\n")[0]}</text>
        {hidden > 0 ? <text fg={color.faint}>… {hidden} more lines (ctrl+o to expand)</text> : null}
        {shown === "" ? null : <text fg={color.muted}>{shown}</text>}
        {result === undefined ? <text fg={color.info}>{props.tick} Running… (esc to cancel)</text> : null}
        {result?.cancelled === true ? <text fg={color.warning}>(cancelled)</text> : null}
        {result !== undefined && !result.cancelled && result.exitCode !== 0
          ? <text fg={color.warning}>(exit {result.exitCode ?? "?"})</text>
          : null}
        {result?.fullOutputPath === undefined ? null : <text fg={color.faint}>Full output: {result.fullOutputPath}</text>}
      </box>
    </box>
  )
}

function CellView(props: { readonly cell: Cell; readonly now: number; readonly tick: string; readonly expanded: boolean }) {
  const { cell } = props
  const live = cell.status === "writing" || cell.status === "running"
  const elapsed = (cell.endedAt ?? props.now) - cell.startedAt
  // A live cell streams its whole code. Once it ends, the call rows below say
  // what it did, so the code and what it printed fold until ctrl+o.
  const lines = cell.source.split("\n")
  const hiddenCode = live || props.expanded || lines.length <= codeLines + 1 ? 0 : lines.length - codeLines
  const code = hiddenCode === 0 ? cell.source : lines.slice(0, codeLines).join("\n")
  const printed = cell.printed.trimEnd()
  const printedRows = printed === "" ? 0 : printed.split("\n").length
  const tone = statusColor[cell.status]
  const mark = live ? props.tick : cell.status === "done" ? "●" : "✗"
  return (
    <box style={{ border: ["left"], paddingLeft: 1, marginBottom: 1 }} borderColor={tone} customBorderChars={bar}>
      <box style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <text style={{ flexShrink: 1 }}>
          <span fg={tone}>{mark} </span>
          {cell.prose === ""
            ? <span fg={color.muted}>{cell.status === "writing" ? "writing" : "cell"}</span>
            : <span fg={color.text}>{cell.prose.split("\n")[0]}</span>}
        </text>
        <text fg={color.faint} style={{ flexShrink: 0 }}>{Transcript.duration(elapsed)}</text>
      </box>
      {cell.prose.includes("\n") ? <text fg={color.muted}>{cell.prose.split("\n").slice(1).join("\n")}</text> : null}
      {code === "" ? null : (
        <box style={{ paddingLeft: 1, paddingRight: 1, marginTop: 1 }} backgroundColor={color.page}>
          <code content={code} filetype="javascript" syntaxStyle={syntax} streaming={cell.status === "writing"} />
          {hiddenCode === 0 ? null : <text fg={color.faint}>… {hiddenCode} more lines</text>}
        </box>
      )}
      {cell.calls.length === 0 ? null : (
        <box>
          {cell.calls.map((call, index) => (
            <CallView key={index} call={call} now={props.now} tick={props.tick} expanded={props.expanded} />
          ))}
        </box>
      )}
      {printed === "" ? null : props.expanded
        ? (
          <box style={{ marginTop: 1, paddingLeft: 1, paddingRight: 1 }} backgroundColor={color.surface}>
            <text fg={color.muted}>{printed}</text>
          </box>
        )
        : <text fg={color.faint}>printed {printedRows} {printedRows === 1 ? "line" : "lines"} · ctrl+o</text>}
      {cell.error === undefined ? null : <text fg={cell.status === "rejected" ? color.warning : color.danger}>{cell.error}</text>}
    </box>
  )
}

const icons: Record<string, string> = {
  bash: "$",
  read: "→",
  ls: "✱",
  find: "✱",
  grep: "✱",
  glob: "✱",
  edit: "←",
  write: "←"
}

function CallView(props: { readonly call: Transcript.Call; readonly now: number; readonly tick: string; readonly expanded: boolean }) {
  const { call } = props
  const tone = call.status === "running" ? color.info : call.status === "ok" ? color.muted : color.danger
  const verb = call.verb === undefined
    ? call.flow
    : call.status === "running"
    ? call.verb.pending
    : call.status === "ok"
    ? call.verb.success
    : call.verb.failure
  const subject = call.subject.split("\n")[0]!
  const diff = call.change === undefined || call.status === "failed" ? undefined : Transcript.unified(call.change)
  const diffRows = diff === undefined ? 0 : diff.split("\n").length - 3
  return (
    <box>
      <box style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <text style={{ flexShrink: 1 }} wrapMode="none">
          <span fg={call.status === "running" ? color.info : tone}>{call.status === "running" ? props.tick : icons[call.flow] ?? "⚙"} </span>
          <span fg={call.status === "failed" ? color.danger : color.text}>{verb} </span>
          <span fg={color.muted}>{subject}</span>
          {call.exit === undefined ? null : <span fg={color.warning}>  exit {call.exit}</span>}
        </text>
        <text fg={color.faint} style={{ flexShrink: 0 }}>{Transcript.duration((call.endedAt ?? props.now) - call.startedAt)}</text>
      </box>
      {call.message === undefined ? null : <text fg={color.danger}>  {call.message.split("\n")[0]}</text>}
      {diff === undefined ? null : (
        <box style={{ marginTop: 1, marginBottom: 1, marginLeft: 2 }}>
          <diff
            diff={props.expanded || diffRows <= diffLines ? diff : diff.split("\n").slice(0, diffLines + 3).join("\n")}
            view="unified"
            filetype={call.change!.path.split(".").pop() ?? "text"}
            syntaxStyle={syntax}
            showLineNumbers
            fg={color.text}
            lineNumberFg={color.faint}
            lineNumberBg={color.page}
            addedBg={color.addedBg}
            removedBg={color.removedBg}
            contextBg={color.page}
            addedLineNumberBg={color.addedBg}
            removedLineNumberBg={color.removedBg}
            addedSignColor={color.success}
            removedSignColor={color.danger}
          />
          {!props.expanded && diffRows > diffLines ? <text fg={color.faint}>… {diffRows - diffLines} more lines</text> : null}
        </box>
      )}
    </box>
  )
}

export interface Row {
  readonly key: string
  readonly label: string
  readonly hint?: string
  readonly detail?: string
  /** Marks the current model or session. */
  readonly current?: boolean
}

/**
 * A list with one selected row, windowed around the selection, as the
 * completion menu and every dialog draw it.
 */
export function List(props: {
  readonly rows: ReadonlyArray<Row>
  readonly selected: number
  readonly height: number
  readonly background: string
  readonly empty: string
}) {
  const { rows, height } = props
  if (rows.length === 0) return <text fg={color.faint} style={{ paddingLeft: 1 }}>{props.empty}</text>
  const first = Math.max(0, Math.min(props.selected - Math.floor(height / 2), rows.length - height))
  const shown = rows.slice(first, first + height)
  const labelWidth = Math.min(40, Math.max(...shown.map((row) => row.label.length)) + 2)
  const hintWidth = Math.max(0, ...shown.map((row) => (row.hint === undefined ? 0 : row.hint.length + 2)))
  return (
    <box>
      {shown.map((row, offset) => {
        const selected = first + offset === props.selected
        const fg = selected ? color.page : color.text
        return (
          <box
            key={row.key}
            style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 1, height: 1 }}
            backgroundColor={selected ? color.brand : props.background}
          >
            <text fg={fg} wrapMode="none" style={{ flexShrink: 1 }}>
              <span fg={selected ? color.page : color.brand}>{row.current === true ? "● " : "  "}</span>
              {selected ? <strong>{row.label.padEnd(labelWidth)}</strong> : row.label.padEnd(labelWidth)}
              <span fg={selected ? color.page : color.muted}>{(row.hint ?? "").padEnd(hintWidth)}</span>
              <span fg={selected ? color.page : color.faint}>{row.detail ?? ""}</span>
            </text>
          </box>
        )
      })}
      {rows.length > height
        ? (
          <box style={{ paddingLeft: 3 }}>
            <text fg={color.faint}>{props.selected + 1}/{rows.length}</text>
          </box>
        )
        : null}
    </box>
  )
}

const backdrop = RGBA.fromInts(1, 22, 39, 170)

/** A centered panel over a dimmed screen; the app routes keys to it while it is open. */
export function Dialog(props: {
  readonly title: string
  readonly width: number
  readonly height: number
  readonly children: ReactNode
}) {
  return (
    <box
      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", alignItems: "center", paddingTop: Math.max(1, Math.floor(props.height / 5)), zIndex: 100 }}
      backgroundColor={backdrop}
    >
      <box style={{ width: props.width, paddingTop: 1, paddingBottom: 1 }} backgroundColor={color.surface}>
        <box style={{ flexDirection: "row", justifyContent: "space-between", paddingLeft: 3, paddingRight: 3, marginBottom: 1 }}>
          <text fg={color.text}>
            <strong>{props.title}</strong>
          </text>
          <text fg={color.faint}>esc</text>
        </box>
        {props.children}
      </box>
    </box>
  )
}

/** Toasts ride the top right, like the app's toast stack. */
export function ToastStack(
  props: {
    readonly rows: ReadonlyArray<
      { readonly id: string; readonly text: string; readonly tone: "info" | "warning" | "danger" }
    >
  }
) {
  return (
    <box style={{ position: "absolute", top: 1, right: 2, maxWidth: 60, zIndex: 50 }}>
      {props.rows.map((row) => (
        <box
          key={row.id}
          style={{ border: ["left"], marginBottom: 1 }}
          borderColor={row.tone === "info" ? color.brand : color[row.tone]}
          customBorderChars={bar}
        >
          <box style={{ paddingLeft: 1, paddingRight: 2 }} backgroundColor={color.element}>
            <text fg={color.text}>{row.text}</text>
          </box>
        </box>
      ))}
    </box>
  )
}

/** `2m ago`, `3h ago`, `Sep 4`. */
export const ago = (at: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d ago`
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}
