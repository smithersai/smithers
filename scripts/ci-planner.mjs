/** Serial CLI host with a deadline enforced outside the planner's event loop. */
import { fork } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"

/** Keep cancellation cooperative, then preempt even synchronous or signal-ignoring work. */
export const requestPlan = (child, request, {
  timeoutMs = 120_000, graceMs = 1_000, setTimer = setTimeout, clearTimer = clearTimeout
} = {}) => new Promise((resolve, reject) => {
  let timedOut = false
  let hardKill
  const deadline = setTimer(() => {
    timedOut = true
    child.kill("SIGTERM")
    hardKill = setTimer(() => child.kill("SIGKILL"), graceMs)
  }, timeoutMs)
  const finish = (error, value) => {
    clearTimer(deadline)
    clearTimer(hardKill)
    child.removeListener("message", message)
    child.removeListener("error", failed)
    child.removeListener("exit", exited)
    if (timedOut) reject(new Error(`Planning ${request.verb} ${request.pattern} timed out after ${timeoutMs}ms`))
    else if (error) reject(error)
    else resolve(value)
  }
  const message = (reply) => {
    if (reply?.type !== "plan") return
    finish(reply.error === undefined ? undefined : new Error(reply.error), reply.value)
  }
  const failed = (error) => finish(error)
  const exited = (code, signal) => finish(new Error(`Planner exited with ${code ?? signal}`))
  child.on("message", message)
  child.once("error", failed)
  child.once("exit", exited)
  child.send(request, (error) => { if (error) finish(error) })
})

/** One child keeps loaded CLI modules across selections; failed children are never reused. */
export const createPlanner = () => {
  let child
  const close = async () => {
    const previous = child
    child = undefined
    if (previous === undefined || previous.exitCode !== null || previous.signalCode !== null) return
    const exited = once(previous, "exit")
    previous.kill("SIGKILL")
    await exited
  }
  return {
    async plan(verb, pattern, workspace) {
      child ??= fork(new URL(import.meta.url), ["--worker"], {
        execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, SMITHERS_CACHE_URL: "", SMITHERS_CACHE_TOKEN: "" }
      })
      try { return await requestPlan(child, { verb, pattern, workspace }) }
      catch (error) { await close(); throw error }
    },
    close
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--worker") {
  // Finish evaluating this helper before awaiting its importing module.
  // Awaiting the cycle at module scope leaves the child with unsettled TLA.
  const entry = import("./ci-inventory.mjs")
  process.on("message", async ({ verb, pattern, workspace }) => {
    try {
      const { plannedInProcess } = await entry
      process.send({ type: "plan", value: await plannedInProcess(verb, pattern, workspace) })
    } catch (error) { process.send({ type: "plan", error: String(error) }) }
  })
  process.once("disconnect", () => process.exit(0))
}
