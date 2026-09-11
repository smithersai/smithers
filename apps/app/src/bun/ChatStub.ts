import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { CloudAgent } from "./CloudAgent"

/*
 * SMITHERS_CHAT_STUB=1: a deterministic CloudAgent so the Playwright suite and
 * CI run offline. It streams one reasoning delta, then the text
 * `stub: <last user message>`, then done.
 */

const lastUserMessage = (request: StartAgentTurnRequest): string => {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message !== undefined && "role" in message && message.role === "user") return message.content
  }
  return ""
}

export const stubReply = (request: StartAgentTurnRequest): string => {
  return `stub: ${lastUserMessage(request)}`
}

export const createChatStub = (publish: (frame: AgentTurnFrame) => void): CloudAgent => {
  const active = new Set<string>()
  return {
    start: (request) => {
      if (active.has(request.runId)) {
        return { status: "error", message: "That Smithers turn is already running." }
      }
      active.add(request.runId)
      const frames: ReadonlyArray<AgentTurnFrame> = [
        { runId: request.runId, type: "delta", kind: "reasoning", text: "stub: thinking" },
        { runId: request.runId, type: "delta", kind: "text", text: stubReply(request) },
        { runId: request.runId, type: "done", reason: "stop" }
      ]
      let index = 0
      const step = (): void => {
        if (!active.has(request.runId)) return
        const frame = frames[index]
        index += 1
        if (frame === undefined) {
          active.delete(request.runId)
          return
        }
        publish(frame)
        setTimeout(step, 5)
      }
      setTimeout(step, 5)
      return { status: "started" }
    },
    cancel: (runId) => {
      if (!active.has(runId)) return { status: "not-found" }
      active.delete(runId)
      return { status: "cancelled" }
    }
  }
}
