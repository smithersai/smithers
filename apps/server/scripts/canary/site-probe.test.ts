import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

test("a missing site-probe report path is refused before network requests or file writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "site-probe-args-"))
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests += 1
    return new Response("not found", { status: 404 })
  } })
  try {
    const results = []
    for (const args of [["--json"], ["--json", "--other"]]) {
      const process = Bun.spawn([globalThis.process.execPath, fileURLToPath(new URL("./site-probe.ts", import.meta.url)), server.url.origin, ...args], {
        cwd: directory, env: {}, stdout: "pipe", stderr: "pipe"
      })
      const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text(), new Response(process.stdout).text()])
      results.push({ code, stderr })
    }
    expect(results.map(result => result.code)).toEqual([2, 2])
    expect(requests).toBe(0)
    expect(existsSync(join(directory, "--other"))).toBe(false)
    for (const result of results) expect(result.stderr).toContain("--json needs a value")
  } finally {
    server.stop(true)
    rmSync(directory, { recursive: true, force: true })
  }
})
