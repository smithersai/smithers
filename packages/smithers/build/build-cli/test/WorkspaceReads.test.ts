/**
 * A stored test result is never a stale pass, through the real program: a
 * change to a source of a workspace package the suite reaches reruns it, a
 * change to the lockfile reruns it, and a change to a docs page reruns only
 * what reads docs. The workspace turns build confinement off, as this
 * repository does, so each result is stored from one confined attempt.
 */
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as NodeChildProcess from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const provable = ExecSandbox.enforceable(
  { policy: undefined, reads: [], writes: [], scratch: true },
  ExecSandbox.host()
)
const main = Path.resolve(import.meta.dirname, "../src/main.js")
const created: Array<string> = []
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => Fs.rm(path, { recursive: true, force: true })))
})

/** The host's bubblewrap directory, so the program finds the mechanism on the fixture's search path. */
const mechanismDirectory = (process.env["PATH"] ?? "").split(Path.delimiter)
  .find((directory) => Path.isAbsolute(directory) && NodeFs.existsSync(Path.join(directory, "bwrap")))

const fixture = async () => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-workspace-reads-")))
  created.push(base)
  const root = Path.join(base, "ws")
  const tools = Path.join(base, "tools")
  const write = async (name: string, text: string, mode = 0o644): Promise<void> => {
    const file = Path.isAbsolute(name) ? name : Path.join(root, name)
    await Fs.mkdir(Path.dirname(file), { recursive: true })
    await Fs.writeFile(file, text, { mode })
    await Fs.chmod(file, mode)
  }
  await write(
    Path.join(tools, "pnpm"),
    "#!/bin/sh\nif [ \"$1\" = exec ]; then shift; tool=\"$1\"; shift; exec \"./node_modules/.bin/$tool\" \"$@\"; fi\n" +
      "printf '11.21.0\\n'\n",
    0o755
  )
  await write(Path.join(tools, "node"), "#!/bin/sh\nprintf '26.4.0\\n'\n", 0o755)
  await write("package.json", "{\"name\":\"fixture\",\"private\":true}\n")
  await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  await write(
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("reads", {
  repository: "git+https://example.invalid/reads.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0", executable: ${JSON.stringify(Path.join(tools, "node"))} }),
  packageManager: S.PackageManager.Pnpm({
    manifest: S.file("//package.json"),
    lockfile: S.file("//pnpm-lock.yaml"),
    version: "11.21.0"
  }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})
