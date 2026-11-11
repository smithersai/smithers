// Stays .ts: Playwright loads global setup modules by JS/TS extension only.
import { spawn } from "node:child_process"

/** Each browser project owns durable storage so roles and idempotency receipts cannot leak between projects. */
export default async function setup() {
  const host = spawn(process.execPath, ["--import=vibelang/register", "e2e/authbroker-host.vibe"], {
    cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  const stop = async () => {
    if (host.exitCode !== null) return
    const signal = (name: NodeJS.Signals) => {
      try { process.kill(-host.pid!, name) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    }
    signal("SIGTERM")
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { signal("SIGKILL"); resolve() }, 5000)
      host.once("exit", () => { clearTimeout(timer); resolve() })
    })
  }
  try {
    process.env.AUTH_BROKER_TEST_ORIGINS = await new Promise<string>((resolve, reject) => {
      // Compiling the host takes minutes on a loaded host, like the web server build: E2E_SERVER_SECONDS sets both.
      const timer = setTimeout(() => reject(new Error(output)), Number(process.env.E2E_SERVER_SECONDS ?? 600) * 1000)
      host.stdout!.on("data", chunk => {
        output += String(chunk)
        const ready = output.match(/AUTH_BROKER_READY (\{[^\n]+\})/)
        if (ready) { clearTimeout(timer); resolve(ready[1]!) }
      })
      host.stderr!.on("data", chunk => { output += String(chunk) })
      host.once("exit", code => { clearTimeout(timer); reject(new Error(`Auth host exited ${code}: ${output}`)) })
      host.once("error", error => { clearTimeout(timer); reject(error) })
    })
  } catch (error) { await stop(); throw error }
  return stop
}
