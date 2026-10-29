import { execFile } from "node:child_process"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const run = promisify(execFile)
const runner = fileURLToPath(new URL("../scripts/test-services.mjs", import.meta.url))

it.each(["ELECTRIC_URL", "DATABASE_URL"])("refuses a test stack configured with only %s", async (name) => {
  const environment = { ...process.env }
  delete environment.ELECTRIC_URL
  delete environment.DATABASE_URL
  environment[name] = "private-test-endpoint"
  const result = await run(process.execPath, [runner], { env: environment }).then(
    () => {
      throw new Error("An incomplete test stack must be refused")
    },
    (error: { code: number; stdout: string; stderr: string }) => error
  )
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Provide both ELECTRIC_URL and DATABASE_URL")
  expect(result.stdout + result.stderr).not.toContain("private-test-endpoint")
})

it("fails the integration suite when its required Electric service is unavailable", async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  const result = await run(process.execPath, [
    runner,
    "test/ElectricCollection.test.ts",
    "--coverage.enabled=false"
  ], {
    env: {
      ...process.env,
      ELECTRIC_URL: `http://127.0.0.1:${port}`,
      DATABASE_URL: `postgresql://127.0.0.1:${port}/unavailable`
    }
  }).then(
    () => {
      throw new Error("A missing required service must fail the suite")
    },
    (error: { code: number; stdout: string; stderr: string }) => error
  )
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("fetch failed")
  expect(result.stdout + result.stderr).not.toContain("Electric suites skipped")
})
