/** This oracle reads gateway rows, never the product's trace or presentation code. */
export type JournalRow = Readonly<Record<string, unknown>>
type Fields = Record<string, unknown>
const fields = (value: unknown): Fields => typeof value === "object" && value !== null ? value as Fields : {}
const word = (value: unknown): string => typeof value === "string" ? value : ""
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const whole = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every(entry => typeof entry === "string") ? value as string[] : undefined
/** A path reads as the name a person calls the file. */
const base = (path: string): string => path.split("/").filter(part => part !== "").pop() ?? path
const count = (n: number, noun: string, plural = `${noun}s`) => `${n} ${n === 1 ? noun : plural}`

export class TimelineEvidenceError extends Error {
  readonly _tag = "TimelineEvidenceError"
  constructor(readonly code: "unsupported-evidence" | "missing-later-phase" | "edit-not-proven", message: string) { super(message) }
}

/*
 * How a recorded call reads.
 *
 * The vocabulary is `@smthrs/registry` `Descriptor.FlowActivity` and
 * `Descriptor.CallPresentation`, which `@smthrs/harness` `Cell.displayDescriptor`
 * writes into the journal beside every call. It is transcribed here rather than
 * imported, because an oracle that imported the product's reading would only
 * ever agree with it.
 */
const ACTIVITIES = ["reads", "writes", "checks", "tests", "other"] as const
type Activity = typeof ACTIVITIES[number]
const SUBJECTS = ["path", "command", "patch", "selection", "pattern", "none"] as const
type SubjectFormat = typeof SUBJECTS[number]
const RESULTS = ["text", "read", "write", "edit", "patch", "tests", "command", "matches", "paths", "entries", "none"] as const
type ResultFormat = typeof RESULTS[number]
type Outcome = "pending" | "success" | "failure"
type Presentation = { verb: Readonly<Record<Outcome, string>>; subject: SubjectFormat; result: ResultFormat }
type Semantics = { activity?: Activity; presentation?: Presentation }

const declaredPresentation = (value: unknown): Presentation | undefined => {
  const declared = fields(value), verb = fields(declared.verb)
  const subject = SUBJECTS.find(one => one === declared.subject), result = RESULTS.find(one => one === declared.result)
  if (subject === undefined || result === undefined) return undefined
  const pending = text(verb.pending), success = text(verb.success), failure = text(verb.failure)
  if (pending === undefined || success === undefined || failure === undefined) return undefined
  return { verb: { pending, success, failure }, subject, result }
}

const declaration = (activity: Activity | undefined, pending: string, success: string, failure: string,
  subject: SubjectFormat, result: ResultFormat): Semantics => ({
  ...(activity === undefined ? {} : { activity }),
  presentation: { verb: { pending, success, failure }, subject, result }
})

/**
 * What the `@smthrs/std` flows declare, for the journals that predate a
 * recorded descriptor. A record that carries its own descriptor is read
 * through that instead, so this table never decides a declared call.
 */
const LEGACY: ReadonlyMap<string, Semantics> = new Map([
  ["bash", declaration(undefined, "running", "ran", "failed to run", "command", "command")],
  ["test", declaration("tests", "running", "ran", "failed to run", "selection", "tests")],
  ["edit", declaration("writes", "editing", "edited", "failed to edit", "path", "edit")],
  ["write", declaration("writes", "writing", "wrote", "failed to write", "path", "write")],
  ["apply_patch", declaration("writes", "patching", "patched", "failed to patch", "patch", "patch")],
  ["read", declaration("reads", "reading", "read", "failed to read", "path", "read")],
  ["grep", declaration("reads", "searching", "searched", "failed to search", "pattern", "matches")],
  ["glob", declaration("reads", "listing", "listed", "failed to list", "pattern", "paths")],
  ["ls", declaration("reads", "listing", "listed", "failed to list", "path", "entries")]
])

/** The command line a call ran, for the flows that run one. */
const commandOf = (input: Fields): string | undefined => text(input.command) ?? text(input.script)

