import type { PhaseId } from "@smthrs/gateway/RunTrace"
import * as Activity from "./activity.ts"
import { color, mix } from "./theme.ts"
import { duration } from "./transcript.ts"

const tones: Record<PhaseId, keyof typeof color> = {
  researching: "info", implementing: "brand", testing: "success", stuck: "warning", blocked: "danger", unrecorded: "element"
}
const labels: Record<PhaseId, string> = {
  researching: "Researching", implementing: "Implementing", testing: "Testing", stuck: "Stuck", blocked: "Blocked", unrecorded: "Running"
}

export function ActivityView({ activity, width, now, cursor, focused, title, onSelect }: {
  readonly activity: Activity.Activity
  readonly width: number
  readonly now: number
  readonly cursor?: number
  readonly focused: boolean
  readonly title: string
  readonly onSelect: (seq: number) => void
}) {
  const model = Activity.model(activity)
  if (model.bands.length === 0 && model.milestones.length === 0) return null
  const sizes = Activity.widths(model, width)
  const pins = Activity.pins(model, width)
  const owner = cursor === undefined ? undefined : Activity.owner(model, cursor)
  const band = model.bands.find(band => band.frames.includes(owner ?? "")) ?? model.bands.at(-1)
  const state = activity.status === "running" ? labels[band?.phase ?? "unrecorded"]
    : activity.status === "completed" ? "Done" : activity.status === "cancelled" ? "Stopped" : "Failed"
  const reading = cursor === undefined ? model : Activity.at(activity, cursor)
  const line = reading.lines.find(line => line.spanId === owner)
  const notes = reading.notes.filter(note => note.spanId === owner)
  const pin = model.milestones.findLast(pin => pin.seq <= (cursor ?? Infinity))
  return <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
    <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1 }}>
      <text fg={focused ? color.brand : color.muted} wrapMode="none" style={{ flexShrink: 1 }}>{title}{" · "}{state}{" · "}
        {duration((activity.status === "running" ? now : model.extent.end) - model.extent.start)}</text>
      <text fg={color.faint} wrapMode="none" style={{ flexShrink: 0 }}>{focused ? `#${cursor ?? activity.records.length}  ← →  esc live` : "ctrl+t timeline"}</text>
    </box>
    {pins.length === 0 ? null : <box style={{ height: Math.max(...pins.map(pin => pin.row)) + 1, flexShrink: 0 }}>
      {pins.map(pin => <text key={`${pin.milestone.seq}:${pin.milestone.label}`} wrapMode="none"
        fg={pin.milestone.tone === "bad" ? color.danger : pin.milestone.tone === "good" ? color.success : color.warning}
        style={{ position: "absolute", left: pin.left, top: pin.row, width: pin.label.length, height: 1 }}
        onMouseDown={() => onSelect(pin.milestone.seq)}>{pin.label}</text>)}
    </box>}
    <box style={{ flexDirection: "row", height: 1 }}>
      {model.bands.map((band, index) => sizes[index] === 0 ? null : <box key={band.seq}
        onMouseDown={() => onSelect(band.seq)}
        style={{ width: sizes[index], height: 1, backgroundColor: mix(color[tones[band.phase]], 25, color.page) }}>
        <text fg={color.text} wrapMode="none">{band.frames.includes(owner ?? "") ? "│" : " "}{labels[band.phase]}</text>
      </box>)}
    </box>
    {!focused || pin === undefined ? null : <text fg={pin.tone === "bad" ? color.danger : pin.tone === "good" ? color.success : color.warning}
      wrapMode="none" onMouseDown={() => onSelect(pin.seq)}>↑ {pin.label}</text>}
    {focused && line !== undefined ? <text fg={line.failed ? color.danger : color.text} wrapMode="word">
      {line.frame}{"  "}{line.verb}{" "}{line.subject}{line.result === "" ? "" : ` · ${line.result}`}
    </text> : null}
    {focused ? <scrollbox style={{ maxHeight: 6, flexShrink: 0 }}>{notes.slice(-2).map(note => <box key={note.seq} style={{ flexDirection: "column" }}>
      <text fg={note.tone === "good" ? color.success : note.tone === "bad" ? color.danger : color.warning} wrapMode="word">{note.title}{note.body === "" ? "" : ` · ${note.body}`}</text>
      {note.evidence?.map((evidence, index) => <text key={index} fg={color.muted} wrapMode="word">{evidence}</text>)}
    </box>)}</scrollbox> : null}
  </box>
}
