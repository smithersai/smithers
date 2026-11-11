/** Offline Chat with real saved messages and programs, no model or flows. */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.vibe"
import * as Session from "../src/session.ts"

const cwd = process.cwd()
const saved = Session.create(cwd)
for (let index = 0; index < 20; index++) {
  const answer = `Answer ${index}\n${Array.from({ length: 5 }, (_, line) => `Detail ${index}:${line}`).join("\n")}`
  saved.append({ type: "user", at: 100, text: `Question ${index}` })
  saved.append({
    type: "event",
    at: 101,
    event: new AgentEvent.CellProduced({
      eventType: "flows.harness.cell-produced.v1",
      cell: Cell.source(Array.from({ length: 15 }, (_, line) => `const cell${index}line${line} = ${line}`).join("\n"))
    })
  })
  saved.append({
    type: "event",
    at: 102,
    event: new AgentEvent.Resolved({
      eventType: "flows.harness.resolved.v1",
      message: ModelRequest.Message.assistant(answer)
    })
  })
  saved.append({ type: "outcome", at: 103, prompt: `Question ${index}`, outcome: { _tag: "done", answer } })
}
const host: Host.Host = {
  cwd,
  judged: false,
  dispose: async () => {},
  run: (input) => {
    input.onEvent(
      new AgentEvent.Resolved({
        eventType: "flows.harness.resolved.v1",
        message: ModelRequest.Message.assistant("Input received")
      })
    )
    return { done: Promise.resolve({ _tag: "done", answer: "Input received" }), cancel: () => {} }
  }
}
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(
  <App host={host} seat="test:chat" models={[]} contextWindow={() => 128_000} resume={saved.file} />
)
