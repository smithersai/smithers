/**
 * Real repositories and real processes for the `smithers-ci` tests.
 */

import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

/** A justfile whose CI is `ci`: it needs `test`, which needs `build`. */
export const justfile = [
  "build:",
  "    zig build",
  "",
  "test: build",
  "    zig build test",
  "    zig build check",
  "",
  "ci: test",
  ""
]
  .join(
    "\n"
  )

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Smithers CI test",
      GIT_AUTHOR_EMAIL: "ci@example.invalid",
      GIT_COMMITTER_NAME: "Smithers CI test",
      GIT_COMMITTER_EMAIL: "ci@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null"
    }
  })

/** The commit `HEAD` names in a repository. */
export const head = (root: string): string => git(root, "rev-parse", "HEAD").trim()

/** A fresh directory under the system temp directory. */
export const temporary = (prefix: string): string => mkdtempSync(join(tmpdir(), `smithers-ci-${prefix}-`))

/** Removes a directory made by {@link temporary} or {@link repository}. */
export const remove = (path: string): void => rmSync(path, { recursive: true, force: true })

/**
 * A git repository with a justfile and one commit per subject, each changing
 * one more file. A subject holding `[mismatch]` makes the test replay report a
 * mismatch for that commit.
 */
export const repository = (subjects: ReadonlyArray<string> = ["first", "second", "third"]): string => {
  const root = temporary("repo")
  git(root, "init", "--quiet", "--initial-branch=main")
  writeFileSync(join(root, "justfile"), justfile)
  for (const [index, subject] of subjects.entries()) {
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", `${index}.zig`), `pub const n = ${index};\n`)
    git(root, "add", "--all")
    git(root, "commit", "--quiet", "--message", subject)
  }
  return root
}

/**
 * Every file under `root`, `.git` included, by relative path: its mode and the
 * SHA-256 of its bytes. Equal snapshots mean a byte-identical tree.
 */
export const snapshot = (root: string): Record<string, string> => {
  const files: Record<string, string> = {}
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex")
        files[relative(root, path)] = `${statSync(path).mode.toString(8)} ${digest}`
      }
    }
  }
  walk(root)
  return files
}

/** The paths whose bytes differ between two snapshots, added and removed ones included. */
export const changed = (before: Record<string, string>, after: Record<string, string>): ReadonlyArray<string> =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]).sort()

/** What one run of a program printed and how it exited. */
export interface Outcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const packageRoot = fileURLToPath(new URL("../../", import.meta.url))

/** The published executable. */
export const bin = join(packageRoot, "bin", "smithers-ci.mjs")

/** The same program over the test parts in `parts.vibe`. */
export const program = join(packageRoot, "test", "cli", "program.mjs")

/** Runs a Node entry as a child process in `cwd` and collects what it printed. */
export const spawn = (entry: string, args: ReadonlyArray<string>, cwd: string): Promise<Outcome> =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [entry, ...args],
      { cwd, encoding: "utf8", timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") reject(error)
        else resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
      }
    )
  })

/** A console that records what the program logs, for runs inside this process. */
export const recorder = () => {
  const out: Array<string> = []
  const err: Array<string> = []
  const text = (args: ReadonlyArray<unknown>): string => args.map(String).join(" ")
  const service = {
    ...console,
    log: (...args: ReadonlyArray<unknown>) => void out.push(text(args)),
    error: (...args: ReadonlyArray<unknown>) => void err.push(text(args))
  }
  return {
    service,
    stdout: () => out.map((line) => `${line}\n`).join(""),
    stderr: () => err.map((line) => `${line}\n`).join("")
  }
}

/** A file's text. */
export const read = (path: string): string => readFileSync(path, "utf8")
