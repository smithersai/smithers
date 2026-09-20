import { journalMeaning, TimelineEvidenceError, type JournalRow, type Meaning } from "./semantic"

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && Number(value) >= minimum
const scopeOf = (row: JournalRow): string | undefined => {
  const step = object(object(row.payload).step)
  return Object.keys(step).length === 0 ? undefined : JSON.stringify([
    step.executionId, step.stepId, step.attempt, step.ask, step.retry, step.scope, step.generation
  ])
}

/** Decode the producer's public wire facts without importing its normalizer or the UI fold. */
export const moduleRows = (rows: readonly JournalRow[]): readonly JournalRow[] => {
  const seen = new Set<string>()
  return [...rows].sort((a, b) => Number(a.sequence) - Number(b.sequence)).flatMap(row => {
    const envelope = object(row.payload)
    if (envelope.eventType !== "flows.harness.step-fact.v1") return [row]
    const fact = object(envelope.payload), step = object(fact.step)
    if (String(row.kind) !== "control.engine.event" || envelope.version !== 1 || fact.version !== 1 ||
      typeof row.runId !== "string" || envelope.executionId !== step.executionId || typeof step.executionId !== "string" ||
      !/^[0-9a-f]{64}$/.test(String(step.stepId)) || typeof step.action !== "string" || typeof step.scope !== "string" ||
      !integer(step.attempt, 1) || !integer(step.retry, 1) || step.ask !== "repair" && !integer(step.ask) ||
      !integer(envelope.generation) || !integer(envelope.sequence) || !integer(fact.generation) || Number(fact.generation) > Number(envelope.generation) ||
      !integer(fact.sourceSequence) || envelope.sourceSequence !== fact.sourceSequence ||
      envelope.sourceId !== `step-fact-v1:${step.stepId}:${step.attempt}:${step.ask}:${step.retry}` ||
      !integer(fact.frame, -1) || !integer(fact.ordinal) || typeof fact.cell !== "string" ||
      typeof fact.at !== "number" || !Number.isFinite(fact.at) || fact.at < 0 ||
      typeof envelope.emittedAtMs !== "number" || !Number.isFinite(envelope.emittedAtMs) || envelope.emittedAtMs < 0 ||
      !/^control\.agent\.[a-z-]+$/.test(String(fact.eventType)) || fact.payload !== object(fact.payload)) {
      throw new TimelineEvidenceError("unsupported-evidence", `Invalid module checkpoint at #${row.sequence}.`)
    }
    const normalized = { ...row, kind: String(fact.eventType), payload: {
      ...object(fact.payload), at: fact.at, step: { ...step, generation: fact.generation, frame: fact.frame, ordinal: fact.ordinal }
    } }
    const identity = JSON.stringify([row.runId, scopeOf(normalized), fact.sourceSequence])
    if (seen.has(identity)) return []
    seen.add(identity)
    return [normalized]
  })
}

/** Frames belong to an invocation; a coincident call id in another step proves no outcome. */
export const moduleMeaning = (rows: readonly JournalRow[], cursor = Infinity): Meaning => {
  const decoded = moduleRows(rows.filter(row => Number(row.sequence) <= cursor))
  const groups = new Map<string | undefined, JournalRow[]>()
  for (const row of decoded) {
    const scope = scopeOf(row), group = groups.get(scope) ?? []
    group.push(row); groups.set(scope, group)
  }
  const meanings = [...groups].map(([scope, group]) => {
    const meaning = journalMeaning(group)
    if (scope === undefined) return meaning
    const prefix = `step:${encodeURIComponent(scope)}/`
    return { ...meaning, frames: meaning.frames.map(frame => ({ ...frame, node: `${prefix}${frame.node}` })),
      lines: meaning.lines.map(line => ({ ...line, node: `${prefix}${line.node}` })) }
  })
  const statusRows = decoded.map(row => {
    const payload = object(row.payload), scope = scopeOf(row)
    return scope === undefined || typeof payload.callId !== "string" ? row
      : { ...row, payload: { ...payload, callId: JSON.stringify([scope, payload.callId]) } }
  })
  const frames = meanings.flatMap(one => one.frames).sort((a, b) => a.at - b.at || a.opens - b.opens)
  const position = new Map(frames.map((frame, index) => [frame.node, index]))
  const at = new Map(frames.map(frame => [frame.opens, frame.at]))
  return {
    frames,
    bands: meanings.flatMap(one => one.bands).sort((a, b) => (at.get(a.seq) ?? a.seq) - (at.get(b.seq) ?? b.seq) || a.seq - b.seq),
    pins: meanings.flatMap(one => one.pins).sort((a, b) => a.seq - b.seq),
    lines: meanings.flatMap(one => one.lines).sort((a, b) => position.get(a.node)! - position.get(b.node)!),
    status: journalMeaning(statusRows).status, goals: []
  }
}
