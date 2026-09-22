import { expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/atomic-helper-identity.ts", import.meta.url))

it.skipIf(process.platform !== "darwin").each(["node", "bun"])(
  "preserves the native helper identity during concurrent Apple tool launches in %s",
  (runtime) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "flows-helper-identity-")))
    try {
      const output = execFileSync(runtime === "node" ? process.execPath : "bun", [fixture, directory], {
        encoding: "utf8",
        timeout: 180_000,
        killSignal: "SIGKILL"
      })
      expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ iterations: 64, failures: [] })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
  185_000
)
