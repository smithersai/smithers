/** This oracle reads gateway rows, never the product's trace or presentation code. */
export type JournalRow = Readonly<Record<string, unknown>>
type Fields = Record<string, unknown>
const fields = (value: unknown): Fields => typeof value === "object" && value !== null ? value as Fields : {}
const word = (value: unknown): string => typeof value === "string" ? value : ""
const base = (value: unknown): string => word(value).split("/").at(-1) ?? ""
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

export class TimelineEvidenceError extends Error {
  readonly _tag = "TimelineEvidenceError"
  constructor(readonly code: "unsupported-evidence" | "missing-later-phase" | "edit-not-proven", message: string) { super(message) }
}

type Call = { seq: number; name: string; id?: string; input: Fields; result?: Fields; outcome?: string; message?: string }
type Frame = { frame: number; opens: number; calls: Call[]; changed: boolean; blocked: boolean }
export type ExpectedBand = { phase: string; seq: number }
export type ExpectedLine = { node: string; number: string; verb: string; subject: string; result: string }
export type Meaning = {
  frames: Frame[]; bands: ExpectedBand[]; pins: { seq: number; label: string }[]; lines: ExpectedLine[];
  status: string; goals: readonly never[]
}
const READ = "control.agent.cell-call-started"
const RESULT = "control.agent.cell-call-settled"
const OPEN = "control.agent.turn-opened"
const WRITE_NAMES = new Set(["write", "edit", "apply_patch"])
const READ_NAMES = new Set(["read", "grep", "glob", "ls"])
const verbs: Record<string, readonly [string, string, string]> = {
  read: ["reading", "read", "failed to read"], write: ["writing", "wrote", "failed to write"],
  edit: ["editing", "edited", "failed to edit"], apply_patch: ["patching", "patched", "failed to patch"],
  bash: ["running", "ran", "failed to run"], test: ["running", "ran", "failed to run"],
  grep: ["searching", "searched", "failed to search"], glob: ["listing", "listed", "failed to list"], ls: ["listing", "listed", "failed to list"]
}
const checks = (call: Call): boolean => call.name === "test" || call.name === "bash" && /^bun test(?:\s|$)/.test(word(call.input.command))
const paths = (call: Call): string[] => typeof call.input.path === "string" ? [call.input.path] :
  [...word(call.input.input).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]!)
const pathLabel = (names: string[]): string => names.length === 0 ? "" : `${base(names[0])}${names.length > 1 ? ` +${names.length - 1}` : ""}`
const subject = (call: Call): string => call.name === "apply_patch" ? pathLabel(paths(call)) :
  typeof call.input.path === "string" ? base(call.input.path) : word(call.input.command) || word(call.input.pattern) ||
  (Array.isArray(call.input.selection) ? call.input.selection.join(" ") : "")
const result = (call: Call): string => {
  if (call.outcome === "failure") return call.message ?? ""
  const value = call.result ?? {}
  if (call.name === "read" && typeof value.startLine === "number" && typeof value.endLine === "number") return count(value.endLine - value.startLine + 1, "line")
  if (call.name === "write" && typeof value.bytesWritten === "number") return count(value.bytesWritten, "byte")
  if (call.name === "edit" && typeof value.replacements === "number") return count(value.replacements, "replacement")
  if (call.name === "apply_patch" && [value.added, value.modified, value.deleted].every(Array.isArray)) return count(new Set([...(value.added as string[]), ...(value.modified as string[]), ...(value.deleted as string[])]).size, "file")
  if ((call.name === "bash" || call.name === "test") && typeof value.exitCode === "number") return `exit ${value.exitCode}`
  if (call.name === "glob" && Array.isArray(value.paths)) return count(value.paths.length, "file")
  if (call.name === "ls" && Array.isArray(value.entries)) return `${value.entries.length} ${value.entries.length === 1 ? "entry" : "entries"}`
  if (call.name === "grep" && Array.isArray(value.matches)) return `${value.matches.length} ${value.matches.length === 1 ? "match" : "matches"}`
  return ""
}