`
  )
  // The package the suite reaches, with docs of its own that nothing reads.
  await write("packages/a/package.json", "{\"name\":\"a\"}\n")
  await write("packages/a/src/index.ts", "export const a = 1\n")
  await write("packages/a/docs/guide.md", "# Guide\n")
  await write("packages/a/node_modules/dep/index.js", "export const dep = 1\n")
  await write(
    "packages/a/PACKAGE.ts",
    "import { Smithers as S } from \"@smthrs/targets\"\nexport const Package = S.Package({ targets: {} })\n"
  )
  // The package under test: its suite loads a's source, and its docs are checked on their own.
  await write("packages/b/package.json", "{\"name\":\"b\"}\n")
  await write("packages/b/src/index.ts", "export const b = 1\n")
  await write(
    "packages/b/test/b.test.ts",
    "set -e\ncase \"$(/bin/cat ../a/src/index.ts)\" in *export*) ;; *) exit 1 ;; esac\n" +
      "/bin/cat src/index.ts ../a/node_modules/dep/index.js > /dev/null\n"
  )
  await write("packages/b/node_modules/.bin/vitest", "#!/bin/sh\nset -e\n. ./test/b.test.ts\n", 0o755)
  await write(
    "packages/b/README.md",
    "# b\n\nThis package explains itself in enough plain prose for the documentation check to accept it.\n"
  )
  await write(
    "packages/b/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const cwd = "packages/b"
const reached = S.Filegroup({ srcs: [S.glob("src/**"), S.file("package.json")], cwd: "packages/a" })
const test = S.Vitest({
  tests: [S.file("test/b.test.ts")],
  sources: [S.glob("src/**")],
  deps: [reached],
  config: null,
  environment: "node",
  passWithNoTests: false,
  cwd
})
const docs = S.DocsParity({ readme: S.file("README.md"), deps: [], minimumProseCharacters: 20, cwd })
export const Package = S.Package({ targets: { reached, test, docs } })
`
  )
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "ignore" })
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  /** One run of the real program over b's suite and docs; answers each one's status. */
  const run = (stored = true): Record<string, string> => {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [main, "ci", "//packages/b:test", "//packages/b:docs", "--workspace", root, "--jobs", "1", "--ui", "plain"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: [tools, ...(mechanismDirectory === undefined ? [] : [mechanismDirectory]), "/usr/bin", "/bin"]
            .join(Path.delimiter)
        },
        timeout: 240_000
      }
    )
    const output = `${result.stdout}${result.stderr}`
    expect(result.status, output).toBe(0)
    // The report names each result the run did not store, with the reason.
    if (stored) expect(output).not.toContain("notStored")
    else expect(output).toContain("notStored: \"it passed, but failed when confined to its declared inputs\"")
    const statuses: Record<string, string> = {}
    // The report is a table when every row has the same fields, and a list of rows otherwise.
    const rows = [
      ...output.matchAll(/"\/\/packages\/b:(test|docs)",[\w.]+,(ran|hit|failed)/g),
      ...output.matchAll(/label: "\/\/packages\/b:(test|docs)"\n(?:\s+\w+: [^\n]*\n)*?\s+status: (ran|hit|failed)/g)
    ]
    for (const match of rows) statuses[match[1]!] = match[2]!
    return statuses
  }
  return { write, run, root }
}

describe.skipIf(!provable)("a stored result over the workspace packages a suite reaches", () => {
  it("reruns the suite on a reached source or the lockfile, and only the docs check on a docs page", async () => {
    const { write, run } = await fixture()
    expect(run()).toEqual({ test: "ran", docs: "ran" })
    expect(run()).toEqual({ test: "hit", docs: "hit" })
    await write("packages/a/src/index.ts", "export const a = 2\n")
    expect(run()).toEqual({ test: "ran", docs: "hit" })
    await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n# relocked\n")
    expect(run().test).toBe("ran")
    expect(run()).toEqual({ test: "hit", docs: "hit" })
    await write(
      "packages/b/README.md",
      "# b\n\nThis package explains itself, in different plain prose, for the documentation check.\n"
    )
    expect(run()).toEqual({ test: "hit", docs: "ran" })
    // A package's docs that nothing declares change nothing.
    await write("packages/a/docs/guide.md", "# Guide, revised\n")
    expect(run()).toEqual({ test: "hit", docs: "hit" })
    // A dependency installed for the reached package, patched in place under the same lockfile.
    await write("packages/a/node_modules/dep/index.js", "export const dep = 2\n")
    expect(run()).toEqual({ test: "ran", docs: "hit" })
  }, 900_000)

  it("tries a failed confined run again once a file group it reads declares more", async () => {
    const { write, run, root } = await fixture()
    // The suite also reads a file of a that its group does not declare: the confined run fails, the open one passes.
    await write("packages/a/extra.txt", "extra\n")
    await write(
      "packages/b/test/b.test.ts",
      "set -e\n/bin/cat ../a/src/index.ts ../a/extra.txt > /dev/null\n"
    )
    expect(run(false).test).toBe("ran")
    // The same declaration is not tried confined again.
    expect(run(false).test).toBe("ran")
    const declaration = Path.join(root, "packages/b/PACKAGE.ts")
    const text = await Fs.readFile(declaration, "utf8")
    await write(
      "packages/b/PACKAGE.ts",
      text.replace("S.file(\"package.json\")]", "S.file(\"package.json\"), S.file(\"extra.txt\")]")
    )
    expect(run()).toEqual({ test: "ran", docs: "hit" })
    expect(run()).toEqual({ test: "hit", docs: "hit" })
  }, 900_000)
})
