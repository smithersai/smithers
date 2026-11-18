/**
 * Real repositories and real processes for the `smithers-ci` tests.
 */

import { execFile, execFileSync, spawn as spawnChild, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
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

/** A justfile whose every recipe passes, for a test that needs a CI that passes on any machine. */
export const passingJustfile = "build:\n    true\n\ntest: build\n    true\n\nci: test\n"

/** Runs git in `root` as a fixed author, apart from the machine's configuration. */
export const git = (root: string, ...args: ReadonlyArray<string>): string =>
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

/** Writes `files` under `root`, then commits everything there, links included. */
export const commit = (root: string, subject: string, files: Readonly<Record<string, string>> = {}): void => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", subject)
}

/**
 * A git repository holding an npm workspace of two packages, `a` and `b`,
 * and a workflow whose one command runs both packages' tests.
 */
export const workspace = (): string => {
  const root = temporary("workspace")
  const files: Readonly<Record<string, string>> = {
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
    "package-lock.json": "{}\n",
    "packages/a/package.json": JSON.stringify({ name: "a", scripts: { test: "node -e 0" } }),
    "packages/b/package.json": JSON.stringify({ name: "b", scripts: { test: "node -e 0" }, dependencies: { a: "*" } }),
    ".github/workflows/ci.yml": [
      "on: [push]",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: npm run test --workspaces --if-present",
      ""
    ].join("\n")
  }
  git(root, "init", "--quiet", "--initial-branch=main")
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", "first")
  return root
}

/**
 * Every file under `root`, `.git` included, by relative path: its mode and the
 * SHA-256 of its bytes, or where a link points. Equal snapshots mean a
 * byte-identical tree.
 */
export const snapshot = (root: string): Record<string, string> => {
  const files: Record<string, string> = {}
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isSymbolicLink()) files[relative(root, path)] = `link ${readlinkSync(path)}`
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

/**
 * True when this host can record what a step reads: Linux with a `strace`
 * that can trace a process. A step that names no inputs is then reused until
 * a file it read changes; on any other host it runs on every change.
 */
export const observes = process.platform === "linux" &&
  spawnSync("strace", ["-f", "--seccomp-bpf", "-e", "trace=openat", "-o", "/dev/null", "true"]).status === 0

/** The published executable. */
export const bin = join(packageRoot, "bin", "smithers-ci.mjs")

/** The same program over the test parts in `parts.vibe`. */
export const program = join(packageRoot, "test", "cli", "program.mjs")

/** Runs a Node entry as a child process in `cwd` and collects what it printed. */
export const spawn = (
  entry: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Outcome> =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [entry, ...args],
      // A real replay runs the repository's commands and the generated targets.
      { cwd, env, encoding: "utf8", timeout: 540_000 },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") reject(error)
        else resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
      }
    )
  })

/**
 * A `PATH` with the same programs as this one but `program`: each directory
 * that holds it is replaced by a directory of links to everything else in it.
 */
export const pathWithout = (program: string, parent: string): string =>
  (process.env["PATH"] ?? "").split(":").map((directory, index) => {
    if (!existsSync(join(directory, program))) return directory
    const links = join(parent, `path-${index}`)
    mkdirSync(links, { recursive: true })
    for (const name of readdirSync(directory)) {
      if (name !== program) symlinkSync(join(directory, name), join(links, name))
    }
    return links
  }).join(":")

/** Runs a Node entry as {@link spawn} does, with `env` added to this process's environment. */
export const spawnWith = (
  entry: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>>
): Promise<Outcome> =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [entry, ...args],
      { cwd, encoding: "utf8", timeout: 540_000, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") reject(error)
        else resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
      }
    )
  })

/**
 * Starts a Node entry as a child process in `cwd`, with `env` added to this
 * process's environment. `done` resolves when it has ended and its output is
 * closed; `signal` sends it a signal.
 */
export const start = (
  entry: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> = {}
) => {
  const child = spawnChild(process.execPath, [entry, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  })
  const printed = { stdout: "", stderr: "" }
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => void (printed.stdout += chunk))
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => void (printed.stderr += chunk))
  const done = new Promise<Outcome>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? -1, ...printed }))
  })
  return { done, signal: (signal: "SIGINT" | "SIGTERM") => child.kill(signal) }
}

/** Whether a process with this id exists. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits until `holds`, looking ten times a second; rejects after `limitMs`. */
export const until = async (holds: () => boolean, what: string, limitMs = 100_000): Promise<void> => {
  const end = Date.now() + limitMs
  while (!holds()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Waits for a file another process writes whole, and gives its text. */
export const awaited = async (path: string): Promise<string> => {
  await until(() => existsSync(path) && readFileSync(path, "utf8").trim() !== "", path)
  return readFileSync(path, "utf8")
}

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
