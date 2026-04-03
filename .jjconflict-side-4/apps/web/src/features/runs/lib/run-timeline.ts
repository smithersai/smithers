import type { RunEvent } from "@burns/shared"

type NodeRunStatus = "running" | "completed" | "failed"

export type NodeRunTimelineItem = {
  id: string
  nodeId: string
  iteration: number
  attempt: number
  status: NodeRunStatus
  firstSeq: number
  lastSeq: number
  startedAt?: string
  finishedAt?: string
  outputText: string
}

type NodeRunAccumulator = NodeRunTimelineItem & {
  hasStarted: boolean
  hasFinished: boolean
  hasFailed: boolean
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

function stripSeqFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripSeqFields(entry))
  }

  if (!value || typeof value !== "object") {
    return value
  }

  const objectValue = value as Record<string, unknown>
  const normalized: Record<string, unknown> = {}
  const keys = Object.keys(objectValue).sort()
  for (const key of keys) {
    if (key === "seq") {
      continue
    }

    normalized[key] = stripSeqFields(objectValue[key])
  }

  return normalized
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`
  }

  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>
    const keys = Object.keys(objectValue).sort()
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
      .join(",")}}`
  }

  return JSON.stringify(value) ?? "null"
}

function buildDisplayDedupeKey(event: RunEvent) {
  return stableStringify({
    type: event.type,
    timestamp: event.timestamp,
    nodeId: event.nodeId ?? null,
    message: event.message ?? null,
    payload: event.rawPayload !== undefined ? stripSeqFields(event.rawPayload) : null,
  })
}

function maybeDecodeDoubleEscapedText(value: string) {
  const trimmed = value.trim()
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return value
  }

  try {
    const parsed = JSON.parse(trimmed)
    return typeof parsed === "string" ? parsed : value
  } catch {
    return value
  }
}

const AGENT_LABELS = new Set(["codex", "claude", "gemini", "kimi", "pi", "forge"])

function isAgentLabelLine(line: string) {
  return AGENT_LABELS.has(line.trim().toLowerCase())
}

function isExecMarkerLine(line: string) {
  const trimmed = line.trim()
  return (
    trimmed === "exec" ||
    trimmed === "tokens used" ||
    trimmed.startsWith("succeeded in ") ||
    trimmed.startsWith(" succeeded in ")
  )
}

function maybeStandaloneJsonText(value: string) {
  const trimmed = value.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null
  }

  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    return null
  }
}

export function extractAgentOutputFromChunk(value: string) {
  const standaloneJson = maybeStandaloneJsonText(value)
  if (standaloneJson) {
    return standaloneJson
  }

  const lines = value.replaceAll("\r\n", "\n").split("\n")
  const sections: string[] = []
  let collectingAgentOutput = false
  let currentSectionLines: string[] = []

  const flushSection = () => {
    if (currentSectionLines.length === 0) {
      return
    }

    const sectionText = currentSectionLines.join("\n").trim()
    if (sectionText) {
      sections.push(sectionText)
    }
    currentSectionLines = []
  }

  for (const line of lines) {
    if (isAgentLabelLine(line)) {
      flushSection()
      collectingAgentOutput = true
      continue
    }

    if (isExecMarkerLine(line)) {
      flushSection()
      collectingAgentOutput = false
      continue
    }

    if (collectingAgentOutput) {
      currentSectionLines.push(line)
    }
  }

  flushSection()
  return sections.join("\n\n").trim()
}

const MOJIBAKE_REPLACEMENTS: ReadonlyArray<[string, string]> = [
  ["\u00e2\u20ac\u2122", "\u2019"],
  ["\u00e2\u20ac\u02dc", "\u2018"],
  ["\u00e2\u20ac\u0153", "\u201c"],
  ["\u00e2\u20ac\u009d", "\u201d"],
  ["\u00e2\u20ac\u201d", "\u2014"],
  ["\u00e2\u20ac\u201c", "\u2013"],
  ["\u00e2\u20ac\u00a6", "\u2026"],
  ["\u00c2 ", " "],
  ["\u00c2", ""],
]

function repairMojibake(value: string) {
  if (!/[\u00e2\u00c2]/.test(value)) {
    return value
  }

  let repaired = value
  for (const [from, to] of MOJIBAKE_REPLACEMENTS) {
    repaired = repaired.replaceAll(from, to)
  }

  return repaired
}

