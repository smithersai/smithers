/**
 * What every turn is told before its task: the working directory, the
 * project's instruction files, and the conversation so far.
 *
 * Instruction files follow pi: in each directory from the filesystem root
 * down to the working directory, the first of `AGENTS.override.md`,
 * `AGENTS.md`, `CLAUDE.md` is read, after the global `~/.smithers/agent/AGENTS.md`.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export const instructionNames = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const

/** One earlier piece of the conversation, oldest first. */
export type Entry =
  | { readonly kind: "exchange"; readonly user: string; readonly answer: string }
  | { readonly kind: "shell"; readonly text: string }
  | { readonly kind: "undo"; readonly paths: ReadonlyArray<string> }

/** Instruction files, outermost first. */
export const instructionFiles = (cwd: string, home = homedir()): ReadonlyArray<string> => {
  const found: Array<string> = []
  const global = join(home, ".smithers", "agent", "AGENTS.md")
  if (existsSync(global)) found.push(global)
  const directories: Array<string> = []
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    directories.unshift(directory)
    if (dirname(directory) === directory) break
  }
  for (const directory of directories) {
    const first = instructionNames.map((name) => join(directory, name)).find((path) => existsSync(path))
    if (first !== undefined && !found.includes(first)) found.push(first)
  }
  return found
}

export const system = (cwd: string, history: ReadonlyArray<Entry>): Array<string> => {
  const parts = [
    `You are a coding agent working in ${cwd}. Read before you change, keep edits small, and verify with the repository's own commands. Paths are relative to ${cwd}.`
  ]
  const files = instructionFiles(cwd)
  if (files.length > 0) {
    parts.push(
      "Project-specific instructions and guidelines:\n\n" +
        files.map((path) => `<project_instructions path="${path}">\n${readFileSync(path, "utf8")}\n</project_instructions>`).join("\n\n")
    )
  }
  if (history.length > 0) {
    parts.push(
      "The conversation so far, oldest first:\n\n" +
        history.map((entry) =>
          entry.kind === "exchange"
            ? `User: ${entry.user}\nYou answered: ${entry.answer}`
            : entry.kind === "undo"
            ? `User reverted your earlier edits to: ${entry.paths.join(", ")}. Re-read them before editing.`
            : `User ran a shell command:\n${entry.text}`
        ).join("\n\n")
    )
  }
  return parts
}