/** The bounded fixture uses standard filesystem calls and a direct bun test command. Unknown semantics fail closed. */
export const journalMeaning = (rows: ReadonlyArray<JournalRow>, cursor = Infinity): Meaning => {
  const ordered = [...rows].filter(row => Number(row.sequence) <= cursor).sort((a, b) => Number(a.sequence) - Number(b.sequence))
  const frames: Frame[] = [], open: Call[] = [], pins: Meaning["pins"] = []
  const written = new Map<Frame, { paths: string[]; pin: Meaning["pins"][number] }>()
  let status = "Running"
  for (const row of ordered) {
    const p = fields(row.payload), seq = Number(row.sequence), frame = frames.at(-1), kind = word(row.kind)
    if (kind.includes("PreparePlan") || p.flowName === "coding/PreparePlan" || p.flowName === "coding/PrepareWithWiki" || fields(p.value).plan !== undefined) {
      throw new TimelineEvidenceError("unsupported-evidence", `Recorded plan at #${seq} needs a goal oracle; no goal claim was made.`)
    }
    if (kind === OPEN) { frames.push({ frame: frames.length + 1, opens: seq, calls: [], changed: false, blocked: false }); status = "Thinking" }
    if (kind === "control.agent.cell-produced") status = "Running code"
    if (kind === READ) {
      const name = word(p.flowName)
      if (name === "checkpoint") continue
      if (!Object.hasOwn(verbs, name)) throw new TimelineEvidenceError("unsupported-evidence", `No independent oracle for ${name} at #${seq}.`)
      const call: Call = { name, seq, input: fields(p.input), ...(typeof p.callId === "string" ? { id: p.callId } : {}) }
      frame?.calls.push(call); open.push(call)
      const title = ({ read: "Reading", write: "Writing", edit: "Editing", apply_patch: "Editing", bash: "Running", test: "Testing", grep: "Searching", glob: "Listing", ls: "Listing" } as Record<string, string>)[name]!
      status = `${title}${subject(call) ? ` ${word(call.input.path) || subject(call)}` : ""}`
    }
    if (kind === RESULT) {
      const index = open.findIndex(call => typeof p.callId === "string" ? call.id === p.callId : call.name === p.flowName)
      if (index < 0) continue
      const call = open.splice(index, 1)[0]!
      call.result = fields(p.value); call.outcome = word(p.outcome); call.message = word(p.message)
      if (call.outcome === "success" && WRITE_NAMES.has(call.name)) {
        const owner = frames.find(one => one.calls.includes(call))
        const prior = owner === undefined ? undefined : written.get(owner)
        const named = [...new Set([...(prior?.paths ?? []), ...paths(call)])]
        if (prior) { prior.paths = named; prior.pin.label = pathLabel(named) }
        else if (named.length > 0) {
          const pin = { seq, label: pathLabel(named) }
          pins.push(pin)
          if (owner) written.set(owner, { paths: named, pin })
        }
      }
      if (open.length === 0) {
        const title = ({ read: "Read", write: "Wrote", edit: "Edited", apply_patch: "Patched", bash: "Ran", test: "Tested", grep: "Searched", glob: "Listed", ls: "Listed" } as Record<string, string>)[call.name]!
        status = `${call.outcome === "failure" ? `Failed ${call.name}` : title}${subject(call) ? ` ${word(call.input.path) || subject(call)}` : ""}`
      }
    }
    if (kind === "control.agent.mutation-observed" && p.mutated === true && frame) frame.changed = true
    if (kind === "control.agent.permission-required" && frame) { frame.blocked = true; pins.push({ seq, label: "permission" }) }
    if (kind === "control.agent.steering-drained" && Array.isArray(p.messages) && p.messages.length > 0) pins.push({ seq, label: "steering" })
    const notes: Record<string, string> = {
      "control.agent.read-only-demanded": "read-only", "control.agent.read-only-demand-issued": "read-only",
      "control.agent.repeat-demanded": "repeat", "control.agent.narrowed-demanded": "narrowed", "control.agent.unmoved-demanded": "unmoved",
      "control.agent.unresolved-demanded": "unresolved", "control.agent.claim-demanded": "claim",
      "control.agent.narrow-only-demanded": "narrow-only", "control.agent.sufficiency-observed": "sufficiency"
    }
    if (Object.hasOwn(notes, kind) && (kind !== "control.agent.claim-demanded" || p.demanded === true)) pins.push({ seq, label: notes[kind]! })
    if (kind === "control.agent.repeat-demanded") throw new TimelineEvidenceError("unsupported-evidence", `Repeat discipline at #${seq} needs a stall oracle.`)
    const terminal = new Map([["control.run.completed", "Finished."], ["control.run.failed", "Failed."], ["control.run.cancelled", "Cancelled."]]).get(kind)
    if (terminal) { status = terminal; pins.push({ seq, label: kind.split(".").at(-1)! }) }
  }
  const bands: ExpectedBand[] = [], lines: ExpectedLine[] = []
  for (const frame of frames) {
    const phase = frame.blocked ? "blocked" : frame.changed || frame.calls.some(call => WRITE_NAMES.has(call.name)) ? "implementing" :
      frame.calls.some(checks) ? "testing" : frame.calls.some(call => READ_NAMES.has(call.name)) ? "researching" : "unrecorded"
    if (bands.at(-1)?.phase !== phase) bands.push({ phase, seq: frame.opens })
    const call = frame.calls.find(call => WRITE_NAMES.has(call.name)) ?? frame.calls.find(checks) ?? frame.calls[0]
    if (call) lines.push({ node: `frame-${frame.frame}`, number: String(frame.frame),
      verb: verbs[call.name]![call.outcome === undefined ? 0 : call.outcome === "failure" ? 2 : 1], subject: subject(call), result: result(call) })
  }
  return { frames, bands, pins: pins.sort((a, b) => a.seq - b.seq), lines, status, goals: [] }
}

export const requireLaterPhase = (meaning: Meaning): ExpectedBand => {
  const later = [...meaning.bands].reverse().find(band => band.phase !== meaning.bands[0]?.phase)
  if (!later) throw new TimelineEvidenceError("missing-later-phase", "The journal did not record two different phases. A terminal pin proves no later phase.")
  return later
}

export const assertSuccessfulEdit = (status: string, before: string, after: string, marker: string): void => {
  if (status !== "completed" || before.split(/\r?\n/).includes(marker) || after !== `${before}${before.endsWith("\n") ? "" : "\n"}${marker}\n`) {
    throw new TimelineEvidenceError("edit-not-proven", "Success requires a completed run and an independent exact append readback.")
  }
}
