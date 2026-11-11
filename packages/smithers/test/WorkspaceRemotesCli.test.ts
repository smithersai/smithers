import { temporaryEnvironment } from "./temporaryEnvironment.ts"
/**
 * A module flow started by `smthrs flow start` reaches the machines the
 * workspace's `S.Remotes` declares, through `Remotes.Remotes`, and only the
 * ones its capabilities name.
 *
 * The remote is `S.Remote.Command` with an empty prefix: this machine, reached
 * the way an `ssh` prefix reaches another, through the host's own spawner. Its
 * guest directory is outside the project, and the session's command writes
 * the host's `HOME` there: a confined action command could do neither.
 */
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const execute = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const modules = fileURLToPath(new URL("../node_modules", import.meta.url))

describe("Remotes on the durable host", () => {
  let root: string
  let machines: string
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "smithers-remotes-cli-")))
    machines = await realpath(await mkdtemp(join(tmpdir(), "smithers-remotes-machine-")))
    await mkdir(join(root, ".smithers", "flows", "reach"), { recursive: true })
    await symlink(modules, join(root, "node_modules"), "dir")
    await writeFile(
      join(root, ".smithers", "WORKSPACE.ts"),
      `
import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("remotes", {
  repository: "git+https://example.invalid/remotes.git",
  cache: S.Cache({ directory: ".flows" }),
  remotes: S.Remotes({ here: S.Remote.Command({ machines: [[]], workdir: ${JSON.stringify(machines)} }) })
})
`
    )
    await writeFile(
      join(root, ".smithers", "flows", "reach", "flow.ts"),
      `
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Remotes } from "@smthrs/sandbox"
import { Effect, Schema, Stream } from "effect"
const Reach = Action.make("reach/Run", {
  implementationVersion: "reach/v1", payload: { remote: Schema.String }, success: Schema.String, error: Schema.String
})
export const layer = Reach.toLayer(({ remote }) => Effect.scoped(Effect.gen(function*() {
  const remotes = yield* Remotes.Remotes
  const session = yield* remotes.acquire(remote, "reach run")
  const process = yield* session.spawn('printf "%s" "$HOME" > home.txt; pwd', { cwd: session.workdir })
  const [out] = yield* Effect.all([Stream.mkString(Stream.decodeText(process.stdout)), process.exitCode])
  return out
})).pipe(Effect.mapError((error) => "capability" in error
  ? \`refused \${error.capability.action}:\${error.capability.resource}\`
  : \`\${error._tag}: \${error.message}\`)),
  { implementationVersion: "reach/v1" })
export default Flow.make("reach", {
  description: "Run one command on a declared remote", capabilities: ["remote:acquire:here", "remote:acquire:nowhere"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { remote: Schema.String }, success: Schema.String, error: Schema.String,
  body: Node.capture({ action: Reach.name, implementationVersion: "reach/v1" }, ({ remote }) => Reach.call({ remote }))
})
`
    )
  }, 30_000)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(machines, { recursive: true, force: true })
  })

  const start = (remote: string) =>
    execute(process.execPath, [
      "--no-warnings",
      "--import",
      preload,
      bin,
      "flow",
      "start",
      "reach",
      "--data",
      JSON.stringify({ remote }),
      "--wait",
      "--root",
      root,
      "--json"
    ], {
      cwd: root,
      env: {
        PATH: process.env["PATH"],
        ...temporaryEnvironment(),
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"],
        SMITHERS_FFI_LIBRARY_PATH: process.env["SMITHERS_FFI_LIBRARY_PATH"],
        SMITHERS_BACKEND: "sqlite"
      },
      timeout: 120_000
    }).then(
      (result) => ({ output: result.stdout + result.stderr, code: 0 }),
      (error) => ({ output: `${error.stdout}${error.stderr}`, code: error.code as number })
    )

  it("runs a command on a declared remote it may acquire, outside the action's confinement", async () => {
    const { code, output } = await start("here")
    expect(code, output).toBe(0)
    const [directory] = await readdir(machines)
    expect(directory).toMatch(/^reach-run-[0-9a-f]{12}$/)
    // The session's command wrote its HOME, the host's, in its own directory.
    expect(await readFile(join(machines, directory!, "home.txt"), "utf8")).toBe(join(root, "home"))
  }, 150_000)

  it("refuses a remote the flow's capabilities do not name before anything reaches it", async () => {
    const before = await readdir(machines)
    const { code, output } = await start("elsewhere")
    expect(code, output).not.toBe(0)
    expect(output).toContain("refused remote:acquire:elsewhere")
    expect(await readdir(machines)).toEqual(before)
  }, 150_000)

  it("names the declared remotes when the flow asks for one the workspace does not declare", async () => {
    const { code, output } = await start("nowhere")
    expect(code, output).not.toBe(0)
    expect(output).toContain(`the workspace declares no remote \\"nowhere\\"; it declares here`)
  }, 150_000)
})
