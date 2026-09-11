import { CANCEL_PATH, TURN_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { decodeAgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnFrame, FetchLike, StartAgentTurnResult, TurnRefusal } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../runtime/AgentPort"

const MAX_ERROR_BYTES = 320

export interface WebAgentOptions {
  /** Same origin by default; override for tests or a deployed boundary. */
  readonly baseUrl?: string
  readonly fetchImpl?: FetchLike
  /** The turn route; defaults to the shared TURN_PATH. */
  readonly turnPath?: string
  /** The cancel route; defaults to the shared CANCEL_PATH. */
  readonly cancelPath?: string
}

/**
 * What a status MEANS, in the product's own words.
 *
 * Rendering `HTTP <status>: <body>` for every status made the app's honesty
 * depend on every upstream writing user-facing prose. Our own limiter does
 * (§24.3 confirms that path reads correctly); a model provider answers
 * `{"type":"error","error":{"type":"rate_limit_error",…}}` and a Worker crash
 * answers a Cloudflare HTML page, and both were pasted into the chat raw.
 * The status is classified here so the sentence is right whatever the upstream
 * sent, and the upstream's own prose is kept only when it reads as prose.
 */
const statusSentence = (status: number): string | undefined => {
  if (status === 429) return "The model provider is rate-limiting this account. Try again in a minute."
  if (status === 401 || status === 403) return "That turn wasn't authorized — sign in again and retry."
  if (status === 402) return "That turn wasn't run because the account has no balance left."
  if (status === 408 || status === 504) return "That turn timed out before the model answered."
  if (status === 502 || status === 503) return "Smithers Cloud is unreachable right now. Try again in a moment."
  if (status >= 500) return "Smithers Cloud hit an error on that turn."
  return undefined
}

/** Body text that was written for a person, not transport plumbing. */
const readableDetail = (body: string): string | undefined => {
  if (body === "") return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string" &&
      parsed.message !== ""
    ) {
      return parsed.message.slice(0, MAX_ERROR_BYTES)
    }
    // Any other JSON shape — a provider's nested error object included — is a
    // wire payload. Pasting it into the chat is how the raw 429 body shipped.
    return undefined
  } catch {
    // Not JSON. An HTML error page is plumbing; a plain sentence is not.
    if (/^\s*<|<\/[a-z]+>/i.test(body)) return undefined
    return body.slice(0, MAX_ERROR_BYTES)
  }
}

/** The boundary answers failures as `{ status, message }`; surface that, not raw JSON. */
const errorDetail = (status: number, body: string): string => {
  const detail = readableDetail(body)
  const classified = statusSentence(status)
  if (detail !== undefined) {
    // The upstream wrote for a person: that sentence leads, and the status
    // stays available for a bug report.
    return `Smithers web agent failed (HTTP ${status}): ${detail}`
  }
  if (classified !== undefined) return `${classified} (HTTP ${status})`
  return `Smithers web agent failed (HTTP ${status}).`
}

/*
 * The Worker's own turn ceiling (apps/server turnLimit.ts) answers 429 with
 * `{ code: "turn_rate_limited", message, retryAt }`. That is the one refusal
 * the app renders as its own card rather than a failure line, so it is
 * recognised by its code, never by its sentence: a provider's 429 carries no
 * such code and stays a classified failure.
 */
const turnRefusal = (status: number, body: string): TurnRefusal | undefined => {
  if (status !== 429) return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (
      typeof parsed !== "object" || parsed === null || !("code" in parsed) || parsed.code !== "turn_rate_limited" ||
      !("message" in parsed) || typeof parsed.message !== "string" || parsed.message === ""
    ) {
      return undefined
    }
    const retryAt = "retryAt" in parsed && typeof parsed.retryAt === "string" && !Number.isNaN(Date.parse(parsed.retryAt))
      ? parsed.retryAt
      : null
    return { code: "turn_rate_limited", message: parsed.message, retryAt }
  } catch {
    return undefined
  }
}

