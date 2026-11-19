/**
 * A confined run with more declared files than bubblewrap accepts, through the
 * real program: it runs, it sees only what it declares, and the directory that
 * held its files is gone when it ends, however it ends.
 */
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it } from "vitest"

const confinable = ExecSandbox.enforceable({ policy: undefined, reads: [], writes: [] }, ExecSandbox.host()) &&
  ExecSandbox.host().platform === "linux"

const main = Path.resolve(import.meta.dirname, "../src/main.js")
const created: Array<string> = []
const children: Array<NodeChildProcess.ChildProcess> = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  await Promise.all(created.splice(0).map((path) => Fs.rm(path, { recursive: true, force: true })))
})

/** A workspace whose one target declares 3,100 files and runs `shell`, and an empty temporary directory for it. */
const fixture = async (shell: string) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-staged-")))
  created.push(base)
  const root = Path.join(base, "ws")
  const temporary = Path.join(base, "tmp")
  await Fs.mkdir(Path.join(root, "many"), { recursive: true })
  await Fs.mkdir(temporary)
  for (let start = 0; start < 3_100; start += 200) {
    await Promise.all(
      Array.from({ length: 200 }, (_, offset) => start + offset)
        .filter((index) => index < 3_100)
        .map((index) => Fs.writeFile(Path.join(root, "many", `f${index}.txt`), `${index}\n`))
    )
  }
  await Fs.writeFile(Path.join(root, "undeclared.txt"), "hidden\n")
  await Fs.writeFile(Path.join(root, "package.json"), "{\"name\":\"fixture\",\"private\":true}\n")
  await Fs.writeFile(Path.join(root, "yarn.lock"), "# yarn lockfile v1\n")
  await Fs.writeFile(
    Path.join(root, "WORKSPACE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`
  )
  await Fs.writeFile(
    Path.join(root, "PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
const probe = S.Shell.Test({ shell: ${JSON.stringify(shell)}, data: [S.glob("many/**")] })
export const Package = S.Package({ targets: { probe } })
`
  )
  const start = () => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [main, "ci", "//:probe", "--workspace", root, "--jobs", "1", "--ui", "plain"],
      { cwd: root, env: { ...process.env, TMPDIR: temporary }, stdio: ["ignore", "pipe", "pipe"] }
    )
    children.push(child)
    let output = ""
    child.stdout.on("data", (chunk) => output += chunk)
    child.stderr.on("data", (chunk) => output += chunk)
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve))
    return { child, exited, output: () => output }
  }
  /** What is left in the run's temporary directory that a stage made. */
  const stages = async () => (await Fs.readdir(temporary)).filter((name) => name.startsWith("smthrs-stage-"))
  return { start, stages, temporary }
}

const until = async (condition: () => Promise<boolean>, what: string): Promise<void> => {
  for (let waited = 0; waited < 180_000; waited += 100) {
    if (await condition()) return
    await delay(100)
  }
  throw new Error(`timed out waiting until ${what}`)
}

describe.skipIf(!confinable)("a confined run over bubblewrap's argument limit", () => {
  it("runs, reads what it declares, misses what it does not, and leaves nothing behind", async () => {
    const { start, stages } = await fixture(
      "test -f many/f0.txt && test -f many/f3099.txt && test ! -e undeclared.txt && ! echo x >> many/f0.txt"
    )
    const run = start()
    expect(await run.exited, run.output()).toBe(0)
    expect(await stages()).toEqual([])
  }, 300_000)

  it("leaves nothing behind when the program is killed while the run is going", async () => {
    const { start, stages, temporary } = await fixture("exec /bin/sleep 600")
    const run = start()
    await until(async () => {
      const [stage] = await stages()
      if (stage === undefined) return false
      return Fs.access(Path.join(temporary, stage, "workspace", "many", "f3099.txt")).then(() => true, () => false)
    }, "the run's files are in place")
    run.child.kill("SIGKILL")
    await run.exited
    await until(async () => (await stages()).length === 0, "the directory is gone")
  }, 300_000)
})
