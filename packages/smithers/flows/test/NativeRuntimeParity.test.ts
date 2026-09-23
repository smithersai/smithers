import { expect, it } from "@effect/vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/native-runtime.ts", import.meta.url))

// SandboxedFlow's bun cases skip the same way on a machine without bun.
const bunInstalled = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0

it.skipIf(!bunInstalled).each([["node", "bun"], ["bun", "node"]] as const)(
  "resumes a %s-created durable run in %s without repeating its completed action",
  (first, second) => {
    const directory = mkdtempSync(join(tmpdir(), "flows-native-parity-"))
    const run = (runtime: string, phase: string) =>
      JSON.parse(
        execFileSync(
          runtime === "node" ? process.execPath : "bun",
          [fixture, runtime, directory, phase],
          // Each cold child compiles the entire native composition. Bound it
          // independently: Vitest cannot interrupt execFileSync while it runs.
          { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" }
        ).trim().split("\n").at(-1)!
      )
    try {
      expect(run(first, "park")).toMatchObject({ status: "suspended", dispatches: 1 })
      expect(run(second, "resume")).toMatchObject({
        status: "completed",
        dispatches: 1,
        result: "original result:approved"
      })
      expect(run(first, "reopen")).toMatchObject({
        status: "completed",
        dispatches: 1,
        result: "original result:approved"
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
  190_000
)
