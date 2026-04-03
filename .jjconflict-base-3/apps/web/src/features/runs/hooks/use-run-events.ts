import type { RunEvent } from "@burns/shared"

import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

const RECONNECT_DELAY_BASE_MS = 500
const RECONNECT_DELAY_MAX_MS = 5000

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

function buildEventReplayKey(event: RunEvent) {
  return stableStringify({
    type: event.type,
    timestamp: event.timestamp,
    nodeId: event.nodeId ?? null,
    message: event.message ?? null,
    payload: event.rawPayload !== undefined ? stripSeqFields(event.rawPayload) : null,
  })
}

function normalizeEventPayload(payload: unknown, fallbackRunId: string, fallbackSeq: number): RunEvent {
  const asObject =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}

  const seqValue = asObject.seq
  const parsedSeq =
    typeof seqValue === "number"
      ? seqValue
      : typeof seqValue === "string"
        ? Number(seqValue)
        : fallbackSeq

  return {
    seq: Number.isFinite(parsedSeq) ? Math.floor(parsedSeq) : fallbackSeq,
    runId: typeof asObject.runId === "string" ? asObject.runId : fallbackRunId,
    type: typeof asObject.type === "string" ? asObject.type : "smithers.event",
    timestamp:
      typeof asObject.timestamp === "string" ? asObject.timestamp : new Date().toISOString(),
    nodeId: typeof asObject.nodeId === "string" ? asObject.nodeId : undefined,
    message: typeof asObject.message === "string" ? asObject.message : undefined,
    rawPayload: payload,
  }
}

export function getLastRunEventSeq(events: RunEvent[]) {
  return events[events.length - 1]?.seq
}

export function getSseReconnectDelayMs(reconnectAttempts: number) {
  return Math.min(RECONNECT_DELAY_MAX_MS, RECONNECT_DELAY_BASE_MS * 2 ** reconnectAttempts)
}

type UseRunEventsOptions = {
  enableStream?: boolean
  refetchIntervalMs?: number | false
}

export function useRunEvents(workspaceId?: string, runId?: string, options?: UseRunEventsOptions) {
  const queryClient = useQueryClient()
  const queryKey = ["run-events", workspaceId, runId] as const
  const enableStream = options?.enableStream ?? true
  const refetchIntervalMs = options?.refetchIntervalMs ?? 5000

  const query = useQuery({
    queryKey,
    queryFn: () => burnsClient.listRunEvents(workspaceId!, runId!),
    enabled: Boolean(workspaceId && runId),
    refetchInterval: refetchIntervalMs,
  })

  useEffect(() => {
    if (!workspaceId || !runId || !enableStream) {
      return
    }

    const targetQueryKey = ["run-events", workspaceId, runId] as const
    let source: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempts = 0
    let cancelled = false

    const clearReconnectTimer = () => {
      if (!reconnectTimer) {
        return
      }

      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) {
        return
      }

      const delayMs = getSseReconnectDelayMs(reconnectAttempts)
      reconnectAttempts += 1

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delayMs)
    }

    const handleSmithersEvent = (event: MessageEvent<string>) => {
      const currentEvents = queryClient.getQueryData<RunEvent[]>(targetQueryKey) ?? []
      const fallbackSeq = (currentEvents[currentEvents.length - 1]?.seq ?? 0) + 1

      try {
        const parsedPayload = JSON.parse(event.data)
        const nextEvent = normalizeEventPayload(parsedPayload, runId, fallbackSeq)
        const nextEventReplayKey = buildEventReplayKey(nextEvent)

        queryClient.setQueryData<RunEvent[]>(targetQueryKey, (previous) => {
          const safePrevious = previous ?? []
          if (safePrevious.some((entry) => entry.seq === nextEvent.seq)) {
            return safePrevious
          }

          if (
            safePrevious.some((entry) => {
              return buildEventReplayKey(entry) === nextEventReplayKey
            })
          ) {
            return safePrevious
          }

          return [...safePrevious, nextEvent]
        })
      } catch {
        // Ignore malformed event payloads.
      }
    }

    const closeSource = () => {
      if (!source) {
        return
      }

      source.removeEventListener("smithers", handleSmithersEvent as EventListener)
      source.close()
      source = null
    }

    const connect = () => {
      if (cancelled) {
        return
      }

      const existingEvents = queryClient.getQueryData<RunEvent[]>(targetQueryKey) ?? []
      const lastSeq = getLastRunEventSeq(existingEvents)
      const streamUrl = burnsClient.getRunEventStreamUrl(workspaceId, runId, lastSeq).toString()

      closeSource()
      source = new EventSource(streamUrl)
      source.addEventListener("smithers", handleSmithersEvent as EventListener)
      source.onopen = () => {
        reconnectAttempts = 0
      }
      source.onerror = () => {
        closeSource()
        scheduleReconnect()
      }
    }

    connect()

    return () => {
      cancelled = true
      clearReconnectTimer()
      closeSource()
    }
  }, [enableStream, queryClient, runId, workspaceId])

  return query
}
