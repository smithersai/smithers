import { createServer } from "node:net"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ExecutionReceipt, ModeConfig } from "../../e2e/real/coverage/matrix"

export interface PlueSession {
  readonly modeConfig: ModeConfig
  readonly close: () => Promise<void>
}

const port = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (typeof address !== "object" || address === null) return reject(new Error("no loopback port"))
    server.close((error) => error ? reject(error) : resolvePort(address.port))
  })
})

const ready = async (origin: string): Promise<void> => {
  for (const path of ["/", "/api/health", "/api/bootstrap"]) {
    const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`${origin}${path} returned ${response.status}`)
  }
}

export const startPlueTargets = async (appDir: string, revision: string, outputDir: string, target: string, tokenEnvironment: string): Promise<readonly PlueSession[]> => {
  const origin = new URL(target)
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("SMITHERS_MODE_MATRIX_PLUE_URL must be a credential-free HTTP(S) origin")
  }
  await ready(origin.origin)
  const receipt = (mode: "web-plue" | "local-plue", modeOrigin: string): ModeConfig => {
    const path = join(outputDir, `${mode}.execution.json`)
    const value: ExecutionReceipt = {
      mode, revision, origin: modeOrigin, ready: true,
      startedRoles: [mode === "web-plue" ? "web" : "local-ui"], freshLaunch: false,
      restarted: false, dataPreserved: false, observedAt: new Date().toISOString()
    }
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    return { mode, origin: modeOrigin, auth: { kind: "application-token", environment: tokenEnvironment }, executionReceipt: path }
  }
  const web: PlueSession = { modeConfig: receipt("web-plue", origin.origin), close: async () => undefined }
  const webPort = await port()
  const localOrigin = `http://127.0.0.1:${webPort}`
  const vite = Bun.spawn(["pnpm", "exec", "vite", "--configLoader", "runner", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    cwd: resolve(appDir), env: { ...process.env, SMITHERS_DEV_BACKEND_ORIGIN: origin.origin },
    stdin: "ignore", stdout: "inherit", stderr: "inherit"
  })
  try {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (vite.exitCode !== null) throw new Error(`local Plue Vite process exited ${vite.exitCode}`)
      try { await ready(localOrigin); break } catch { await Bun.sleep(250) }
    }
    if (Date.now() >= deadline) throw new Error("local Plue Vite process did not become ready")
    return [web, {
      modeConfig: receipt("local-plue", localOrigin),
      close: async () => { if (vite.exitCode === null) vite.kill("SIGTERM"); await vite.exited }
    }]
  } catch (error) {
    if (vite.exitCode === null) vite.kill("SIGTERM")
    await vite.exited
    throw error
  }
}
