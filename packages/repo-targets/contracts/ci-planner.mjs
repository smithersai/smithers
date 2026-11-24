/** Serial CLI host with a deadline enforced outside the planner's event loop. */
import { fork } from "node:child_process"
import { once } from "node:events"
import { isMain } from "../scripts/workspace-root.mjs"

const credentialKeys = new Set([
  "SMITHERS_CACHE_URL",
  "SMITHERS_CACHE_TOKEN",
  "SMITHERS_CACHE_READ_TOKEN",
  "SMITHERS_CACHE_WRITE_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN"
])
const isCredential = (key) => credentialKeys.has(key.toUpperCase())

export const plannerHasCredentials = () => Object.keys(process.env).some(isCredential)

/** Only pass credential-free environments to planning and declaration loading. */
export const plannerEnvironment = (environment = process.env) =>
  Object.fromEntries(Object.entries(environment).filter(([key]) => !isCredential(key)))

/** Keep cancellation cooperative, then preempt even synchronous or signal-ignoring work. */
export const requestPlan = (child, request, {
  timeoutMs = 120_000,
  graceMs = 1_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) =>
  new Promise((resolve, reject) => {
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
    child.send(request, (error) => {
      if (error) finish(error)
    })
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
  const request = async (verb, pattern, workspace, timeoutMs) => {
    // The child inherits none of the parent's flags (including --test).
    // The VibeLang loader is explicit because it imports workspace sources.
    child ??= fork(new URL(import.meta.url), ["--worker"], {
      execArgv: [`--import=${import.meta.resolve("vibelang/register")}`],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: plannerEnvironment()
    })
    try {
      return await requestPlan(child, { verb, pattern, workspace }, { timeoutMs })
    } catch (error) {
      await close()
      throw error
    }
  }
  return {
    plan: request,
    inventory: (workspace) => request("inventory", workspace, workspace, 10 * 60_000),
    close
  }
}

if (isMain(import.meta) && process.argv[2] === "--worker") {
  // Finish evaluating this helper before awaiting its importing module.
  // Awaiting the cycle at module scope leaves the child with unsettled TLA.
  for (const key of Object.keys(process.env).filter(isCredential)) delete process.env[key]
  const entry = import("./ci-inventory.mjs")
  process.on("message", async ({ verb, pattern, workspace }) => {
    try {
      const { plannedInProcess, resolveInventory } = await entry
      const value = verb === "inventory" ? await resolveInventory() : await plannedInProcess(verb, pattern, workspace)
      process.send({ type: "plan", value })
    } catch (error) {
      process.send({ type: "plan", error: String(error) })
    }
  })
  process.once("disconnect", () => process.exit(0))
}
