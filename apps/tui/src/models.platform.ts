/**
 * The platform code of models.vibe: the provider detection host, which reads
 * credential files and the home directory through Node, which a .vibe file
 * does not import.
 */
import * as Providers from "@smthrs/cli/Providers"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

/**
 * The host `Providers.detect` and `Providers.claudeCode` read: the given
 * environment, this user's home directory and a file reader that answers
 * `undefined` for a file it cannot read.
 * @throws {never}
 */
export function hostOf(environment: NodeJS.ProcessEnv): Providers.Host {
  return {
    environment,
    homeDirectory: homedir(),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return undefined
      }
    },
    claudeCode: () => Providers.claudeCodeLogin(environment)
  }
}
