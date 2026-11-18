/** Makes a checkout of this repository runnable, preferring the local package store. */
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

/** Installs the dependencies of the checkout at `directory`, or fails with the end of what pnpm printed. */
export const installDependencies = async (directory: string): Promise<void> => {
  try {
    await run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: directory, maxBuffer: 1 << 26 })
  } catch (cause) {
    const { stderr, stdout } = cause as { readonly stderr?: string; readonly stdout?: string }
    throw new Error(`${stdout ?? ""}${stderr ?? ""}`.slice(-2000))
  }
}