function normalizeOutputTextChunk(value: string) {
  const agentOnly = extractAgentOutputFromChunk(value)
  const trimmedValue = value.trim()
  if (!agentOnly && trimmedValue.startsWith("exec\n")) {
    return ""
  }

  const textToDisplay = agentOnly || trimmedValue
  if (!textToDisplay) {
    return ""
  }

  const maybeDecoded = maybeDecodeDoubleEscapedText(textToDisplay)
  return repairMojibake(maybeDecoded)
}

function appendOutputChunk(existing: string, nextChunk: string) {
  if (!existing) {
    return nextChunk
  }

  const separator = existing.endsWith("\n") || nextChunk.startsWith("\n") ? "" : "\n"
  return `${existing}${separator}${nextChunk}`
}

function getNodeOutputText(event: RunEvent) {
  const payload = asObject(event.rawPayload)
  const text = asString(payload?.text)
  if (text !== undefined) {
    return text
  }

  return event.message
}

function getNodeIterationAttempt(event: RunEvent) {
  const payload = asObject(event.rawPayload)
  return {
    iteration: Math.max(0, Math.floor(asNumber(payload?.iteration) ?? 0)),
    attempt: Math.max(1, Math.floor(asNumber(payload?.attempt) ?? 1)),
  }
}

function getNodeRunKey(nodeId: string, iteration: number, attempt: number) {
  return `${nodeId}::${iteration}::${attempt}`
}

function isNodeTerminalFailureEvent(event: RunEvent) {
  const normalizedType = event.type.toLowerCase()
  return (
    normalizedType.includes("failed") ||
    normalizedType.includes("error") ||
    normalizedType.includes("cancelled") ||
    normalizedType.includes("canceled")
  )
}

export function buildNodeRunTimeline(events: RunEvent[]) {
  const dedupeKeys = new Set<string>()
  const nodeRuns = new Map<string, NodeRunAccumulator>()
  const orderedKeys: string[] = []

  for (const event of events) {
    if (!event.nodeId) {
      continue
    }

    const eventDedupeKey = buildDisplayDedupeKey(event)
    if (dedupeKeys.has(eventDedupeKey)) {
      continue
    }
    dedupeKeys.add(eventDedupeKey)

    const { iteration, attempt } = getNodeIterationAttempt(event)
    const nodeRunKey = getNodeRunKey(event.nodeId, iteration, attempt)
    let nodeRun = nodeRuns.get(nodeRunKey)
    if (!nodeRun) {
      nodeRun = {
        id: nodeRunKey,
        nodeId: event.nodeId,
        iteration,
        attempt,
        status: "running",
        firstSeq: event.seq,
        lastSeq: event.seq,
        startedAt: event.timestamp,
        finishedAt: undefined,
        outputText: "",
        hasStarted: false,
        hasFinished: false,
        hasFailed: false,
      }
      nodeRuns.set(nodeRunKey, nodeRun)
      orderedKeys.push(nodeRunKey)
    }

    nodeRun.firstSeq = Math.min(nodeRun.firstSeq, event.seq)
    nodeRun.lastSeq = Math.max(nodeRun.lastSeq, event.seq)
    nodeRun.startedAt = nodeRun.startedAt ?? event.timestamp

    if (event.type === "NodeStarted") {
      nodeRun.hasStarted = true
      nodeRun.startedAt = nodeRun.startedAt ?? event.timestamp
    }

    if (event.type === "NodeFinished") {
      nodeRun.hasFinished = true
      nodeRun.finishedAt = event.timestamp
    }

    if (isNodeTerminalFailureEvent(event)) {
      nodeRun.hasFailed = true
      nodeRun.finishedAt = nodeRun.finishedAt ?? event.timestamp
    }

    if (event.type === "NodeOutput") {
      const outputText = getNodeOutputText(event)
      if (outputText) {
        const normalizedChunk = normalizeOutputTextChunk(outputText)
        nodeRun.outputText = appendOutputChunk(nodeRun.outputText, normalizedChunk)
      }
    }
  }

  return orderedKeys
    .map((key) => nodeRuns.get(key)!)
    .map<NodeRunTimelineItem>((nodeRun) => {
      let status: NodeRunStatus = "running"
      if (nodeRun.hasFailed) {
        status = "failed"
      } else if (nodeRun.hasFinished) {
        status = "completed"
      }

      return {
        id: nodeRun.id,
        nodeId: nodeRun.nodeId,
        iteration: nodeRun.iteration,
        attempt: nodeRun.attempt,
        status,
        firstSeq: nodeRun.firstSeq,
        lastSeq: nodeRun.lastSeq,
        startedAt: nodeRun.startedAt,
        finishedAt: nodeRun.finishedAt,
        outputText: nodeRun.outputText,
      }
    })
}
