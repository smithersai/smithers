import type { StorageApi } from "@tanstack/db"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"

/**
 * Fixtures shared by the state tests. A test that needs a different double
 * keeps its own local copy; these are the ones every suite used to re-declare.
 */

export const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

export const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

export const nativeRepositories: NativeRepositories = {
  available: true,
  pickLocalRepository: async () => ({ status: "cancelled" })
}

export const silentAgent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

export const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

/** Records every turn request and refuses it, so no frames ever arrive. */
export const recordingAgent = (requests: StartAgentTurnRequest[]): AgentPort => ({
  available: true,
  startTurn: async (request) => {
    requests.push(request)
    return { status: "error", message: "Recorded." }
  },
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

/** Answers turn N with the frames `steps[N]` returns; the last step repeats. */
export const scriptedToolAgent = (
  steps: ReadonlyArray<(request: StartAgentTurnRequest) => ReadonlyArray<Omit<AgentTurnFrame, "runId">>>
): { agent: AgentPort; requests: Array<StartAgentTurnRequest> } => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const requests: Array<StartAgentTurnRequest> = []
  let step = 0
  return {
    requests,
    agent: {
      available: true,
      startTurn: async (request) => {
        requests.push(request)
        const frames = (steps[Math.min(step, steps.length - 1)] ?? (() => []))(request)
        step += 1
        queueMicrotask(() => {
          for (const frame of frames) {
            for (const listener of listeners) listener({ ...frame, runId: request.runId } as AgentTurnFrame)
          }
        })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }
}

/** One macrotask: lets queued microtasks and a zero-delay timer run. */
export const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A fixed number of 1 ms macrotasks. Use it only for negative checks ("no
 * further calls"); wait for a positive condition with `waitFor`.
 */
export const settle = async (ticks = 12): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

/** Polls `condition` every 2 ms until it holds or `timeoutMs` passes. */
export const waitFor = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  if (!condition()) throw new Error("condition never held")
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** A fetch double that answers by pathname and 404s everything else. */
export const backend = (
  routes: Record<string, Response>
): { fetchImpl: (input: unknown) => Promise<Response> } => ({
  fetchImpl: async (input) => {
    const url = typeof input === "string" ? input : String(input)
    const path = new URL(url, "https://app.test").pathname
    return (routes[path] ?? json(404, { status: "error" })).clone()
  }
})
