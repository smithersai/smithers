import { cancelRunInputSchema, resumeRunInputSchema, startRunInputSchema } from "@burns/shared"

import {
  getLatestRunEventSeq,
  listRunEvents,
  persistSmithersEvent,
} from "@/services/run-event-service"
import {
  cancelRun,
  connectRunEventStream,
  getRun,
  listRuns,
  resumeRun,
  startRun,
} from "@/services/smithers-service"
import { syncApprovalFromEvent } from "@/services/approval-service"
import { toErrorResponse } from "@/utils/http-error"

const MAX_BACKGROUND_EVENT_STREAMS = 32
const BACKGROUND_EVENT_RETRY_BASE_MS = 500
const BACKGROUND_EVENT_RETRY_MAX_MS = 10_000
const BACKGROUND_EVENT_IDLE_TIMEOUT_MS = 15 * 60 * 1_000
const RUN_EVENTS_HEARTBEAT_INTERVAL_MS = 15_000

type BackgroundEventIngestion = {
  key: string
  workspaceId: string
  runId: string
  retryAttempt: number
  lastSeq: number
  lastActivityAt: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  streamReader: { cancel: () => Promise<void> } | null
  stopped: boolean
}

type UpstreamStreamExitReason = "closed" | "non-sse" | "terminal"

const backgroundEventIngestions = new Map<string, BackgroundEventIngestion>()

function parseAfterSeq(request: Request) {
  const rawValue = new URL(request.url).searchParams.get("afterSeq")
  if (!rawValue) {
    return 0
  }

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0
  }

  return Math.floor(parsed)
}

function buildBackgroundIngestionKey(workspaceId: string, runId: string) {
  return `${workspaceId}:${runId}`
}

function readLatestPersistedSeq(workspaceId: string, runId: string) {
  return getLatestRunEventSeq(workspaceId, runId)
}

function normalizeEventFrame(frame: string) {
  return frame.replaceAll("\r\n", "\n")
}

function getFrameBoundaryIndex(buffer: string) {
  return buffer.indexOf("\n\n")
}

function extractSmithersPayloadFromFrame(frame: string) {
  if (!frame.trim()) {
    return null
  }

  const lines = normalizeEventFrame(frame).split("\n")
  let eventName = "message"
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim()
      continue
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart())
    }
  }

  if (eventName !== "smithers" || dataLines.length === 0) {
    return null
  }

  try {
    return JSON.parse(dataLines.join("\n"))
  } catch {
    return null
  }
}

function maybeSyncApprovalFromPersistedEvent(
  workspaceId: string,
  event: { runId: string; nodeId?: string; type: string; message?: string }
) {
  if (!event.nodeId) {
    return
  }

  const lowerType = event.type.toLowerCase()

  if (!lowerType.includes("approval")) {
    return
  }

  if (lowerType.includes("approved")) {
    syncApprovalFromEvent({
      workspaceId,
      runId: event.runId,
      nodeId: event.nodeId,
      status: "approved",
      message: event.message,
    })
    return
  }

  if (lowerType.includes("denied") || lowerType.includes("rejected")) {
    syncApprovalFromEvent({
      workspaceId,
      runId: event.runId,
      nodeId: event.nodeId,
      status: "denied",
      message: event.message,
    })
    return
  }

  if (
    lowerType.includes("wait") ||
    lowerType.includes("pending") ||
    lowerType.includes("needs")
  ) {
    syncApprovalFromEvent({
      workspaceId,
      runId: event.runId,
      nodeId: event.nodeId,
      status: "pending",
      message: event.message,
    })
  }
}

function persistRunEventFromSmithersPayload(workspaceId: string, runId: string, payload: unknown) {
  const persistedEvent = persistSmithersEvent(workspaceId, runId, payload)
  maybeSyncApprovalFromPersistedEvent(workspaceId, persistedEvent)
  return persistedEvent
}

function isTerminalEventType(type: string) {
  const normalizedType = type.toLowerCase()
  return (
    normalizedType.includes("finished") ||
    normalizedType.includes("completed") ||
    normalizedType.includes("failed") ||
    normalizedType.includes("cancelled") ||
    normalizedType.includes("canceled")
  )
}

function clearBackgroundIngestionTimer(state: BackgroundEventIngestion) {
  if (!state.reconnectTimer) {
    return
  }

  clearTimeout(state.reconnectTimer)
  state.reconnectTimer = null
}

function stopBackgroundEventIngestion(state: BackgroundEventIngestion) {
  if (state.stopped) {
    return
  }

  state.stopped = true
  clearBackgroundIngestionTimer(state)
  backgroundEventIngestions.delete(state.key)

  if (state.streamReader) {
    void state.streamReader.cancel().catch(() => {
      // Ignore stream cancellation errors during teardown.
    })
    state.streamReader = null
  }
}

