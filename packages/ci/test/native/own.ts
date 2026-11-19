/**
 * Real git repositories with a real small Smithers workspace of their own:
 * three targets, an `npm ci` that brings the repository's `smthrs`, and a
 * GitHub workflow that runs the targets.
 */
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { commit, repository, temporary } from "./repo.ts"

/** This checkout's `smthrs`, and the targets package a workspace file imports. */
export const smthrs = fileURLToPath(new URL("../../../../node_modules/.bin/smthrs", import.meta.url))
const targetsPackage = fileURLToPath(new URL("../../../../node_modules/@smthrs/targets", import.meta.url))

export const workspace = `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("own", {
  repository: "git+https://example.invalid/own.git",
  cache: S.Cache({ directory: ".flows" })
})
`

const target = (name: string, deps: ReadonlyArray<string>, cache = true): string =>
  `const ${name} = S.ToolBuild({
  tool: "bash",
  command: "bash",
  args: ["-e", "-c", "sh ${name}.sh"],
  inputs: [S.file("//${name}.sh")],
  outputs: [],
  deps: [${deps.join(", ")}],
  env: {},
  cache: ${cache}
})`

const packageFile = [
  `import { Smithers as S } from "@smthrs/targets"`,
  target("a", []),
  target("b", ["a"]),
  target("c", []),
  `export const Package = S.Package({ targets: { a, b, c } })`,
  ""
].join("\n")

/** A package file with one target per name, none depending on another. */
export const packageOf = (names: ReadonlyArray<string>): string =>
  [
    `import { Smithers as S } from "@smthrs/targets"`,
    ...names.map((name) => target(name, [])),
    `export const Package = S.Package({ targets: { ${names.join(", ")} } })`,
    ""
  ].join("\n")

/**
 * A package file whose target `a` runs outside Smithers build's own sandbox, as a target that asks for
 * `sandbox: "none"` does, so what it can reach is what the replay leaves it.
 */
export const packageWithOpenTarget = [
  `import { Smithers as S } from "@smthrs/targets"`,
  `const a = S.Shell.Test({ shell: "sh a.sh", sandbox: "none", timeout: "1h", data: [S.file("//a.sh")] })`,
  target("b", []),
  target("c", []),
  `export const Package = S.Package({ targets: { a, b, c } })`,
  ""
].join("\n")

/** The package file with a fourth target, `u`, that Smithers build is told not to cache. */
export const packageWithUncached = [
  `import { Smithers as S } from "@smthrs/targets"`,
  target("a", []),
  target("b", ["a"]),
  target("c", []),
  target("u", [], false),
  `export const Package = S.Package({ targets: { a, b, c, u } })`,
  ""
].join("\n")

/** A workflow that gives Smithers build `patterns`, after `before`, and has a job that runs no target. */
export const workflowFor = (patterns: ReadonlyArray<string>, before: ReadonlyArray<string> = []): string =>
  `on: [push]
jobs:
  targets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
${before.map((command) => `      - run: ${command}\n`).join("")}      - run: node_modules/.bin/smthrs ci ${
    patterns.map((pattern) => `'${pattern}'`).join(" ")
  } --ui plain
  docs:
    runs-on: ubuntu-latest
    steps:
      - run: sh docs.sh
`

const workflow = workflowFor(["//:a", "//:b", "//:c"])

/**
 * What `npm ci` runs after it installs: it gives the checkout the `smthrs` at
 * `command` and the targets package, as a dependency on `@smthrs/cli` does.
 */
