import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { CloudAgent } from "../../src/bun/CloudAgent"

/** No model on this host. Slash commands execute through the real client registry. */
export const createLocalCommandChat = (publish: (frame: AgentTurnFrame) => void): CloudAgent => {
  const active = new Set<string>()
  return {
    start: request => {
      if (active.has(request.runId)) return { status: "error", message: "That turn is already running." }
      active.add(request.runId)
      queueMicrotask(() => {
        if (!active.delete(request.runId)) return
        const last = request.messages.at(-1)
        const text = last && "role" in last && last.role === "user" ? last.content : ""
        const command = /^\/(flow\.[a-z.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
        if (command && request.tools?.some(tool => tool.name === "commands")) {
          publish({ runId: request.runId, type: "tool_call", call_id: crypto.randomUUID(), name: "commands",
            arguments: JSON.stringify({ action: "execute", name: command[1], ...(command[2] === undefined ? {} : { args: command[2] }) }) })
          publish({ runId: request.runId, type: "done", reason: "tool_call" })
        } else {
          const result = last && "type" in last && last.type === "function_call_output" ? last.output : "Local chat accepts /flow.* commands."
          publish({ runId: request.runId, type: "delta", kind: "text", text: result })
          publish({ runId: request.runId, type: "done", reason: "stop" })
        }
      })
      return { status: "started" }
    },
    cancel: runId => ({ status: active.delete(runId) ? "cancelled" : "not-found" })
  }
}
