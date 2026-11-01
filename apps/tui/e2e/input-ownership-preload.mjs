// Observe warnings without replacing stderr or changing listener limits.
import { writeFileSync } from "node:fs"
const warnings = []
let rawSeen = false
// Node warns once per emitter and event, so the count itself is the regression:
// a leak that stops one short of the limit never prints but is already broken.
let peakEnd = 0
const sample = setInterval(() => {
  rawSeen ||= process.stdin.isRaw === true
  peakEnd = Math.max(peakEnd, process.stdin.listenerCount("end"))
}, 20)
sample.unref()
const unrelated = () => {}
process.stdin.on("end", unrelated)
process.on("warning", (warning) => warnings.push({ name: warning.name, message: warning.message }))
process.once("exit", () => {
  writeFileSync(process.env.SMITHERS_TUI_INPUT_RECEIPT, JSON.stringify({
    warnings,
    peakEnd,
    raw: process.stdin.isRaw,
    rawSeen,
    unrelated: process.stdin.listeners("end").includes(unrelated)
  }))
})