export const installScript = (command: string): string =>
  `import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
mkdirSync("node_modules/.bin", { recursive: true })
mkdirSync("node_modules/@smthrs", { recursive: true })
writeFileSync("node_modules/.bin/smthrs", ${JSON.stringify(`#!/bin/sh\nexec ${command} "$@"\n`)})
chmodSync("node_modules/.bin/smthrs", 0o755)
symlinkSync(${JSON.stringify(targetsPackage)}, "node_modules/@smthrs/targets")
`

/** An install script that fails, as a broken dependency does. */
export const brokenInstall = "process.exit(1)\n"

export const manifest = JSON.stringify({
  name: "own",
  private: true,
  scripts: { postinstall: "node tools/install.mjs" }
})
export const lockfile = JSON.stringify({
  name: "own",
  lockfileVersion: 3,
  requires: true,
  packages: { "": { name: "own" } }
})

const pass = "exit 0\n"
const fail = "exit 1\n"

/** The files of a repository whose three targets pass, with its workspace file at `workspaceFile`. */
export const ownFiles = (command: string = smthrs): Readonly<Record<string, string>> => ({
  ".gitignore": "node_modules\n.flows\n",
  ".github/workflows/ci.yml": workflow,
  "WORKSPACE.ts": workspace,
  "PACKAGE.ts": packageFile,
  "package.json": manifest,
  "package-lock.json": lockfile,
  "tools/install.mjs": installScript(command),
  "a.sh": pass,
  "b.sh": pass,
  "c.sh": pass,
  "docs.sh": pass
})

export interface Own {
  readonly root: string
  readonly commits: ReadonlyArray<string>
}

/**
 * Six commits: all green; a change to `b` alone; `a` broken, with `b` behind
 * it; `a` fixed; an install that fails; the install fixed.
 */
export const makeOwn = (): Own => {
  const root = repository(ownFiles())
  const first = commit(root, "all green", { "c.sh": `# green\n${pass}` })
  const commits = [
    first,
    commit(root, "change b", { "b.sh": `# changed\n${pass}` }),
    commit(root, "break a", { "a.sh": fail }),
    commit(root, "fix a", { "a.sh": pass }),
    commit(root, "break the install", { "tools/install.mjs": brokenInstall }),
    commit(root, "fix the install", { "tools/install.mjs": installScript(smthrs) })
  ]
  return { root, commits }
}

/** A one-commit repository of its own targets whose `smthrs` is the script at `command`. */
export const makeOwnWith = (command: string, files: Readonly<Record<string, string>> = {}): string =>
  repository({ ...ownFiles(command), ...files })

/**
 * A script that stands where `smthrs` does. `body` is shell: `$real` is this
 * checkout's `smthrs`, and `$results` the file `--results-file` names.
 */
export const fakeSmthrs = (body: string): string => {
  const command = join(temporary("smthrs"), "smthrs")
  const header = [
    "#!/bin/sh",
    `real=${smthrs}`,
    `results=$(echo "$*" | sed -n 's/.*--results-file \\([^ ]*\\).*/\\1/p')`
  ]
  writeFileSync(command, [...header, body, ""].join("\n"))
  chmodSync(command, 0o755)
  return command
}

/** A sub-package's install that leaves the tool `greet`, which prints `greet.txt`, in its `node_modules/.bin`. */
export const toolInstall = `import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
mkdirSync("node_modules/.bin", { recursive: true })
writeFileSync("node_modules/.bin/greet", "#!/bin/sh\\ncat greet.txt\\n")
chmodSync("node_modules/.bin/greet", 0o755)
`

/**
 * A package file whose target `greeting` runs `greet`, a tool `tool/`'s own install brings, and writes its output;
 * `check` reads that output. Both read `tool/`'s lockfile, as a target that reads an install's `node_modules` does.
 */
export const packageWithTool = `import { Smithers as S } from "@smthrs/targets"
const install = [S.file("tool/package.json"), S.file("tool/package-lock.json")]
const greeting = S.Shell.Build({
  shell: "mkdir -p out && tool/node_modules/.bin/greet > out/greeting",
  data: [...install, S.file("greet.txt")],
  outDirs: ["out"],
  sandbox: "none",
  timeout: "1m"
})
const check = S.Shell.Test({
  shell: "grep -q hello out/greeting",
  data: [greeting, ...install],
  sandbox: "none",
  timeout: "1m"
})
export const Package = S.Package({ targets: { greeting, check } })
`

/** The files of a repository whose targets need a tool that a sub-package's install brings. */
export const toolFiles = (command: string = smthrs): Readonly<Record<string, string>> => {
  const { ".github/workflows/ci.yml": _workflow, "a.sh": _a, "b.sh": _b, "c.sh": _c, "docs.sh": _docs, ...rest } =
    ownFiles(command)
  return {
    ...rest,
    ".gitignore": "node_modules\n.flows\nout\n",
    "PACKAGE.ts": packageWithTool,
    "greet.txt": "hello\n",
    "tool/package.json": JSON.stringify({
      name: "tool",
      private: true,
      scripts: { postinstall: "node tools/install.mjs" }
    }),
    "tool/package-lock.json": JSON.stringify({
      name: "tool",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "tool" } }
    }),
    "tool/tools/install.mjs": toolInstall
  }
}