function enforceBackgroundIngestionLimit() {
  if (backgroundEventIngestions.size < MAX_BACKGROUND_EVENT_STREAMS) {
    return
  }

  let stalestState: BackgroundEventIngestion | null = null
  for (const ingestionState of backgroundEventIngestions.values()) {
    if (
      !stalestState ||
      ingestionState.lastActivityAt < stalestState.lastActivityAt
    ) {
      stalestState = ingestionState
    }
  }

  if (stalestState) {
    stopBackgroundEventIngestion(stalestState)
  }
}

async function consumeUpstreamRunEventStream(params: {
  workspaceId: string
  runId: string
  afterSeq: number
  onPayload: (payload: unknown) => UpstreamStreamExitReason | null
  onFrame?: (frame: string) => Promise<void> | void
  onReaderOpen?: (reader: { cancel: () => Promise<void> }) => void
  onReaderClose?: () => void
}): Promise<UpstreamStreamExitReason> {
  const upstream = await connectRunEventStream(params.workspaceId, params.runId, params.afterSeq)
  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("text/event-stream")) {
    return "non-sse"
  }

  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  params.onReaderOpen?.(reader)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.trim()) {
          const trailingFrame = normalizeEventFrame(buffer)
          await params.onFrame?.(trailingFrame)
          const payload = extractSmithersPayloadFromFrame(trailingFrame)
          const exitReason = payload ? params.onPayload(payload) : null
          if (exitReason) {
            return exitReason
          }
          buffer = ""
        }

        return "closed"
      }

      buffer += normalizeEventFrame(decoder.decode(value, { stream: true }))

      let splitIndex = getFrameBoundaryIndex(buffer)
      while (splitIndex >= 0) {
        const frame = buffer.slice(0, splitIndex)
        buffer = buffer.slice(splitIndex + 2)

        await params.onFrame?.(frame)

        const payload = extractSmithersPayloadFromFrame(frame)
        if (!payload) {
          splitIndex = getFrameBoundaryIndex(buffer)
          continue
        }

        const exitReason = params.onPayload(payload)
        if (exitReason) {
          return exitReason
        }

        splitIndex = getFrameBoundaryIndex(buffer)
      }
    }
  } finally {
    params.onReaderClose?.()
    await reader.cancel().catch(() => {
      // Ignore stream close races.
    })
  }
}

function scheduleBackgroundEventIngestion(state: BackgroundEventIngestion) {
  if (state.stopped || state.reconnectTimer) {
    return
  }

  const delayMs = Math.min(
    BACKGROUND_EVENT_RETRY_MAX_MS,
    BACKGROUND_EVENT_RETRY_BASE_MS * 2 ** Math.max(state.retryAttempt - 1, 0)
  )

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null
    void runBackgroundEventIngestion(state)
  }, delayMs)
  state.reconnectTimer.unref()
}

async function runBackgroundEventIngestion(state: BackgroundEventIngestion) {
  if (state.stopped) {
    return
  }

  if (Date.now() - state.lastActivityAt > BACKGROUND_EVENT_IDLE_TIMEOUT_MS) {
    stopBackgroundEventIngestion(state)
    return
  }

  try {
    let sawEvent = false
    const exitReason = await consumeUpstreamRunEventStream({
      workspaceId: state.workspaceId,
      runId: state.runId,
      afterSeq: state.lastSeq,
      onReaderOpen: (reader) => {
        state.streamReader = reader
      },
      onReaderClose: () => {
        state.streamReader = null
      },
      onPayload: (payload) => {
        const persistedEvent = persistRunEventFromSmithersPayload(
          state.workspaceId,
          state.runId,
          payload
        )
        sawEvent = true
        state.lastSeq = getLatestRunEventSeq(state.workspaceId, state.runId)
        state.lastActivityAt = Date.now()

        return isTerminalEventType(persistedEvent.type) ? "terminal" : null
      },
    })

    if (state.stopped || exitReason === "terminal" || exitReason === "non-sse") {
      stopBackgroundEventIngestion(state)
      return
    }

    state.retryAttempt = sawEvent ? 1 : state.retryAttempt + 1
    scheduleBackgroundEventIngestion(state)
  } catch {
    if (state.stopped) {
      return
    }

    state.retryAttempt += 1
    scheduleBackgroundEventIngestion(state)
  }
}

function ensureBackgroundEventIngestion(workspaceId: string, runId: string) {
  const key = buildBackgroundIngestionKey(workspaceId, runId)
  const existingState = backgroundEventIngestions.get(key)
  if (existingState) {
    existingState.lastActivityAt = Date.now()
    return
  }

  enforceBackgroundIngestionLimit()

  const state: BackgroundEventIngestion = {
    key,
    workspaceId,
    runId,
    retryAttempt: 1,
    lastSeq: readLatestPersistedSeq(workspaceId, runId),
    lastActivityAt: Date.now(),
    reconnectTimer: null,
    streamReader: null,
    stopped: false,
  }

  backgroundEventIngestions.set(key, state)
  void runBackgroundEventIngestion(state)
}

