import { spawn } from "node:child_process"
import { resolve } from "node:path"

type HarnessEvent = {
  readonly event: string
  readonly origin?: string
}

export interface FaultHarness {
  readonly origin: string
  readonly fault: () => Promise<void>
  readonly restore: () => Promise<void>
  readonly evidence: () => string
  readonly close: () => Promise<void>
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))

export const launchFaultHarness = async (): Promise<FaultHarness> => {
  const appDir = resolve(__dirname, "../../..")
  const child = spawn("bun", [resolve(__dirname, "fault-host.ts")], {
    cwd: appDir,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  })
  const events: HarnessEvent[] = []
  let stdout = ""
  let stderr = ""
  let spawnError: Error | undefined
  child.once("error", (error) => { spawnError = error })
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => { stderr += chunk })
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk
    for (;;) {
      const newline = stdout.indexOf("\n")
      if (newline < 0) break
      const line = stdout.slice(0, newline).trim()
      stdout = stdout.slice(newline + 1)
      if (line !== "") events.push(JSON.parse(line) as HarnessEvent)
    }
  })

  const next = async (event: string, timeout = 30_000): Promise<HarnessEvent> => {
    const deadline = Date.now() + timeout
    for (;;) {
      const index = events.findIndex((candidate) => candidate.event === event)
      if (index >= 0) return events.splice(index, 1)[0]!
      if (spawnError !== undefined) throw spawnError
      if (child.exitCode !== null) {
        throw new Error(`Fault harness exited ${child.exitCode} before ${event}.\n${stderr}`)
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for fault harness event ${event}.\n${stderr}`)
      await wait(25)
    }
  }

  let ready: HarnessEvent
  try {
    ready = await next("ready", 60_000)
    if (ready.origin === undefined) throw new Error("Fault harness did not report its product origin.")
  } catch (error) {
    child.kill("SIGTERM")
    const deadline = Date.now() + 10_000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await wait(25)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    throw error
  }
  const send = async (action: "fault" | "restore", answer: string): Promise<void> => {
    if (!child.stdin.write(`${action}\n`)) {
      await new Promise<void>((resolveDrain) => child.stdin.once("drain", resolveDrain))
    }
    await next(answer)
  }
  let closed = false
  return {
    origin: ready.origin!,
    fault: () => send("fault", "faulted"),
    restore: () => send("restore", "restored"),
    evidence: () => stderr,
    close: async () => {
      if (closed) return
      closed = true
      if (child.exitCode === null) {
        if (!child.stdin.write("quit\n")) {
          await new Promise<void>((resolveDrain) => child.stdin.once("drain", resolveDrain))
        }
        await next("stopped")
      }
      const deadline = Date.now() + 10_000
      while (child.exitCode === null && Date.now() < deadline) await wait(25)
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        throw new Error(`Fault harness did not exit after cleanup.\n${stderr}`)
      }
      if (child.exitCode !== 0) throw new Error(`Fault harness exited ${child.exitCode}.\n${stderr}`)
    }
  }
}
