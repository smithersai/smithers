import type { JustBashLike } from "@smthrs/platform-browser/BrowserChildProcessSpawner"
import { mkdtempSync, realpathSync } from "node:fs"
import * as NodeFsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * One volume for the VibeLang quickstart test: a temporary directory, its
 * `node:fs/promises` view (the shape `ZenFsPromisesLike` slices), and an
 * interpreter stand-in whose only command, `cat`, reads that same view. A
 * page builds the pair from one ZenFS mount and `new Bash({ fs })`.
 *
 * @throws When the temporary directory cannot be created.
 */
export const makeVolume = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "platform-browser-quickstart-")))
  const bash: JustBashLike = {
    exec: async (commandLine, options) => {
      const [command, file] = commandLine.split(" ").map((word) => word.replaceAll("'", ""))
      if (command !== "cat" || file === undefined) {
        return { stdout: "", stderr: `${command}: not found\n`, exitCode: 127 }
      }
      const stdout = await NodeFsPromises.readFile(join(options?.cwd ?? root, file), "utf8")
      return { stdout, stderr: "", exitCode: 0 }
    }
  }
  return { root, bash, fs: NodeFsPromises }
}
