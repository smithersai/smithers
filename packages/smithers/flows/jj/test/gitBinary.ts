import { statSync } from "node:fs"
import { delimiter, resolve } from "node:path"
import { isExecutable } from "../src/node/resolveJjBinary.ts"

/** Find an executable file, ignoring missing entries and directories. */
export const resolveGitBinary = (path: string): string | undefined =>
  path.split(delimiter)
    .map((directory) => resolve(directory, process.platform === "win32" ? "git.exe" : "git"))
    .find((candidate) => {
      try {
        return statSync(candidate).isFile() && isExecutable(candidate)
      } catch {
        return false
      }
    })

/** Resolve once, before tests change cwd or PATH. */
export const gitBinary = resolveGitBinary(process.env.PATH ?? "")
