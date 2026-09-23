import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execute = promisify(execFile)
const fixture = fileURLToPath(new URL("./fixtures/workspace-routing-portable.ts", import.meta.url))

for (const runtime of ["node", "bun"]) {
  it(`uses the existing ${runtime} SQL clients for history admission`, async () => {
    const { stdout } = await execute(
      runtime,
      runtime === "node"
        ? ["--experimental-strip-types", fixture, runtime]
        : [fixture, runtime],
      { timeout: 60_000, maxBuffer: 1024 * 1024 }
    )
    expect(JSON.parse(stdout)).toMatchObject({ runtime, passed: true })
  }, 65_000)
}