/** A shell call's activity is in its command; only direct invocations of known runners are read. */
const shellActivity = (command: string): Activity => {
  if (/[;&|<>`$\n\r]/.test(command)) return "other"
  const words = command.trim().split(/\s+/), first = words[0] ?? ""
  if (["pytest", "vitest", "jest"].includes(first)) return "tests"
  if (/^python[23]?$/.test(first) && words[1] === "-m" && ["pytest", "unittest"].includes(words[2] ?? "")) return "tests"
  if (first === "bun" && words[1] === "test") return "tests"
  if (["pnpm", "npm", "bun"].includes(first)) {
    if (words[1] === "test" || words[1] === "run" && words[2] === "test") return "tests"
    if (words[1] === "exec" && ["vitest", "jest"].includes(words[2] ?? "")) return "tests"
    if (words[1] === "run" && ["check", "typecheck", "lint"].includes(words[2] ?? "")) return "checks"
  }
  if (first === "go" && words[1] === "test") return "tests"
  if (first === "cargo" && words[1] === "test") return "tests"
  if (first === "tsc") return "checks"
  return "other"
}

/** The record's own descriptor, when it names this call's flow and declares something. */
const recordedSemantics = (payload: Fields, flowName: string): Semantics | undefined => {
  const descriptor = fields(payload.descriptor)
  if (descriptor.name !== flowName) return undefined
  if (descriptor.activity === undefined && descriptor.presentation === undefined) return undefined
  const activity = ACTIVITIES.find(one => one === descriptor.activity)
  const presentation = declaredPresentation(descriptor.presentation)
  return { ...(activity === undefined ? {} : { activity }), ...(presentation === undefined ? {} : { presentation }) }
}

/**
 * The one reading of a recorded call, preferring what the record itself said.
 *
 * A descriptor is what the declaration said when the call was made, so it
 * outranks the compatibility table above. A flow that neither declares a
 * descriptor nor appears in that table is read by nothing, and this oracle
 * refuses rather than guessing what the card will print.
 */
const callSemantics = (seq: number, flowName: string, payload: Fields): Semantics => {
  const declared = recordedSemantics(payload, flowName) ?? LEGACY.get(flowName)
  if (declared === undefined) throw new TimelineEvidenceError("unsupported-evidence", `No independent oracle for ${flowName} at #${seq}.`)
  const activity = declared.activity ?? (flowName === "bash" ? shellActivity(commandOf(fields(payload.input)) ?? "") : undefined)
  return { ...(activity === undefined ? {} : { activity }), ...(declared.presentation === undefined ? {} : { presentation: declared.presentation }) }
}

type Call = {
  seq: number; name: string; id?: string; scope?: string; input: Fields
  result?: unknown; outcome?: string; denied?: boolean; message?: string
} & Semantics
const scope = (p: Fields): string | undefined => {
  if (p.step === undefined) return undefined
  const step = fields(p.step)
  return JSON.stringify([step.executionId, step.stepId, step.attempt, step.ask, step.retry, step.scope, step.generation])
}
type Frame = {
  frame: number; node: string; opens: number; at: number; calls: Call[]
  mutated?: boolean; observed?: boolean; changed: boolean; blocked: boolean
}
export type ExpectedBand = { phase: string; seq: number }
export type ExpectedLine = { node: string; number: string; verb: string; subject: string; result: string }
export type Meaning = {
  frames: Frame[]; bands: ExpectedBand[]; pins: { seq: number; label: string }[]; lines: ExpectedLine[];
  status: string; goals: readonly never[]
}
const READ = "control.agent.cell-call-started"
const RESULT = "control.agent.cell-call-settled"
const OPEN = "control.agent.turn-opened"
/** The name a queued checkpoint mint carries; bookkeeping, never a frame's headline. */
const CHECKPOINT = "checkpoint"

/** The files a V4A patch names, which are what a patch call is about. */
const patched = (patch: string): string[] =>
  patch.split("\n").flatMap(line => /^\*\*\* (?:Add|Delete|Update) File:\s*(\S.*)$/.exec(line.trim())?.[1]?.trim() ?? [])
const pathLabel = (names: readonly string[]): string => names.length === 0 ? "" :
  `${base(names[0]!)}${names.length > 1 ? ` +${names.length - 1}` : ""}`
/** The files an edit-like call names: its `path`, or every file its patch names. */
const paths = (call: Call): string[] => {
  const path = text(call.input.path)
  if (path !== undefined) return [path]
  const patch = text(call.input.input)
  return patch === undefined ? [] : patched(patch)
}

/** What one recorded call was about, in the shape its declaration chose. */
const subject = (call: Call): string => {
  const input = call.input, format = call.presentation?.subject
  if (format === "none") return ""
  if (format === "path") return text(input.path) === undefined ? "" : base(input.path as string)
  if (format === "command") return commandOf(input) ?? ""
  if (format === "patch") return pathLabel(patched(text(input.input) ?? ""))
  if (format === "pattern") return text(input.pattern) ?? ""
  if (format === "selection") return strings(input.selection)?.join(" ") ?? ""
  const path = text(input.path)
  if (path !== undefined) return base(path)
  const command = commandOf(input)
  if (command !== undefined) return command
  const patch = text(input.input)
  if (patch !== undefined && pathLabel(patched(patch)) !== "") return pathLabel(patched(patch))
  const selection = strings(input.selection)
  if (selection !== undefined && selection.length > 0) return selection.join(" ")
  return text(input.pattern) ?? ""
}

/** One quoted line of evidence, bounded the way the card bounds prose. */
const clip = (value: unknown): string | undefined => {
  const line = text(value)
  if (line === undefined || line === "") return undefined
  return line.length <= 160 ? line : `${line.slice(0, 159).trimEnd()}…`
}

/** Measured output fields only, read through the format the declaration chose. */
const measured = (value: unknown, format?: ResultFormat): string => {
  if (format === "none") return ""
  if (typeof value === "string") return clip(value) ?? ""
  const out = fields(value)
  if (out.truncated === true && typeof out.digest === "string") return ""
  switch (format) {
    case "read": {
      const start = whole(out.startLine), end = whole(out.endLine)
      return start !== undefined && start > 0 && end !== undefined && end >= start - 1 ? count(end - start + 1, "line") : ""
    }
    case "write": return whole(out.bytesWritten) === undefined ? "" : count(whole(out.bytesWritten)!, "byte")
    case "edit": return whole(out.replacements) === undefined ? "" : count(whole(out.replacements)!, "replacement")
    case "patch": {
      const groups = [strings(out.added), strings(out.modified), strings(out.deleted)]
      return groups.every(group => group !== undefined) ? count(new Set(groups.flat() as string[]).size, "file") : ""
    }
    case "tests": {
      const passed = whole(out.passed), failed = strings(out.failed), exit = whole(out.exitCode)
      if (out.parsed === true && passed !== undefined && failed !== undefined && out.invalidProbe === undefined) {
        return `${passed} passed${failed.length > 0 ? ` · ${failed.length} failed` : exit !== undefined && exit !== 0 ? ` · exit ${exit}` : ""}`
      }
      return exit === undefined ? "" : `exit ${exit}`
    }
    case "command": return whole(out.exitCode) === undefined ? "" : `exit ${whole(out.exitCode)}`
    case "matches": return Array.isArray(out.matches) ? count(out.matches.length, "match", "matches") : ""
    case "paths": return strings(out.paths) === undefined ? "" : count(strings(out.paths)!.length, "file")
    case "entries": return Array.isArray(out.entries) ? count(out.entries.length, "entry", "entries") : ""
    default: return ""
  }
}

/** A denial settles successfully with the person's refusal, so it reads as a failure. */
const settlement = (call: Call): Outcome =>
  call.outcome === undefined ? "pending" : call.outcome === "failure" || call.denied === true ? "failure" : "success"
const verb = (call: Call, outcome: Outcome): string => call.presentation?.verb[outcome] ??
  `${call.name}${outcome === "pending" ? " pending" : outcome === "failure" ? " failed" : ""}`
const lineResult = (call: Call): string =>
  call.outcome === "failure" ? clip(call.message) ?? "" : measured(call.result, call.presentation?.result)
/** The run header names the same call the row beneath it does, in the same words. */
const headline = (call: Call, outcome: Outcome): string => {
  const said = call.presentation?.verb[outcome] ??
    (outcome === "pending" ? `running ${call.name}` : outcome === "failure" ? `failed ${call.name}` : `finished ${call.name}`)
  const named = subject(call)
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}${named === "" ? "" : ` ${named}`}`
}

/** Read the existing version-one native call records independently of the UI normalizer. */
const callRecords = (rows: readonly JournalRow[]): readonly JournalRow[] => {
  const native = new Map<string, JournalRow>()
  const key = (row: JournalRow): string | undefined => {
    const { kind: journalKind } = row, p = fields(row.payload)
    return (journalKind === READ || journalKind === RESULT) && typeof p.callId === "string" ? JSON.stringify([journalKind, p.callId, scope(p)]) : undefined
  }
  const decoded = rows.map<JournalRow>(row => {
    const p = fields(row.payload)
    if (p.eventType !== "flows.harness.call-fact.v1") return row
    const fact = fields(p.payload), identity = fields(fact.identity)
    // Nested logical sessions belong to their module step facts, not the outer prompt run.
    if (typeof identity.runId === "string" && identity.runId !== row.runId) return row
    if (word(row.kind) !== "control.engine.event" || p.version !== 1 || fact.version !== 1 ||
      !/^cell-call-v1:[0-9a-f]{64}$/.test(word(fact.callId)) || identity.runId !== row.runId ||
      typeof row.runId !== "string" || p.sourceSequence !== 0 ||
      p.sourceId !== `call-fact-v1:${fact.callId}:${fact.phase}` || !["invoked", "settled"].includes(word(fact.phase))) {
      throw new TimelineEvidenceError("unsupported-evidence", `Invalid native call record at #${row.sequence}.`)
    }
    const normalized = { ...row, kind: fact.phase === "invoked" ? READ : RESULT, payload: fact }
    native.set(key(normalized)!, normalized)
    return normalized
  })
  const seen = new Set<string>()
  return decoded.flatMap(row => {
    const id = key(row)
    if (id === undefined) return [row]
    if (seen.has(id)) return []
    seen.add(id)
    return [{ ...(native.get(id) ?? row), sequence: row.sequence }]
  })
}

