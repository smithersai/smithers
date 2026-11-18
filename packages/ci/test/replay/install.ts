/** Makes a checkout of this repository runnable, with the packages it pins and the local package store. */
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

/** Installs the dependencies of the checkout at `directory`. */
export const installDependencies = async (directory: string): Promise<void> => {
  await run("pnpm", ["install", "--frozen-lockfile", "--offline"], { cwd: directory, maxBuffer: 1 << 26 })
}
