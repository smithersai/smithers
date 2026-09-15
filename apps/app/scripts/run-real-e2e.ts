import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { extractRequestedGrep } from "../e2e/real/coverage/selection"

const appDir = fileURLToPath(new URL("../", import.meta.url))
const args = process.argv.slice(2)

const run = async (command: string, commandArgs: readonly string[]): Promise<number> => {
  const child = Bun.spawn([command, ...commandArgs], { cwd: appDir, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  return child.exited
}

const serve = async (): Promise<never> => {
  if (process.env.SMITHERS_CHAT_STUB !== "0") throw new Error("The real E2E host requires SMITHERS_CHAT_STUB=0.")
  if (process.env.SMITHERS_SKIP_SPA_BUILD !== "1") {
    const devkit = await run(process.execPath, ["scripts/ensure-devkit.mjs"])
    if (devkit !== 0) process.exit(devkit)
    const build = await run("pnpm", ["exec", "vite", "build", "--configLoader", "runner"])
    if (build !== 0) process.exit(build)
  }
  const { startLocalServer } = await import("../src/bun/server")

  const port = Number(process.env.SMITHERS_REAL_PORT ?? "47321")
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid SMITHERS_REAL_PORT: ${process.env.SMITHERS_REAL_PORT}`)
  const root = await mkdtemp(join(tmpdir(), "smithers-real-e2e-host-"))
  const home = join(root, "home")
  await mkdir(home)
  let server: Awaited<ReturnType<typeof startLocalServer>> | undefined
  try {
    server = await startLocalServer({
      port,
      distDir: join(appDir, "dist"),
      home,
      stateDir: join(root, "state"),
      allowManualRepositoryPaths: true,
      chatStub: false,
      cloudMode: "hybrid"
    })
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= server!.stop().then(() => rm(root, { recursive: true, force: true }))
  process.on("SIGINT", () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
  process.on("SIGTERM", () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
  console.log(`[real-e2e] isolated real host listening at http://127.0.0.1:${port}`)
  return await new Promise<never>(() => {})
}

if (args[0] === "serve") {
  await serve()
} else {
  const selection = extractRequestedGrep(args)
  if (selection.grep !== undefined) process.env.SMITHERS_REAL_TEST_GREP = selection.grep
  if (process.env.SMITHERS_CHAT_STUB === "1") throw new Error("The real E2E runner refuses SMITHERS_CHAT_STUB=1.")
  if (!process.env.SMITHERS_REAL_E2E_REVISION) {
    for (const invocation of [["jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"], ["git", "rev-parse", "HEAD"]]) {
      const revision = Bun.spawn(invocation, { cwd: appDir, stdout: "pipe", stderr: "pipe" })
      const value = (await new Response(revision.stdout).text()).trim()
      if (await revision.exited === 0 && /^[0-9a-f]{40,64}$/.test(value)) { process.env.SMITHERS_REAL_E2E_REVISION = value; break }
    }
  }
  if (!process.env.SMITHERS_REAL_E2E_REVISION) throw new Error("Cannot identify the exact tested revision.")
  const external = process.env.SMITHERS_REAL_BASE_URL
  process.env.SMITHERS_REAL_E2E_HOST ??= external ? "production" : "local"
  if (external && process.env.SMITHERS_REAL_E2E_HOST === "production") {
    const response = await fetch(new URL("/api/bootstrap", external))
    if (!response.ok) throw new Error(`Production bootstrap failed: HTTP ${response.status}`)
    const body = await response.json() as { host?: string; buildSha?: string }
    if (body.host !== "cloud" || !body.buildSha || !/^[0-9a-f]{40,64}$/.test(body.buildSha)) throw new Error("Production preflight requires a cloud host with an exact deployed revision.")
    process.env.SMITHERS_REAL_E2E_BUILD_SHA = body.buildSha
  }
  const evidence = process.env.SMITHERS_REAL_E2E_RESULTS ?? join(appDir, "test-results/real-e2e-evidence.json")
  process.env.SMITHERS_REAL_E2E_RESULTS = evidence
  await rm(evidence, { force: true })
  const code = await run("pnpm", ["exec", "playwright", "test", "--config", "playwright.real.config.ts", ...selection.args])
  if (args.includes("--list")) process.exit(code)
  const gate = await run(process.execPath, ["scripts/check-real-e2e.ts", "--results", evidence, "--expected-host", process.env.SMITHERS_REAL_E2E_HOST!, "--expected-revision", process.env.SMITHERS_REAL_E2E_REVISION!])
  process.exit(code || gate)
}
