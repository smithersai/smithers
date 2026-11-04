#!/usr/bin/env node
// Local CLI test boundary. Run on the admitted compute host, never against a deployment. Own a fresh real database,
// an Alchemy dev stage, its server process group and the proof. No model or hosting credential is needed.
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { get } from "node:https"
import { createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"

if (process.argv[2] !== "--stack") {
  const child = spawnSync("bash", ["db/test-stack.sh", "node", "scripts/prove-secrets.mjs", "--stack"], { stdio: "inherit" })
  process.exit(child.status ?? 1)
}
if (!process.env.MVP_TEST_STACK_PROJECT) throw new Error("A run-owned database fixture is required")
const stage = `dev_secrets_${randomUUID().replaceAll("-", "").slice(0, 12)}`
const reservation = createServer()
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve))
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const origin = `https://localhost:${port}`
const env = { ...process.env, SANDBOX_SECRETS: "true", GITHUB_REPOSITORY: "octocat/Spoon-Knife",
  DEV_HTTPS_PORT: String(port), BASE_URL: origin, E2E_TARGET: "local",
  CHAT_MODEL: JSON.stringify({ protocol: "openai-chat", baseUrl: "http://127.0.0.1:9", modelId: "no-model", credential: "PROOF_NO_MODEL" }),
  SMITHERS_MODEL_KEY_PROOF_NO_MODEL: "none", SMITHERS_MODEL_KEY_PROOF_NO_MODEL_ORIGIN: "http://127.0.0.1:9" }
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, stdio: "inherit" })
  child.once("error", reject)
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (exit ${code})`)))
})
await run("pnpm", ["-s", "db:migrate"])
await run("node", ["infra/sandbox/pack-cli.mjs", "--if-missing"])
await mkdir(".alchemy/log", { recursive: true })
const logPath = `.alchemy/log/${stage}.log`
const log = createWriteStream(logPath, { flags: "wx", mode: 0o600 })
const server = spawn("pnpm", ["dev", "--stage", stage], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
server.stdout.pipe(log)
server.stderr.pipe(log)
const serverDone = new Promise((resolve) => server.once("close", resolve))
let stopping
const stop = () => stopping ??= (async () => {
  if (server.exitCode === null && server.signalCode === null) {
    process.kill(-server.pid, "SIGTERM")
    const timer = setTimeout(() => { try { process.kill(-server.pid, "SIGKILL") } catch {} }, 5_000)
    await serverDone.finally(() => clearTimeout(timer))
  }
  log.end()
})()
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => { void stop().finally(() => process.exit(130)) })
// Only the generated local dev certificate is exempt from public TLS validation, as in playwright.config.ts.
const ready = () => new Promise((resolve) => {
  const request = get(`${origin}/api/auth/session`, { rejectUnauthorized: false, timeout: 2_000 }, (response) => {
    response.resume()
    resolve(response.statusCode === 200)
  })
  request.on("error", () => resolve(false))
  request.on("timeout", () => request.destroy())
})
try {
  const deadline = Date.now() + 240_000
  while (!await ready()) {
    if (server.exitCode !== null || Date.now() >= deadline) throw new Error(`The owned dev server did not become ready; inspect ${logPath} privately`)
    await delay(1_000)
  }
  console.log(`secret proof: dev stage ${stage} ready`)
  await run("pnpm", ["exec", "playwright", "test", "e2e/secrets-egress.spec.ts", "e2e/secrets.spec.ts", "--project=local", "--workers=1"])
} finally { await stop() }
