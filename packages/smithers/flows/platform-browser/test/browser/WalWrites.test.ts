import { expect, it } from "vitest"
import * as Harness from "./Harness.ts"

it("bounds WAL writes and keeps an acknowledged commit when its worker is killed before another SQL call", async () => {
  const server = await Harness.serve()
  const profile = Harness.profile()
  const context = await Harness.launch(profile.directory)
  try {
    const page = await context.newPage()
    await page.goto(server.origin + "/cache")
    const run = (mode: string) =>
      page.evaluate((mode) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const worker = new Worker(`/wal-worker.js?mode=${mode}`, { type: "module" })
          worker.onerror = () => {
            worker.terminate()
            reject(new Error("WAL worker failed"))
          }
          worker.onmessage = ({ data }) => {
            worker.terminate()
            resolve(data)
          }
        }), mode)
    const first = await run("write")
    expect(first).toMatchObject({
      committed: true,
      journal: [{ journal_mode: "wal" }],
      synchronous: [{ synchronous: 2 }]
    })
    expect(first.syncs).toBeGreaterThan(0)
    // Reopening the real OPFS files after termination keeps exactly the committed values.
    expect(await run("read")).toMatchObject({ valid: true, integrity: [{ integrity_check: "ok" }] })
    expect(await run("uncommitted")).toEqual({ uncommitted: true })
    expect(await run("read")).toMatchObject({ valid: true, integrity: [{ integrity_check: "ok" }] })
    console.log("WAL_HOST_WRITES", first.writes)
    expect(first.writes).toBeLessThanOrEqual(16)
  } finally {
    await context.close()
    profile.remove()
    await server.close()
  }
})