async function createEventProxyStream(workspaceId: string, runId: string, afterSeq: number) {
  const encoder = new TextEncoder()
  const ingestionKey = buildBackgroundIngestionKey(workspaceId, runId)
  let streamReader: { cancel: () => Promise<void> } | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let closed = false

  const clearHeartbeat = () => {
    if (!heartbeatTimer) {
      return
    }

    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  const enqueueFrame = (controller: ReadableStreamDefaultController<Uint8Array>, frame: string) => {
    if (closed) {
      return
    }

    controller.enqueue(encoder.encode(`${frame}\n\n`))
  }
  const shouldPersistInProxy = () => {
    const activeIngestion = backgroundEventIngestions.get(ingestionKey)
    return !activeIngestion || activeIngestion.streamReader === null
  }

  return new ReadableStream({
    async start(controller) {
      heartbeatTimer = setInterval(() => {
        // SSE comment frame to keep long-running idle streams alive.
        enqueueFrame(controller, ": heartbeat")
      }, RUN_EVENTS_HEARTBEAT_INTERVAL_MS)

      let streamResult: UpstreamStreamExitReason
      try {
        streamResult = await consumeUpstreamRunEventStream({
          workspaceId,
          runId,
          afterSeq,
          onReaderOpen: (reader) => {
            streamReader = reader
          },
          onReaderClose: () => {
            streamReader = null
          },
          onPayload: (payload) => {
            if (shouldPersistInProxy()) {
              persistRunEventFromSmithersPayload(workspaceId, runId, payload)
            }

            return null
          },
          onFrame: (frame) => {
            enqueueFrame(controller, frame)
          },
        })
      } catch (error) {
        closed = true
        clearHeartbeat()
        controller.error(error)
        return
      }

      if (streamResult === "non-sse") {
        closed = true
        clearHeartbeat()
        controller.error(new Error("Smithers upstream did not return an SSE stream"))
        return
      }

      closed = true
      clearHeartbeat()
      controller.close()
    },
    async cancel() {
      closed = true
      clearHeartbeat()
      if (!streamReader) {
        return
      }

      await streamReader.cancel().catch(() => {
        // Ignore stream cancellation races on client disconnect.
      })
      streamReader = null
    },
  })
}

export async function handleRunRoutes(request: Request, pathname: string) {
  try {
    const runsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runs$/)
    if (runsMatch && request.method === "GET") {
      return Response.json(await listRuns(runsMatch[1]))
    }

    if (runsMatch && request.method === "POST") {
      const input = startRunInputSchema.parse(await request.json().catch(() => null))
      const run = await startRun(runsMatch[1], input)
      ensureBackgroundEventIngestion(run.workspaceId, run.id)
      return Response.json(run, { status: 201 })
    }

    const runResumeMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/resume$/)
    if (runResumeMatch && request.method === "POST") {
      const input = resumeRunInputSchema.parse(await request.json().catch(() => null))
      const run = await resumeRun(runResumeMatch[1], runResumeMatch[2], input)
      ensureBackgroundEventIngestion(run.workspaceId, run.id)
      return Response.json(run)
    }

    const runCancelMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/cancel$/)
    if (runCancelMatch && request.method === "POST") {
      const input = cancelRunInputSchema.parse(await request.json().catch(() => null))
      return Response.json(await cancelRun(runCancelMatch[1], runCancelMatch[2], input))
    }

    const runEventsStreamMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/events\/stream$/
    )
    if (runEventsStreamMatch && request.method === "GET") {
      const afterSeq = parseAfterSeq(request)
      ensureBackgroundEventIngestion(runEventsStreamMatch[1], runEventsStreamMatch[2])
      const stream = await createEventProxyStream(
        runEventsStreamMatch[1],
        runEventsStreamMatch[2],
        afterSeq
      )

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      })
    }

    const runEventsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/events$/)
    if (runEventsMatch && request.method === "GET") {
      const afterSeq = parseAfterSeq(request)
      ensureBackgroundEventIngestion(runEventsMatch[1], runEventsMatch[2])
      return Response.json(listRunEvents(runEventsMatch[1], runEventsMatch[2], afterSeq))
    }

    const runDetailMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)$/)
    if (runDetailMatch && request.method === "GET") {
      return Response.json(await getRun(runDetailMatch[1], runDetailMatch[2]))
    }

    return null
  } catch (error) {
    return toErrorResponse(error)
  }
}
