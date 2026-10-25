// The build's capture of `SANDBOX_COMMAND_MAX_SECONDS` (vite.config.ts), through Vite's own config resolution, as
// `vite build` and the dev server resolve it: the browser's run tool gets the deployment's limit
// (src/features/sandbox/flows.ts `COMMAND_MAX_SECONDS`), the job's own unless set, and a value the Worker would refuse
// (src/features/sandbox/config.ts) fails the build before anything deploys.
import { join } from "node:path"
import { resolveConfig } from "vite"
import { afterEach, expect, test, vi } from "vitest"
import { COMMAND_LIMIT_SECONDS } from "./contract"

const root = join(import.meta.dirname, "..", "..", "..")
afterEach(() => vi.unstubAllEnvs())

/** The build's resolved config with `SANDBOX_COMMAND_MAX_SECONDS` set to `value`, or unset. */
const resolved = (value: string | undefined) => {
  vi.stubEnv("SANDBOX_COMMAND_MAX_SECONDS", value)
  return resolveConfig({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent" }, "build")
}

test("the build defines the deployment's SANDBOX_COMMAND_MAX_SECONDS for the browser, the job's limit unless set", async () => {
  expect((await resolved("900")).define).toMatchObject({ "globalThis.__SANDBOX_COMMAND_MAX_SECONDS__": "900" })
  expect((await resolved(undefined)).define).toMatchObject({ "globalThis.__SANDBOX_COMMAND_MAX_SECONDS__": String(COMMAND_LIMIT_SECONDS) })
  expect((await resolved("")).define).toMatchObject({ "globalThis.__SANDBOX_COMMAND_MAX_SECONDS__": String(COMMAND_LIMIT_SECONDS) })
}, 60_000)

test("a value the Worker would refuse fails the build", async () => {
  for (const invalid of ["59", "3601", "1.5", "an hour"]) {
    await expect(resolved(invalid), invalid).rejects.toThrow()
  }
}, 60_000)
