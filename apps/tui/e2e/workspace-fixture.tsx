/** Deterministic host for PTY coverage of chat while a worker remains unresolved. */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"
const host: Host.Host = {
  cwd: process.cwd(),
  judged: false,
  dispose: async () => {},
  run: (input) => {
    if (input.role === "worker") {
      return {
        done: new Promise((resolve) => {
          cancelled = () => resolve({ _tag: "cancelled" })
        }),
        cancel: () => cancelled()
      }
    }
    let answer = "Still here."
    if (input.prompt === "investigate") {
      const request = { id: "investigation", title: "Investigation", prompt: "Investigate the failing check." }
      const first = input.runtime!.delegate!(request)
      input.runtime!.delegate!(request)
      answer = `Requested the investigation.`
      if ((first as { status: string }).status !== "requested") throw new Error("Expected request receipt")
    }
    queueMicrotask(() =>
      input.onEvent(
        {
          _tag: "resolved",
          eventType: "flows.harness.resolved.v1",
          message: { role: "assistant", content: [{ type: "text", text: answer }] }
        } as any
      )
    )
    return { done: Promise.resolve({ _tag: "done", answer }), cancel: () => {} }
  }
}
let cancelled = () => {}
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(
  <App host={host} seat="test:chat" workerSeat="test:worker" models={[]} contextWindow={() => 128_000} />
)
