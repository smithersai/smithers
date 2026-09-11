/**
 * `Docs.Page` through the real CLI: the `docs` verb selects a page writer,
 * `run` refuses it, the aggregate `ci` skips it without a spawn, and the
 * page executes through the existing Agent.Diff lane with the scripted fake
 * selected by `SMTHRS_AGENT_FAKE`.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { serve as serveCli } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const exists = async (path: string): Promise<boolean> => Fs.access(path).then(() => true, () => false)

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  agents: S.Agents({ default: S.Agent.Codex({ model: "luna" }) }),
})
`

/**
 * The fixture package. The `rendered` gate reads the page the writer lands, so
 * it declares that file: the sandbox binds a target's declared reads and
 * nothing else, and an undeclared path is denied under seatbelt and absent
 * under bubblewrap. The gate reads the file's contents rather than stating its
 * path for the same reason. Seatbelt allows metadata anywhere under the
 * workspace, so a `test -f` gate passes on macOS and fails on Linux CI.
 */
const packageModule = `import { Smithers as S } from "@smthrs/targets"
const references = S.Filegroup({ srcs: S.glob(["references/**"]) })
const unit = S.Shell.Test({ shell: "true" })
const rendered = S.Shell.Test({ shell: "grep -q flow docs/flow.md", data: [S.file("//docs/flow.md")] })
const page = S.Docs.Page({
  brief: S.file("//pages/flow/brief.md"),
  prompt: S.file("//prompts/reference.md"),
  references: [S.file("//prompts/style.md"), references],
  inputs: [S.glob("//src/**/*.ts")],
  output: "docs/flow.md",
  gates: [rendered],
  maxRounds: 2,
})
export const Package = S.Package({ targets: { references, unit, rendered, page } })
`

const git = (root: string, ...args: ReadonlyArray<string>): void => {
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })
}

interface Response {
  readonly purpose?: "diff"
  readonly edits?: ReadonlyArray<{ path: string; contents: string | null }>
}

const script = async (root: string, responses: ReadonlyArray<Response>): Promise<string> => {
  await write(root, "fake.json", JSON.stringify({ identity: "fake", responses }))
  const logPath = NodePath.join(root, "fake.json.spawns.jsonl")
  await Fs.rm(logPath, { force: true })
  return logPath
}

const spawnRecords = async (logPath: string): Promise<ReadonlyArray<{ files: ReadonlyArray<string> }>> => {
  try {
    return (await Fs.readFile(logPath, "utf8")).split("\n").filter((line) => line !== "").map((line) =>
      JSON.parse(line) as { files: ReadonlyArray<string> }
    )
  } catch {
    return []
  }
}

/** Serves one command with the fake agent selected. */
const serve = (root: string, args: ReadonlyArray<string>) =>
  serveCli(root, args, { environment: { ...process.env, SMTHRS_AGENT_FAKE: "fake.json" } })

const siteWorkspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docs-page-")))
  temporaryDirectories.push(root)
  await write(root, "WORKSPACE.ts", workspaceModule)
  await write(root, "PACKAGE.ts", packageModule)
  await write(root, "package.json", "{\"name\":\"fixture\",\"private\":true}\n")
  await write(root, "yarn.lock", "")
  await write(root, "pages/flow/brief.md", "The public surface of the flow package.\n")
  await write(root, "prompts/reference.md", "Write a reference page.\n")
  await write(root, "prompts/style.md", "Concrete nouns, active voice.\n")
  await write(root, "references/diataxis.md", "Reference pages describe.\n")
  await write(root, "src/flow.ts", "export const make = () => 1\n")
  git(root, "init", "-q")
  git(root, "config", "user.email", "t@t.t")
  git(root, "config", "user.name", "t")
  git(root, "config", "commit.gpgsign", "false")
  git(root, "add", "-A")
  git(root, "commit", "-qm", "init")
  return root
}

describe("Docs.Page verbs", () => {
  it("is selected by docs, refused by run, and skipped by ci", async () => {
    const root = await siteWorkspace()
    await script(root, [])

    const exact = await serve(root, ["docs", "//:page", "--plan"])
    expect(exact.exitCode).toBe(0)
    expect(exact.output).toContain("//:page")

    const wildcard = await serve(root, ["docs", "//...", "--plan"])
    expect(wildcard.exitCode).toBe(0)
    expect(wildcard.output).toContain("//:page")

    // An exact label under a verb the rule does not participate in is the
    // ordinary unsupported-verb refusal, not a silent no-op.
    const run = await serve(root, ["run", "//:page", "--plan"])
    expect(run.exitCode).toBe(1)
    expect(run.output).toContain("does not support the run verb")

    // `ci` aggregates `docs`, and still never plans the page: CI never spawns
    // an agent. The rest of the package is planned as usual.
    const ci = await serve(root, ["ci", "//...", "--plan"])
    expect(ci.exitCode).toBe(0)
    expect(ci.output).toContain("//:unit")
    expect(ci.output).not.toContain("//:page")
  }, 120_000)

  it("executes ci over the package without a session spawn", async () => {
    const root = await siteWorkspace()
    // The committed page is what CI sees; its gate runs as an ordinary test.
    await write(root, "docs/flow.md", "# flow (committed)\n")
    // An exhausted script fails any session run, so a green ci proves no spawn.
    const logPath = await script(root, [])
    const ci = await serve(root, ["ci", "//..."])
    expect(ci.exitCode, ci.logs).toBe(0)
    expect(ci.logs).toContain("//:unit")
    expect(ci.logs).toContain("//:rendered")
    expect(ci.logs).not.toContain("//:page")
    expect(await spawnRecords(logPath)).toEqual([])
    expect(await Fs.readFile(NodePath.join(root, "docs/flow.md"), "utf8")).toBe("# flow (committed)\n")
  }, 120_000)
})

describe("Docs.Page execution", () => {
  it("writes the one output through the Agent.Diff lane and rejects any other path", async () => {
    const root = await siteWorkspace()

    // Round 1 proposes nothing: the gate is red. Round 2 lands the page.
    const logPath = await script(root, [
      { purpose: "diff", edits: [] },
      { purpose: "diff", edits: [{ path: "docs/flow.md", contents: "# flow\n" }] }
    ])
    const written = await serve(root, ["docs", "//:page"])
    expect(written.exitCode).toBe(0)
    expect(written.logs).toContain("//:page  round 1: gate //:rendered red")
    expect(written.logs).toContain("//:page  round 2: gate //:rendered green")
    expect(written.logs).toContain("//:page  candidate accepted after 2 round(s); applied 1 file(s)")
    expect(await Fs.readFile(NodePath.join(root, "docs/flow.md"), "utf8")).toBe("# flow\n")
    const records = await spawnRecords(logPath)
    expect(records).toHaveLength(2)
    // The writer saw the brief, the references, and the inputs, never the prompt.
    expect(records[0]!.files).toEqual([
      "pages/flow/brief.md",
      "prompts/style.md",
      "references/diataxis.md",
      "src/flow.ts"
    ])

    // The output path is the whole write-set.
    await Fs.rm(NodePath.join(root, "docs"), { recursive: true, force: true })
    await write(root, "pages/flow/brief.md", "The public surface of the flow package, second edition.\n")
    await script(root, [{ purpose: "diff", edits: [{ path: "docs/other.md", contents: "# other\n" }] }])
    const escaped = await serve(root, ["docs", "//:page"])
    expect(escaped.exitCode).toBe(1)
    expect(escaped.logs).toContain("outside the declared write-set")
    expect(await exists(NodePath.join(root, "docs/other.md"))).toBe(false)
  }, 120_000)
})
