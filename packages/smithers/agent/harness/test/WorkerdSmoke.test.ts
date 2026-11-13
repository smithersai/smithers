/**
 * The real Wrangler smoke and its process lifecycle, enabled with
 * `FLOWS_WORKERD_SMOKE=1`. Install its separate dependencies first; see
 * `docs/guides/workerd.md#run-the-wrangler-smoke` for both commands.
 *
 * The default check also proves the package's test project includes the worker:
 * bundling alone erases types without checking them.
 */
import { execFile } from "node:child_process"
import { once } from "node:events"
import { copyFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const run = promisify(execFile)
const directory = fileURLToPath(new URL("./workerd", import.meta.url))
const packageDirectory = fileURLToPath(new URL("..", import.meta.url))

it("includes the workerd worker in the package typecheck", async () => {
  const compiler = fileURLToPath(new URL("bin/vibelang", import.meta.resolve("vibelang/package.json")))
  const { stdout } = await run(process.execPath, [compiler, "-p", "tsconfig.test.json", "--listFilesOnly"], {
    cwd: packageDirectory,
    timeout: 30_000
  })
  expect(stdout.split(/\r?\n/).map(normalize)).toContain(join(directory, "worker.ts"))
}, 35_000)

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") return reject(new Error("No TCP listener"))
      resolve(address.port)
    })
  })

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => error ? reject(error) : resolve())
  })

describe.skipIf(process.env.FLOWS_WORKERD_SMOKE !== "1")("workerd smoke", () => {
  it("runs a cell inside workerd against the build the host named", async () => {
    const { stdout } = await run(process.execPath, ["smoke.mjs"], {
      cwd: directory,
      timeout: 180_000
    })
    expect(stdout).toContain("workerd smoke passed")
    expect(stdout).toContain("complete")
  }, 185_000)

  it("never accepts a successful response from an occupied requested port", async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests++
      response.end(JSON.stringify({ _tag: "settled", transition: { _tag: "complete", output: "README.md" } }))
    })
    const port = await listen(server)
    try {
      await expect(run(process.execPath, ["smoke.mjs"], {
        cwd: directory,
        env: { ...process.env, FLOWS_WORKERD_PORT: String(port), FLOWS_WORKERD_STARTUP_MS: "20000" },
        timeout: 30_000
      })).rejects.toMatchObject({
        code: 1,
        killed: false,
        signal: null,
        stderr: expect.stringMatching(/EADDRINUSE|already in use/)
      })
      expect(requests).toBe(0)
    } finally {
      await close(server)
    }
  }, 35_000)

  for (const signal of [undefined, "SIGTERM", "SIGINT", "SIGHUP"] as const) {
    it.skipIf(signal !== undefined && process.platform === "win32")(
      signal === undefined ? "bounds a stalled response and stops the worker" : `stops the worker on ${signal}`,
      async () => {
        const server = createServer((_request, response) => {
          response.writeHead(200, { "Content-Type": "application/json" })
          response.write("{")
        })
        const requested = once(server, "request")
        const upstreamPort = await listen(server)
        const fixture = await mkdtemp(join(tmpdir(), "harness-wrangler-"))
        // A real Worker proxies a real HTTP response whose body never finishes.
        // No process, fetch, Wrangler or workerd implementation is replaced.
        await copyFile(join(directory, "smoke.mjs"), join(fixture, "smoke.mjs"))
        await symlink(join(directory, "node_modules"), join(fixture, "node_modules"), "junction")
        await writeFile(
          join(fixture, "worker.js"),
          `export default { fetch: () => fetch("http://127.0.0.1:${upstreamPort}/") }\n`
        )
        await writeFile(
          join(fixture, "wrangler.jsonc"),
          JSON.stringify({
            name: "harness-stalled-response",
            main: "worker.js",
            compatibility_date: "2025-09-01"
          })
        )
        // Keep an explicit free port so the assertion can prove cleanup by rebinding.
        const reservation = createServer()
        const port = await listen(reservation)
        await close(reservation)
        const child = execFile(process.execPath, ["smoke.mjs"], {
          cwd: fixture,
          env: { ...process.env, FLOWS_WORKERD_PORT: String(port), FLOWS_WORKERD_STARTUP_MS: "20000" },
          timeout: 35_000
        })
        const finished = new Promise<{ code: number | null; killedBy: NodeJS.Signals | null }>((resolve) => {
          child.once("exit", (code, killedBy) => resolve({ code, killedBy }))
        })
        let stderr = ""
        child.stderr!.on("data", (chunk) => {
          stderr += chunk
        })
        try {
          await Promise.race([
            requested,
            finished.then((result) => {
              throw new Error(`Smoke exited before requesting: ${JSON.stringify(result)}\n${stderr}`)
            })
          ])
          if (signal !== undefined) child.kill(signal)
          const result = await finished
          expect(result.killedBy, stderr).toBeNull()
          expect(result.code, stderr).toBe(
            signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 1
          )
          if (signal === undefined) expect(stderr).toContain("did not answer within 20000 ms")
          const probe = createServer()
          await new Promise<void>((resolve, reject) => {
            probe.once("error", reject)
            probe.listen(port, "127.0.0.1", resolve)
          })
          await close(probe)
        } finally {
          child.kill("SIGTERM")
          await close(server)
          await rm(fixture, { recursive: true, force: true })
        }
      },
      45_000
    )
  }
})
