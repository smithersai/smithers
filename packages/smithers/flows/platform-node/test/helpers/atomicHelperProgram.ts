/**
 * Real atomic helper programs whose behaviour a test writes as Node source.
 *
 * POSIX gets a shell script that execs Node on the body. A Windows helper must
 * be an actual executable, so there a small SEA runs the adjacent `.cjs` in the
 * same process: cancellation kills the PID that owns the protocol streams,
 * with no shell or orphaned wrapper child.
 *
 * Call it at module scope; it registers the suite's launcher build and cleanup.
 */
import { execFile } from "node:child_process"
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll } from "vitest"

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** Registers the suite's launcher and returns a writer of helper programs into `directory`. */
export const atomicHelperProgram = (): (directory: string, body: string) => Promise<string> => {
  let windowsLauncher: string | undefined
  let launcherDirectory: string | undefined
  beforeAll(async () => {
    if (process.platform !== "win32") return
    launcherDirectory = await mkdtemp(join(tmpdir(), "smithers-helper-launcher-"))
    const main = join(launcherDirectory, "main.cjs")
    const config = join(launcherDirectory, "sea.json")
    windowsLauncher = join(launcherDirectory, "helper.exe")
    await writeFile(main, "const file=process.execPath+'.cjs';require('node:module').createRequire(file)(file)")
    await writeFile(
      config,
      JSON.stringify({
        main,
        output: windowsLauncher,
        disableExperimentalSEAWarning: true,
        execArgvExtension: "none"
      })
    )
    await promisify(execFile)(process.execPath, ["--build-sea", config], { timeout: 60_000 })
  }, 60_000)
  afterAll(async () => {
    if (launcherDirectory !== undefined) {
      await rm(launcherDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
  return async (directory, body) => {
    if (windowsLauncher !== undefined) {
      const path = join(directory, "helper.exe")
      await copyFile(windowsLauncher, path)
      await writeFile(`${path}.cjs`, body)
      return path
    }
    const path = join(directory, "helper")
    await writeFile(path, `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(body)}\n`)
    await chmod(path, 0o755)
    return path
  }
}
