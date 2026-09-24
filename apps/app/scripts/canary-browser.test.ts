/*
 * The browser canary's contract with the alert decision
 * (apps/server/scripts/canary/uptime-checks.ts `browserVerdict`): result.json
 * always carries a `status`, and an unconfigured canary is a `skip` that names
 * the unset variables, never a failure that files "smithers.sh is failing".
 * These cases stop before Chromium launches, so no network is touched.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = join(import.meta.dir, "canary-browser.ts")
const WORKSPACE = "11111111-2222-3333-4444-555555555555"
/* Each case spawns bun and loads Playwright; no case launches Chromium. */
const SPAWN_TIMEOUT_MS = 30_000

const run = async (env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string; result: Record<string, unknown> }> => {
  const evidence = mkdtempSync(join(tmpdir(), "canary-browser-"))
  const child = Bun.spawn(["bun", script], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    // Stated, not inherited: a developer's canary cookie must never reach a unit test.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CANARY_URL: "https://smithers.sh",
      CANARY_BROWSER_EVIDENCE: evidence,
      ...env
    }
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const exitCode = await child.exited
  const result = JSON.parse(readFileSync(join(evidence, "result.json"), "utf8")) as Record<string, unknown>
  return { exitCode, stdout, stderr, result }
}

describe("canary-browser.ts", () => {
  test("with nothing configured it skips out loud, names every unset variable and exits 0", async () => {
    const { exitCode, stdout, result } = await run({})
    expect(exitCode).toBe(0)
    expect(result.status).toBe("skip")
    expect(result.missing).toEqual(["CANARY_SESSION_COOKIE", "CANARY_BROWSER_FLOW", "CANARY_BROWSER_WORKSPACE"])
    expect(stdout).toContain("skip: browser canary not configured")
    expect(stdout).toContain("CANARY_SESSION_COOKIE")
  }, SPAWN_TIMEOUT_MS)

  test("the workflow's empty-string secrets count as unset", async () => {
    const { exitCode, result } = await run({ CANARY_SESSION_COOKIE: "", CANARY_BROWSER_FLOW: "", CANARY_BROWSER_WORKSPACE: "" })
    expect(exitCode).toBe(0)
    expect(result.status).toBe("skip")
  }, SPAWN_TIMEOUT_MS)

  test("a configured cookie with no declared login fails instead of guessing whose it is", async () => {
    const { exitCode, stderr, result } = await run({
      CANARY_SESSION_COOKIE: "smithers_session=probe",
      CANARY_BROWSER_FLOW: "canary",
      CANARY_BROWSER_WORKSPACE: WORKSPACE
    })
    expect(exitCode).toBe(1)
    expect(result.status).toBe("fail")
    expect(String(result.error)).toContain("CANARY_SESSION_LOGIN")
    expect(stderr).toContain("Browser canary failed")
    expect(JSON.stringify(result)).not.toContain("smithers_session=probe")
  }, SPAWN_TIMEOUT_MS)
})
