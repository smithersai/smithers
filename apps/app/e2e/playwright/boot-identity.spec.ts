import { expect, test } from "@playwright/test"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"

/*
 * The boot-blocking regression (the local app stuck on "Smithers is starting
 * your session." while /api/auth/session pended on the remote identity seam):
 * first paint — the entrance wordmark, then the guide shell — must never wait
 * on that seam.
 * The T1 host stubs identity out entirely, so this spec boots its own origin
 * (identity-hang-host.ts) with the seam behind a socket that never answers.
 */

const startIdentityHangHost = async (): Promise<{ readonly origin: string; readonly child: ChildProcess }> => {
  const child = spawn("bun", ["e2e/playwright/identity-hang-host.ts"], {
    // The Playwright runner's cwd is the config directory (apps/app).
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "inherit"]
  })
  const origin = await new Promise<string>((resolve, reject) => {
    let buffer = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      const match = /SMITHERS_LOCAL_ORIGIN=(\S+)/.exec(buffer)
      if (match?.[1] !== undefined) resolve(match[1])
    })
    child.on("exit", (code) => reject(new Error(`identity-hang-host exited ${code} before printing its origin`)))
    setTimeout(() => reject(new Error("identity-hang-host never printed its origin")), 30_000)
  })
  return { origin, child }
}

test.describe("boot with the identity seam hanging", () => {
  let child: ChildProcess
  let origin: string

  test.beforeAll(async () => {
    ;({ origin, child } = await startIdentityHangHost())
  })

  test.afterAll(() => {
    child.kill("SIGTERM")
  })

  test("the shell paints the SMITHERS wordmark before anything loads, and the app mounts without the identity answer", async ({ page }) => {
    // Hold the boot chunk so the entrance is observable; identity hangs either way.
    let releaseChunk!: () => void
    const chunkHeld = new Promise<void>((resolve) => { releaseChunk = resolve })
    await page.route("**/ControllerBoot.client*.js", async (route) => {
      await chunkHeld
      await route.continue()
    })
    try {
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" })
      await expect(page.locator(".session-shell > .guide-wordmark")).toBeVisible()
      releaseChunk()
      /*
       * Before the fix this never resolved: boot awaited the identity session
       * read, which this fixture's upstream never answers. The guide shell is
       * the app mounted (its composer stays hidden until Command-K).
       */
      await expect(page.locator(".guide-shell")).toBeVisible({ timeout: 20_000 })
    } finally {
      releaseChunk()
      await page.unroute("**/ControllerBoot.client*.js")
    }
  })
})