const streamFrames = async (
  body: ReadableStream<Uint8Array>,
  expectedRunId: string,
  publish: (frame: AgentTurnFrame) => void,
  onTerminal?: () => void
): Promise<void> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let settled = false
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split("\n")
    buffer = done ? "" : (lines.pop() ?? "")
    for (const line of lines) {
      if (line.trim() === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      // Publish the decoded frame, never the raw JSON: the card schemas
      // default nested fields (`RunRecord.labels`) that subscribers read
      // through the frame type.
      const frame = decodeAgentTurnFrame(parsed)
      if (frame === null || frame.runId !== expectedRunId) continue
      if (frame.type === "done") {
        settled = true
        // Release the turn's cancel handle BEFORE the terminal frame is
        // published: a tool-loop continuation leg re-POSTs this runId from
        // its own `done` listener, and must not meet a stale "already
        // running" from this agent's map. Publishing first refused that leg
        // outright.
        onTerminal?.()
      }
      publish(frame)
    }
    if (done || settled) break
  }
  // A `done` frame ends the turn even if the boundary keeps the socket open.
  if (settled) {
    await reader.cancel().catch(() => {})
  } else {
    // The stream ended without a terminal frame: the turn died server-side
    // (upstream disconnect). That is an honest failure, never a silent stall,
    // and it releases the handle first for the same reason a `done` frame does.
    onTerminal?.()
    publish({
      runId: expectedRunId,
      type: "done",
      error: "The response stream ended before Smithers finished the turn."
    })
  }
}

/**
 * The HTTP agent: POSTs turns to a same-origin boundary that keeps the
 * chat.smithers.sh URL and origin server-side, then renders the streamed
 * NDJSON AgentTurnFrames.
 */
/*
 * Every host composes this on the default /api/agent seam (Runtime.ts passes
 * a fetch and nothing else): the product Worker serves TURN_PATH and
 * CANCEL_PATH, and so does the local app's own boundary (LOCAL-APP.md), which
 * additionally aliases the older /api/chat pair. `turnPath` and `cancelPath`
 * exist for a test or a boundary that moves the routes; nothing in the app
 * passes them.
 */
export const createWebAgent = (options: WebAgentOptions = {}): AgentPort => {
  const baseUrl = options.baseUrl ?? ""
  const turnPath = options.turnPath ?? TURN_PATH
  const cancelPath = options.cancelPath ?? CANCEL_PATH
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const activeTurns = new Map<string, AbortController>()
  const publish = (frame: AgentTurnFrame): void => {
    for (const listener of listeners) listener(frame)
  }

  return {
    available: true,
    startTurn: async (request): Promise<StartAgentTurnResult> => {
      if (activeTurns.has(request.runId)) {
        return { status: "error", message: "That Smithers turn is already running." }
      }
      const abortController = new AbortController()
      // Registered before the request so a stop pressed while still connecting aborts it.
      activeTurns.set(request.runId, abortController)
      /*
       * The map is keyed by runId, but the entry belongs to THIS leg. A
       * continuation that re-POSTs the same runId owns the key from that
       * moment, so this leg's teardown (which settles later, once the reader
       * is cancelled) must never delete the replacement's cancel handle:
       * doing so left a live stream Stop could not abort locally, and one
       * that no longer refused a duplicate.
       */
      const release = (): void => {
        if (activeTurns.get(request.runId) === abortController) activeTurns.delete(request.runId)
      }
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}${turnPath}`, {
          method: "POST",
          signal: abortController.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request)
        })
      } catch (error) {
        release()
        // A cancelled connect is the user's own doing, not a failed turn to report.
        if (abortController.signal.aborted) return { status: "started" }
        return {
          status: "error",
          message: error instanceof Error
            ? `Could not reach the Smithers web agent: ${error.message}`
            : "Could not reach the Smithers web agent."
        }
      }
      if (!response.ok || response.body === null) {
        release()
        if (response.ok) return { status: "error", message: "The Smithers web agent returned no response stream." }
        const body = (await response.text().catch(() => "")).trim()
        const refusal = turnRefusal(response.status, body)
        return {
          status: "error",
          message: errorDetail(response.status, body),
          ...(refusal === undefined ? {} : { refusal })
        }
      }
      void streamFrames(response.body, request.runId, publish, release)
        .catch((error: unknown) => {
          if (abortController.signal.aborted) return
          publish({
            runId: request.runId,
            type: "done",
            error: error instanceof Error
              ? error.message
              : "The Smithers web agent stream failed."
          })
        })
        .finally(release)
      return { status: "started" }
    },
    cancelTurn: async (runId) => {
      const active = activeTurns.get(runId)
      if (active !== undefined) {
        active.abort()
        activeTurns.delete(runId)
      }
      await fetchImpl(`${baseUrl}${cancelPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId })
      }).catch(() => {})
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
