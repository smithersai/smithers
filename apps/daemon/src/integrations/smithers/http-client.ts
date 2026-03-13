import { buildSmithersAuthHeaders } from "@/services/smithers-runtime-config-service"
import { HttpError } from "@/utils/http-error"

function buildSmithersUrl(baseUrl: string, pathname: string, searchParams?: URLSearchParams) {
  const url = new URL(pathname, baseUrl)

  if (searchParams) {
    url.search = searchParams.toString()
  }

  return url
}

async function parseErrorMessage(response: Response) {
  try {
    const data = (await response.json()) as unknown
    const message = extractErrorMessage(data)
    return message ?? `Smithers request failed: ${response.status}`
  } catch {
    return `Smithers request failed: ${response.status}`
  }
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const objectPayload = payload as Record<string, unknown>
  const directError = objectPayload.error
  if (typeof directError === "string" && directError.trim()) {
    return directError
  }

  if (directError && typeof directError === "object") {
    const nestedMessage = (directError as Record<string, unknown>).message
    if (typeof nestedMessage === "string" && nestedMessage.trim()) {
      return nestedMessage
    }
  }

  const directMessage = objectPayload.message
  if (typeof directMessage === "string" && directMessage.trim()) {
    return directMessage
  }

  return null
}

async function requestJson<T>(baseUrl: string, pathname: string, init?: RequestInit): Promise<T> {
  const authHeaders = buildSmithersAuthHeaders()

  const response = await fetch(buildSmithersUrl(baseUrl, pathname), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders,
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    throw new HttpError(response.status, await parseErrorMessage(response))
  }

  return (await response.json()) as T
}

export async function listSmithersRuns(baseUrl: string) {
  return await requestJson<unknown>(baseUrl, "/v1/runs")
}

export async function getSmithersRun(baseUrl: string, runId: string) {
  return await requestJson<unknown>(baseUrl, `/v1/runs/${runId}`)
}

export async function createSmithersRun(baseUrl: string, payload: unknown) {
  return await requestJson<unknown>(baseUrl, "/v1/runs", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function resumeSmithersRun(baseUrl: string, runId: string, payload: unknown) {
  return await requestJson<unknown>(baseUrl, `/v1/runs/${runId}/resume`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function cancelSmithersRun(baseUrl: string, runId: string, payload: unknown) {
  return await requestJson<unknown>(baseUrl, `/v1/runs/${runId}/cancel`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function approveSmithersNode(
  baseUrl: string,
  runId: string,
  nodeId: string,
  payload: unknown
) {
  return await requestJson<unknown>(baseUrl, `/v1/runs/${runId}/nodes/${nodeId}/approve`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function denySmithersNode(
  baseUrl: string,
  runId: string,
  nodeId: string,
  payload: unknown
) {
  return await requestJson<unknown>(baseUrl, `/v1/runs/${runId}/nodes/${nodeId}/deny`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function streamSmithersRunEvents(
  baseUrl: string,
  runId: string,
  afterSeq?: number,
  signal?: AbortSignal
) {
  const searchParams = new URLSearchParams()
  const authHeaders = buildSmithersAuthHeaders()
  if (afterSeq !== undefined) {
    searchParams.set("afterSeq", String(afterSeq))
  }

  const response = await fetch(
    buildSmithersUrl(baseUrl, `/v1/runs/${runId}/events`, searchParams),
    {
      headers: {
        accept: "text/event-stream",
        ...authHeaders,
      },
      signal,
    }
  )

  if (!response.ok || !response.body) {
    throw new HttpError(response.status || 502, await parseErrorMessage(response))
  }

  return response
}
