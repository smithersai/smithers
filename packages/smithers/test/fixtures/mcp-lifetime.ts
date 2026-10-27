import { makeCli } from "../../src/Cli.ts"

// Run the public embedded CLI against this process's real standard streams.
const mode = process.argv[2]
const controller = new AbortController()
const errors = process.stdin.listenerCount("error")
if (mode === "pre-aborted") controller.abort()
await makeCli(mode === "no-signal" ? {} : { signal: controller.signal }).serve(["--mcp"])
const receipt = () =>
  process.send?.({
    type: "closed",
    errorListeners: process.stdin.listenerCount("error") - errors,
    dataListeners: process.stdin.listenerCount("data")
  })
if (mode === "pre-aborted") setImmediate(receipt)
else process.stdin.once("end", () => setImmediate(receipt))
process.on("message", (message) => {
  if (message === "abort") {
    controller.abort()
    setImmediate(receipt)
  }
  if (message === "disconnect") process.disconnect!()
})
process.send?.({ type: "ready" })
