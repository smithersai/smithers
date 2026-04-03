import type {
  WorkflowAuthoringStreamEvent,
  WorkflowAuthoringAgentEvent,
} from "@burns/shared"

const MAX_ITEMS = 220
const MAX_ITEM_TEXT = 24_000
const MAX_PENDING_UNSTRUCTURED_LINES = 120

const RUNTIME_METADATA_MARKERS = [
  "\"mcp_servers\"",
  "\"slash_commands\"",
  "\"permissionmode\"",
  "\"claude_code_version\"",
  "\"apikeysource\"",
  "\"plugins\"",
  "\"skills\"",
]

function truncateInline(value: string, maxLength = 320) {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength - 1)}…`
}

function isLikelyRuntimeMetadataBlob(value: string) {
  const lower = value.toLowerCase()
  let matchCount = 0
  for (const marker of RUNTIME_METADATA_MARKERS) {
    if (lower.includes(marker)) {
      matchCount += 1
    }
  }

  return matchCount >= 3
}

function sanitizeThoughtLine(rawLine: string): string | null {
  const line = rawLine.trim()
  if (!line) {
    return null
  }

  if (isLikelyRuntimeMetadataBlob(line)) {
    return "Tool output omitted (runtime metadata)."
  }

  const toolErrorMatch = line.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/i)
  if (toolErrorMatch?.[1]) {
    return `Tool error: ${truncateInline(toolErrorMatch[1].trim(), 240)}`
  }

  const numberedReadLines = line.split("\n").filter((entry) => /^\s*\d+→/.test(entry))
  if (numberedReadLines.length > 25) {
    return `Read output (${numberedReadLines.length} lines)`
  }

  if (line.length > 2_000) {
    const lower = line.toLowerCase()
    const looksLikeError =
      lower.includes("error") ||
      lower.includes("failed") ||
      lower.includes("denied") ||
      lower.includes("exception") ||
      lower.includes("timeout")
    if (!looksLikeError) {
      return null
    }

    return truncateInline(line, 400)
  }

  return line
}

export type WorkflowAuthoringConversationItem =
  | {
      id: string
      type: "chain"
      text: string
      isStreaming: boolean
    }
  | {
      id: string
      type: "message"
      from: "assistant"
      text: string
    }

export type WorkflowAuthoringConversationState = {
  items: WorkflowAuthoringConversationItem[]
  activeChainId: string | null
  sawStructuredEvents: boolean
  didShowStartupLine: boolean
  pendingUnstructuredLines: string[]
  pendingUnstructuredBuffer: string
  lastAssistantMessage: string | null
  nextId: number
}

function truncateText(value: string) {
  if (value.length <= MAX_ITEM_TEXT) {
    return value
  }

  return value.slice(value.length - MAX_ITEM_TEXT)
}

function closeActiveChain(state: WorkflowAuthoringConversationState): WorkflowAuthoringConversationState {
  if (!state.activeChainId) {
    return state
  }

  return {
    ...state,
    activeChainId: null,
    items: state.items.map((item) =>
      item.type === "chain" && item.id === state.activeChainId
        ? { ...item, isStreaming: false }
        : item
    ),
  }
}

function addItem(
  state: WorkflowAuthoringConversationState,
  item: WorkflowAuthoringConversationItem
): WorkflowAuthoringConversationState {
  const nextItems = [...state.items, item]
  const cappedItems =
    nextItems.length > MAX_ITEMS ? nextItems.slice(nextItems.length - MAX_ITEMS) : nextItems

  return {
    ...state,
    items: cappedItems,
  }
}

function appendThoughtLine(
  state: WorkflowAuthoringConversationState,
  rawLine: string
): WorkflowAuthoringConversationState {
  const line = sanitizeThoughtLine(rawLine)
  if (!line) {
    return state
  }

  if (!state.activeChainId) {
    const chainId = `chain-${state.nextId}`
    const nextState = addItem(state, {
      id: chainId,
      type: "chain",
      text: truncateText(line),
      isStreaming: true,
    })

    return {
      ...nextState,
      activeChainId: chainId,
      nextId: state.nextId + 1,
    }
  }

  return {
    ...state,
    items: state.items.map((item) => {
      if (item.type !== "chain" || item.id !== state.activeChainId) {
        return item
      }

      const nextText = item.text ? `${item.text}\n${line}` : line
      return {
        ...item,
        text: truncateText(nextText),
        isStreaming: true,
      }
    }),
  }
}

function appendAssistantMessage(
  state: WorkflowAuthoringConversationState,
  rawText: string
): WorkflowAuthoringConversationState {
  const text = rawText.trim()
  if (!text) {
    return state
  }

  const closedState = closeActiveChain(state)
  const nextId = `message-${closedState.nextId}`
  const nextState = addItem(closedState, {
    id: nextId,
    type: "message",
    from: "assistant",
    text: truncateText(text),
  })

  return {
    ...nextState,
    nextId: closedState.nextId + 1,
    lastAssistantMessage: text,
  }
}

function appendStartupLine(state: WorkflowAuthoringConversationState) {
  if (state.didShowStartupLine) {
    return state
  }

  const nextState = appendThoughtLine(state, "Starting up...")
  return {
    ...nextState,
    didShowStartupLine: true,
  }
}

function enqueueUnstructuredOutput(
  state: WorkflowAuthoringConversationState,
  rawChunk: string
): WorkflowAuthoringConversationState {
  if (!rawChunk) {
    return state
  }

  const combined = `${state.pendingUnstructuredBuffer}${rawChunk}`
  const splitLines = combined.split("\n")
  const trailing = splitLines.pop() ?? ""
  const nextLines = [...state.pendingUnstructuredLines]

  for (const rawLine of splitLines) {
    const sanitized = sanitizeThoughtLine(rawLine)
    if (sanitized) {
      nextLines.push(sanitized)
    }
  }

  return {
    ...state,
    pendingUnstructuredLines:
      nextLines.length > MAX_PENDING_UNSTRUCTURED_LINES
        ? nextLines.slice(nextLines.length - MAX_PENDING_UNSTRUCTURED_LINES)
        : nextLines,
    pendingUnstructuredBuffer: trailing.slice(-MAX_ITEM_TEXT),
  }
}

function flushUnstructuredOutput(
  state: WorkflowAuthoringConversationState
): WorkflowAuthoringConversationState {
  const trailing = sanitizeThoughtLine(state.pendingUnstructuredBuffer)
  const lines = trailing
    ? [...state.pendingUnstructuredLines, trailing]
    : [...state.pendingUnstructuredLines]

  let nextState: WorkflowAuthoringConversationState = {
    ...state,
    pendingUnstructuredLines: [],
    pendingUnstructuredBuffer: "",
  }

  for (const line of lines) {
    nextState = appendThoughtLine(nextState, line)
  }

  return nextState
}

function formatThoughtFromAgentEvent(event: WorkflowAuthoringAgentEvent) {
  if (event.message?.trim()) {
    return event.message.trim()
  }

  if (event.title?.trim()) {
    if (event.phase) {
      return `${event.phase} ${event.title}`
    }
    return event.title.trim()
  }

  return ""
}

function resolveEntryType(event: WorkflowAuthoringAgentEvent): "thought" | "message" {
  if (event.entryType) {
    return event.entryType
  }

  if (event.actionKind === "note" && event.title?.toLowerCase() === "assistant") {
    return "message"
  }

  return "thought"
}

function isStartupStatusStage(stage: string) {
  return stage === "preparing" || stage === "running-agent"
}

function isStartupThoughtLine(line: string) {
  const normalized = line.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  if (normalized.startsWith("session started")) {
    return true
  }

  return (
    normalized === "running bash" ||
    normalized === "started bash" ||
    normalized === "completed bash"
  )
}

export function createInitialWorkflowAuthoringConversationState(): WorkflowAuthoringConversationState {
  return {
    items: [],
    activeChainId: null,
    sawStructuredEvents: false,
    didShowStartupLine: false,
    pendingUnstructuredLines: [],
    pendingUnstructuredBuffer: "",
    lastAssistantMessage: null,
    nextId: 1,
  }
}

export function finalizeWorkflowAuthoringConversationState(
  state: WorkflowAuthoringConversationState
) {
  const stateWithFallbackOutput = state.sawStructuredEvents ? state : flushUnstructuredOutput(state)
  return closeActiveChain(stateWithFallbackOutput)
}

export function applyWorkflowAuthoringStreamEvent(
  previousState: WorkflowAuthoringConversationState,
  event: WorkflowAuthoringStreamEvent
): WorkflowAuthoringConversationState {
  if (event.type === "status") {
    if (isStartupStatusStage(event.stage)) {
      return appendStartupLine(previousState)
    }

    return appendThoughtLine(previousState, `[${event.stage}] ${event.message}`)
  }

  if (event.type === "error") {
    const stateWithFallbackOutput = previousState.sawStructuredEvents
      ? previousState
      : flushUnstructuredOutput(previousState)
    return appendThoughtLine(closeActiveChain(stateWithFallbackOutput), `error: ${event.message}`)
  }

  if (event.type === "agent-output") {
    if (previousState.sawStructuredEvents) {
      return previousState
    }

    return enqueueUnstructuredOutput(previousState, event.chunk)
  }

  if (event.type === "result") {
    if (previousState.sawStructuredEvents) {
      return previousState
    }
    return flushUnstructuredOutput(previousState)
  }

  if (event.type !== "agent-event") {
    return previousState
  }

  let state: WorkflowAuthoringConversationState = {
    ...previousState,
    sawStructuredEvents: true,
    pendingUnstructuredLines: [],
    pendingUnstructuredBuffer: "",
  }

  if (event.eventType === "action") {
    if (resolveEntryType(event) === "message") {
      return appendAssistantMessage(state, event.message ?? event.title ?? "")
    }

    const thoughtLine = formatThoughtFromAgentEvent(event)
    if (isStartupThoughtLine(thoughtLine)) {
      return appendStartupLine(state)
    }

    return appendThoughtLine(state, thoughtLine)
  }

  if (event.eventType === "completed") {
    state = closeActiveChain(state)

    if (event.answer?.trim() && event.answer.trim() !== state.lastAssistantMessage) {
      state = appendAssistantMessage(state, event.answer)
    }

    if (event.ok === false && event.error?.trim()) {
      state = appendThoughtLine(state, `run failed: ${event.error}`)
    }

    return state
  }

  if (event.eventType === "started") {
    return appendStartupLine(state)
  }

  return state
}