/**
 * The bounded fixture uses standard filesystem calls and a direct bun test command. Unknown semantics fail closed.
 *
 * Two readings the card makes are deliberately absent here, because neither is
 * a fact the journal states: a `stuck` band, which the card derives from a
 * streak of repeated call readings, and a goal, which needs a recorded plan.
 * A journal that records either is refused rather than half-read.
 */
export const journalMeaning = (rows: ReadonlyArray<JournalRow>, cursor = Infinity): Meaning => {
  const ordered = callRecords([...rows].filter(row => Number(row.sequence) <= cursor).sort((a, b) => Number(a.sequence) - Number(b.sequence)))
  const frames: Frame[] = [], open: Call[] = [], pins: Meaning["pins"] = []
  const written = new Map<Frame, { paths: string[]; pin: Meaning["pins"][number] }>()
  let status = "Running", terminalStatus: string | undefined
  for (const row of ordered) {
    const p = fields(row.payload), seq = Number(row.sequence), frame = frames.at(-1), kind = word(row.kind)
    const nativeState = fields(fields(p.payload).state)
    if (kind.includes("PreparePlan") || [p.flowName, nativeState.flowName].some(name => name === "coding/PreparePlan" || name === "coding/PrepareWithWiki") ||
      fields(p.value).plan !== undefined || fields(nativeState.payload).plan !== undefined ||
      fields(fields(nativeState.payload).input).plan !== undefined || fields(p.input).plan !== undefined) {
      throw new TimelineEvidenceError("unsupported-evidence", `Recorded plan at #${seq} needs a goal oracle; no goal claim was made.`)
    }
    if (kind === OPEN) { frames.push({ frame: frames.length + 1, node: `frame-${frames.length + 1}`, opens: seq,
      at: typeof p.at === "number" ? p.at : typeof row.occurredAt === "number" ? row.occurredAt : seq,
      calls: [], changed: false, blocked: false }); status = "Thinking" }
    if (kind === "control.agent.cell-produced" && open.length === 0) status = "Running code"
    if (kind === READ) {
      const name = word(p.flowName)
      if (name === CHECKPOINT) continue
      const call: Call = { name, seq, input: fields(p.input), ...callSemantics(seq, name, p),
        ...(scope(p) === undefined ? {} : { scope: scope(p) }), ...(typeof p.callId === "string" ? { id: p.callId } : {}) }
      frame?.calls.push(call); open.push(call)
      status = headline(call, "pending")
    }
    if (kind === RESULT) {
      if (p.outcome !== "success" && p.outcome !== "failure") throw new TimelineEvidenceError("unsupported-evidence", `Missing call outcome at #${seq}.`)
      const index = open.findIndex(call => call.scope === scope(p) &&
        (typeof p.callId === "string" ? call.id === p.callId : call.id === undefined && call.name === p.flowName))
      if (index < 0) continue
      const call = open.splice(index, 1)[0]!
      call.result = p.value; call.outcome = word(p.outcome); call.message = word(p.message)
      // An `ask` settles successfully with the person's answer, so a refusal is a denial, not a failure.
      call.denied = call.outcome === "success" && fields(p.value).approved === false
      const owner = frames.find(one => one.calls.includes(call))
      if (call.denied && owner) owner.blocked = true
      if (call.outcome === "success" && !call.denied && call.activity === "writes") {
        const prior = owner === undefined ? undefined : written.get(owner)
        const named = [...new Set([...(prior?.paths ?? []), ...paths(call)])]
        if (prior) { prior.paths = named; prior.pin.label = pathLabel(named) }
        else if (named.length > 0) {
          const pin = { seq, label: pathLabel(named) }
          pins.push(pin)
          if (owner) written.set(owner, { paths: named, pin })
        }
      }
      // The header names whatever is still open, and only an empty desk reports the settlement.
      status = open.length === 0 ? headline(call, call.outcome === "failure" ? "failure" : "success") : headline(open.at(-1)!, "pending")
    }
    if (kind === "control.agent.mutation-observed" && frame) {
      frame.mutated = p.mutated === true
      if (p.basis === "observed" && typeof p.mutated === "boolean") frame.observed = p.mutated
    }
    if ((kind === "control.agent.permission-required" || kind === "control.agent.suspended") && frame) frame.blocked = true
    if (kind === "control.agent.permission-required") pins.push({ seq, label: "permission" })
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
    if (terminal) { terminalStatus = terminal; pins.push({ seq, label: kind.split(".").at(-1)! }) }
  }
  const bands: ExpectedBand[] = [], lines: ExpectedLine[] = []
  for (const frame of frames) {
    // A measured unchanged tree is authoritative even when a write succeeded.
    frame.changed = frame.observed ?? (frame.mutated === true ||
      frame.calls.some(call => call.activity === "writes" && call.outcome === "success" && call.denied !== true))
    const phase = frame.blocked ? "blocked" : frame.changed || frame.calls.some(call => call.activity === "writes") ? "implementing" :
      frame.calls.some(call => call.activity === "checks" || call.activity === "tests") ? "testing" :
      frame.calls.some(call => call.activity === "reads") ? "researching" : "unrecorded"
    if (bands.at(-1)?.phase !== phase) bands.push({ phase, seq: frame.opens })
    // A change it made, else the check it ran, else the first thing it asked for.
    const call = frame.calls.find(one => one.activity === "writes") ??
      frame.calls.find(one => one.activity === "checks" || one.activity === "tests") ?? frame.calls[0]
    if (call) lines.push({ node: frame.node, number: String(frame.frame),
      verb: verb(call, settlement(call)), subject: subject(call), result: lineResult(call) })
  }
  return { frames, bands, pins: pins.sort((a, b) => a.seq - b.seq), lines, status: terminalStatus ?? status, goals: [] }
}

/**
 * The first band whose phase differs from the opening one. Any such band is a
 * second recorded activity phase, and the earliest is the one furthest from the
 * journal's live tail, so the band it names stops moving soonest.
 *
 * A production attempt was read as a tail band refusing a keyboard commit. It
 * was not: the commit assertion passed and the re-check after the reload was
 * what failed, with the app still in its boot skeleton. Band doors at the tail,
 * including one whose band grows under the keypress, are pinned in
 * `e2e/probes/run-trace-phase-strip.test.ts`.
 */
export const requireLaterPhase = (meaning: Meaning): ExpectedBand => {
  const later = meaning.bands.find(band => band.phase !== meaning.bands[0]?.phase)
  if (!later) throw new TimelineEvidenceError("missing-later-phase", "The journal did not record two different phases. A terminal pin proves no later phase.")
  return later
}

export const assertSuccessfulEdit = (status: string, before: string, after: string, marker: string): void => {
  if (status !== "completed" || before.split(/\r?\n/).includes(marker) || after !== `${before}${before.endsWith("\n") ? "" : "\n"}${marker}\n`) {
    throw new TimelineEvidenceError("edit-not-proven", "Success requires a completed run and an independent exact append readback.")
  }
}
