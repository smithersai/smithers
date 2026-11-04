import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { vi } from "vitest"

/** Absolute paths of the command fixtures that routes point at. */
export const visibleModule = fileURLToPath(new URL("./fixtures/command/visible.ts", import.meta.url))
export const specialModule = fileURLToPath(new URL("./fixtures/command/special%23flow.ts", import.meta.url))
export const invalidModule = fileURLToPath(new URL("./fixtures/command/invalid.ts", import.meta.url))
export const recordedModule = fileURLToPath(new URL("./fixtures/command/recorded.ts", import.meta.url))
export const refinedModule = fileURLToPath(new URL("./fixtures/command/refined.ts", import.meta.url))

/** Runs an ES module script in a fresh Node process with VibeLang's loader and returns what it prints. */
export const runModuleScript = (script: string): string =>
  execFileSync(process.execPath, [
    "--import",
    "vibelang/register",
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    script
  ], {
    encoding: "utf8"
  })

/** Writes, in a fresh temporary directory, a module whose top-level await waits on `globalThis.fsMetadataGate`. */
export const writeStuckModule = async (): Promise<{ directory: string; source: string }> => {
  const directory = await mkdtemp(join(tmpdir(), "fs-metadata-"))
  const source = join(directory, "stuck.mjs")
  await writeFile(source, "await globalThis.fsMetadataGate; export default null\n")
  return { directory, source }
}

/** Removes a temporary directory and everything under it. */
export const removeDirectory = (directory: string): Promise<void> => rm(directory, { recursive: true, force: true })

/** Silences and records `console.log` and `console.error` until each spy is restored. */
export const spyOnConsole = () => ({
  stdout: vi.spyOn(console, "log").mockImplementation(() => undefined),
  stderr: vi.spyOn(console, "error").mockImplementation(() => undefined)
})
