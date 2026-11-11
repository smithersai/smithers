/** Offline PTY proof: commands and successive native frames use a private test directory. */
import "../src/native.ts"
import { createCliRenderer, getTreeSitterClient, MarkdownRenderable, type Renderable } from "@opentui/core"
import { createRoot } from "@opentui/react"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { appendFileSync, existsSync, watch } from "node:fs"
import { join } from "node:path"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.vibe"

const root = process.env.SMITHERS_TUI_ANSWER_FRAMES_DIR
if (!root) throw new Error("SMITHERS_TUI_ANSWER_FRAMES_DIR is required")
const gate = Promise.withResolvers<void>()
const client = getTreeSitterClient()
const highlight = client.highlightOnce.bind(client)
let released = false
let input: Host.TurnInput | undefined
let delivered = false
let highlighted = false
client.highlightOnce = async (content, filetype) => {
  await gate.promise
  const result = await highlight(content, filetype)
  highlighted = true
  return result
}
const command = () => {
  if (existsSync(join(root, "answer")) && input && !delivered) {
    delivered = true
    input.onEvent(
      new AgentEvent.Resolved({
        eventType: "flows.harness.resolved.v1",
        message: ModelRequest.Message.assistant("PTY available answer with **bold** and `code`.")
      })
    )
  }
  if (existsSync(join(root, "release"))) {
    released = true
    gate.resolve()
  }
}
const watcher = watch(root, command)
const host: Host.Host = {
  cwd: root,
  judged: false,
  dispose: async () => {
    watcher.close()
  },
  run: (turn) => {
    input = turn
    command()
    const done = Promise.withResolvers<Host.Outcome>()
    return { done: done.promise, cancel: () => done.resolve({ _tag: "cancelled" }) }
  }
}
const available = (node: Renderable): boolean =>
  (node instanceof MarkdownRenderable && node.content.includes("PTY available answer")) ||
  node.getChildren().some(available)
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
renderer.addPostProcessFn((buffer) => {
  appendFileSync(
    join(root, "frames.jsonl"),
    JSON.stringify({
      available: available(renderer.root),
      released,
      highlighted,
      chars: Buffer.from(buffer.getRealCharBytes(true)).toString("utf8")
    }) + "\n"
  )
})
createRoot(renderer).render(<App host={host} seat="replay:offline" models={[]} contextWindow={() => 10000} />)
