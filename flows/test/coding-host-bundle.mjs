/** Explicit native acceptance of the deployment bundler on the invoking runtime. */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { bundle } from "../coding/build.mjs"

const temporary = await mkdtemp(join(tmpdir(), "smithers-host-bundle-"))
try {
  const mode = process.argv[2] ?? "plan"
  if (mode !== "plan" && mode !== "request") throw new Error("Host bundle acceptance mode must be plan or request")
  const fixture = mode === "request" ? "coding-workspace-helper" : "coding-native"
  const output = join(temporary, `${fixture}.test.mjs`)
  await bundle(fileURLToPath(new URL(`./${fixture}.test.ts`, import.meta.url)), output)
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.versions.bun ? "test" : "--test", output], {
      stdio: "inherit", env: { ...process.env, SMITHERS_ACCEPTANCE_SOURCE_ROOT: fileURLToPath(new URL("../", import.meta.url)) }
    })
    child.on("error", reject)
    child.on("exit", (code, signal) => signal ? reject(new Error(`Bundled host test exited on ${signal}`)) : resolve(code ?? 1))
  })
  process.exitCode = status
} finally {
  await rm(temporary, { recursive: true, force: true })
}
