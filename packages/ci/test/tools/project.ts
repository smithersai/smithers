/**
 * Real projects and the repository's own real tools, for the tests of which
 * tool reads a file Smithers CI wrote. The tools are development dependencies
 * of this package; a project reaches them through a link to its
 * `node_modules`, which the project's `.gitignore` names.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** The `packages/ci` directory. */
export const packageRoot = fileURLToPath(new URL("../..", import.meta.url))

const modules = join(packageRoot, "node_modules")

/** The `smithers-ci` program. */
export const program = join(packageRoot, "bin", "smithers-ci.mjs")

/** The script a tool's package names as its program: `tool("typescript", "tsc")`. */
export const tool = (name: string, command: string = name): string => {
  const directory = join(modules, name)
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
    readonly bin: string | Readonly<Record<string, string>>
  }
  return join(directory, typeof manifest.bin === "string" ? manifest.bin : manifest.bin[command] as string)
}

/** A module of a package another development dependency brings, such as the parser typescript-eslint uses. */
export const moduleOf = (owner: string, name: string): string =>
  createRequire(join(modules, owner, "package.json")).resolve(name)

/** The plugins this package's own dprint configuration names, which the format check has already fetched. */
export const dprintPlugins: ReadonlyArray<string> =
  (JSON.parse(readFileSync(join(packageRoot, "dprint.json"), "utf8")) as { readonly plugins: ReadonlyArray<string> })
    .plugins

/** How a run ended, everything it printed, and what it printed on standard output alone. */
export interface Ran {
  readonly status: number | null
  readonly output: string
  readonly stdout: string
}

/** The environment a tool starts in: this process's, without what the test runner set for itself. */
const environment = (extra: Readonly<Record<string, string>>): Record<string, string | undefined> => {
  const kept = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      !name.startsWith("VITEST") && name !== "NODE_V8_COVERAGE" && name !== "NODE_OPTIONS"
    )
  )
  return { ...kept, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", ...extra }
}

/** Runs a Node script, or with `node` itself when `script` is `undefined`, in `cwd`. */
export const node = (
  cwd: string,
  script: string | undefined,
  args: ReadonlyArray<string>,
  extra: Readonly<Record<string, string>> = {}
): Ran => {
  const result = spawnSync(process.execPath, script === undefined ? [...args] : [script, ...args], {
    cwd,
    encoding: "utf8",
    env: environment(extra),
    maxBuffer: 64 * 1024 * 1024
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}`, stdout: result.stdout }
}

/** Runs a program on the path, in `cwd`. */
export const run = (cwd: string, command: string, args: ReadonlyArray<string>): Ran => {
  const result = spawnSync(command, [...args], { cwd, encoding: "utf8", env: environment({}) })
  return { status: result.status, output: `${result.stdout}${result.stderr}`, stdout: result.stdout }
}

const git = (root: string, ...args: ReadonlyArray<string>): void => {
  const result = spawnSync("git", [...args], {
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
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
}

/** Writes `files` under `root`. */
export const write = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

/** Commits everything in `root`. */
export const commit = (root: string, subject: string): void => {
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--allow-empty", "--message", subject)
}

const made: Array<string> = []

/** A git repository holding `files`, with one commit. `linked` gives it this package's installed tools. */
export const project = (files: Readonly<Record<string, string>>, linked = true): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-ci-own-tools-"))
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  write(root, files)
  if (linked) symlinkSync(modules, join(root, "node_modules"), "dir")
  commit(root, "the project")
  return root
}

/** Removes every repository {@link project} made. */
export const removeProjects = (): void => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
}

/** The repository's own workflow: one job on two versions of Node, as commander.js has it. */
export const ownWorkflow = (command: string): string =>
  [
    "name: build",
    "on: [push, pull_request]",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    strategy:",
    "      matrix:",
    "        node-version: [22.x, 24.x]",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: ${{ matrix.node-version }}",
    `      - run: ${command}`,
    ""
  ].join("\n")
