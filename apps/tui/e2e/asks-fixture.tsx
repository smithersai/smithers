/** Offline App with a controllable clock and receipts for actual chat/answer calls. */
import "../src/native.ts"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { appendFileSync } from "node:fs"
import { createServer } from "node:net"
import { setImmediate } from "node:timers/promises"
import { App } from "../src/app.tsx"
import { Asks } from "../src/asks.ts"
import type * as Host from "../src/host.ts"

let now = 10_000
Date.now = () => now
const events: Array<Record<string, unknown>> = []
const record = (event: Record<string, unknown>) => {
  events.push(event)
  appendFileSync(process.env.TUI_ASK_EVENTS!, JSON.stringify(event) + "\n")
}
let asks: Asks | undefined
const ask = Asks.prototype.ask
Asks.prototype.ask = function(...args) {
  asks = this
  return ask.apply(this, args)
}
const answer = Asks.prototype.answer
Asks.prototype.answer = function(...args) {
  record({ kind: "answer", id: args[0], answer: args[1], at: now })
  return answer.apply(this, args)
}
let started = false
const host: Host.Host = {
  cwd: process.cwd(),
  judged: false,
  dispose: async () => {},
  run: (input) => {
    if (input.source === undefined) {
      record({ kind: "message", text: input.prompt, at: now })
      if (!started) {
        started = true
        for (let index = 0; index < Number(process.env.TUI_ASK_COUNT ?? 1); index++) {
          input.runtime!.delegate!({ id: `worker-${index}`, title: `Rename ${index}`, prompt: "Rename" })
        }
      }
      return { done: Promise.resolve({ _tag: "done", answer: "Requested." }), cancel: () => {} }
    }
    const options = process.env.TUI_ASK_FREE === "1" ? {} : { options: ["sum", "plus"] }
    void input.runtime!.ask!({ question: "New name?", ...options }).then((result) => {
      record({ kind: "settled", answer: result.answer })
    })
    const done = Promise.withResolvers<Host.Outcome>()
    return { done: done.promise, cancel: () => done.resolve({ _tag: "cancelled" }) }
  }
}
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(
  <App host={host} seat="replay:chat" workerSeat="replay:worker" models={[]} contextWindow={() => 10_000} />
)
renderer.keyInput.on("keypress", (key) => {
  record({ kind: "key", name: key.name, at: now })
})
// Clock changes are acknowledged before sending PTY input; snapshots wait through dispatch.
createServer((socket) => {
  let input = ""
  socket.on("data", async (data) => {
    input += data.toString()
    if (!input.includes("\n")) return
    const request = JSON.parse(input)
    if (request.now !== undefined) now = request.now
    await setImmediate()
    socket.end(JSON.stringify({ now, events, pending: asks?.list() ?? [] }) + "\n")
  })
}).listen(process.env.TUI_ASK_CONTROL!)
