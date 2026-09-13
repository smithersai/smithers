import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it("serves the shared authenticated gateway protocol on Bun", async () => {
  const { stdout } = await promisify(execFile)(
    "bun",
    [new URL("./fixtures/bun-gateway.ts", import.meta.url).pathname],
    {
      timeout: 60_000,
      maxBuffer: 1024 * 1024
    }
  )
  expect(JSON.parse(stdout)).toMatchObject({ runtime: "bun", passed: true })
}, 65_000)
