/** Artifact lifecycle through real workspace loading, planning and execution. */
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv, openPackageIndex } from "../src/Cli.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const factory = (policy?: { blocking: boolean; run: "ci" | "never" }) =>
  `import { Smithers as S } from "@smthrs/targets"
export const factory = S.Factory({ summary: "Lifecycle fixture", ${
    policy === undefined ?
      "" :
      `lifecycle: S.Lifecycle.Policy({ tests: { artifact: ${JSON.stringify(policy)} } }),`
  } })\n`

const fixture = async (policy?: { blocking: boolean; run: "ci" | "never" }) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-lifecycle-")))
  roots.push(root)
  await write(
    root,
    ".smithers/WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})\n`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const good = S.Shell.Test({ shell: "true" })
const stale = S.Shell.Test({ shell: "false", lifecycle: "artifact", summary: "Captured failure on 2026-10-17" })
export const Package = S.Package({ targets: { good, stale } })\n`
  )
  await write(root, ".smithers/FACTORY.ts", factory(policy))
  await write(root, "package.json", "{\"name\":\"fixture\",\"private\":true}\n")
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  ChildProcess.execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  return root
}

const serve = async (root: string, args: ReadonlyArray<string>) => {
  let stderr = ""
  let stdout = ""
  let exitCode = 0
  await makeCli({
    environment: { ...process.env, SMITHERS_AUDIENCE: "agent", NO_COLOR: "1", CI: undefined },
    stdout: {
      write: (text) => {
        stdout += text
      },
      isTTY: false,
      columns: 100
    },
    stderr: {
      write: (text) => {
        stderr += text
      },
      isTTY: false,
      columns: 100
    }
  }).serve([...normalizeArgv(args), "--workspace", root], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      stdout += text
    }
  })
  return { exitCode, stderr, stdout }
}

describe("artifact lifecycle", () => {
  it("reports artifact failures without blocking, and adds no default policy", async () => {
    const root = await fixture({ blocking: false, run: "ci" })
    const served = await serve(root, ["test", "//...", "--results-file", "results.json"])
    expect(served.exitCode, served.stdout + served.stderr).toBe(0)
    const results = JSON.parse(await Fs.readFile(Path.join(root, "results.json"), "utf8"))
    expect(results.results).toContainEqual(expect.objectContaining({
      label: "//:stale",
      status: "failed",
      blocking: false,
      failureDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    }))
    expect(served.stderr).toContain("advisory red (artifact lifecycle): //:stale")
    await write(root, ".smithers/FACTORY.ts", factory())
    expect((await serve(root, ["test", "//...", "--results-file", "without-policy.json"])).exitCode).toBe(1)
  })
})

it("omits never-run artifacts from wildcards while retaining explicit labels", async () => {
  const root = await fixture({ blocking: false, run: "never" })
  const wildcard = await serve(root, ["test", "//...", "--plan"])
  expect(wildcard.exitCode, wildcard.stdout).toBe(0)
  expect(wildcard.stdout).toContain("//:good")
  expect(wildcard.stdout).not.toContain("//:stale")
  const explicit = await serve(root, ["test", "//:stale", "--results-file", "explicit.json"])
  expect(explicit.exitCode, explicit.stdout).toBe(0)
  expect(JSON.parse(await Fs.readFile(Path.join(root, "explicit.json"), "utf8")).results)
    .toContainEqual(expect.objectContaining({ label: "//:stale", status: "failed", blocking: false }))
})

it("filters test, ci and affected roots by lifecycle", async () => {
  const root = await fixture({ blocking: false, run: "ci" })
  for (const command of [["test", "//..."], ["ci", "//..."], ["affected", "ci", "//...", "--files", "PACKAGE.ts"]]) {
    const artifact = await serve(root, [...command, "--plan", "--lifecycle", "artifact"])
    expect(artifact.exitCode, artifact.stdout).toBe(0)
    expect(artifact.stdout).toContain("//:stale")
    expect(artifact.stdout).not.toContain("//:good")
    const evergreen = await serve(root, [...command, "--plan", "--lifecycle", "evergreen"])
    expect(evergreen.exitCode, evergreen.stdout).toBe(0)
    expect(evergreen.stdout).toContain("//:good")
    expect(evergreen.stdout).not.toContain("//:stale")
  }
})

it("shows lifecycle in index and the generated projections, with stable ordinary rows", async () => {
  const policy = { blocking: false, run: "ci" as const }
  const root = await fixture(policy)
  await write(
    root,
    ".smithers/flows/captured/flow.mdx",
    "---\ndescription: Captured fixture flow.\ncapabilities: []\n---\n\n# Captured\n"
  )
  const source = await Fs.readFile(Path.join(root, "PACKAGE.ts"), "utf8")
  await write(
    root,
    "PACKAGE.ts",
    source.slice(0, source.indexOf("export const Package")) +
      `export const Package = S.Package({ targets: { good, stale, targetIndex: S.TargetIndex({}), factoryProjection: S.FactoryProjection({ entries: [S.file(".smithers/flows/captured/flow.mdx")] }) } })\n`
  )
  const indexed = await serve(root, ["index", "//..."])
  expect(indexed.exitCode, indexed.stdout).toBe(0)
  expect(indexed.stdout).toContain("artifact")
  for (const label of ["targetIndex", "factoryProjection"]) {
    const generated = await serve(root, ["target", `//:${label}`, "--write"])
    expect(generated.exitCode, generated.stdout + generated.stderr).toBe(0)
    const checked = await serve(root, ["lint", `//:${label}`])
    expect(checked.exitCode, checked.stdout + checked.stderr).toBe(0)
  }
  const rows = JSON.parse(await Fs.readFile(Path.join(root, ".smithers/target-index.json"), "utf8"))
  expect(rows.find((row: { label: string }) => row.label === "//:stale")).toHaveProperty("lifecycle", "artifact")
  expect(rows.find((row: { label: string }) => row.label === "//:good")).not.toHaveProperty("lifecycle")
  expect(JSON.parse(await Fs.readFile(Path.join(root, ".smithers/factory.json"), "utf8"))).toHaveProperty(
    "lifecycle",
    { tests: { artifact: policy } }
  )
})

it("refuses artifacts without summaries and artifact known-red entries", async () => {
  const root = await fixture({ blocking: false, run: "ci" })
  await write(
    root,
    "known-red.json",
    JSON.stringify({
      entries: [{
        label: "//:stale",
        owner: "fixture",
        reason: "captured failure",
        issue: "#1",
        expires: "2999-01-01",
        failureDigest: `sha256:${"a".repeat(64)}`
      }]
    })
  )
  const refused = await serve(root, ["test", "//:good", "--known-red", "known-red.json"])
  expect(refused.exitCode).toBe(1)
  expect(refused.stdout).toContain("artifact tests never block")
  expect(refused.stdout).toContain("need no known-red entry")
  const source = await Fs.readFile(Path.join(root, "PACKAGE.ts"), "utf8")
  await write(root, "PACKAGE.ts", source.replace(", summary: \"Captured failure on 2026-10-17\"", ""))
  const invalid = await serve(root, ["test", "//...", "--plan"])
  expect(invalid.exitCode).toBe(1)
  expect(invalid.stdout).toContain("requires a summary")
})

it("warns through the real doctor command when artifacts lack a policy", async () => {
  const root = await fixture()
  const served = ChildProcess.spawnSync(process.execPath, [
    fileURLToPath(new URL("../../../bin/smithers.mjs", import.meta.url)),
    "doctor",
    "--root",
    root,
    "--json"
  ], { encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: root, SMITHERS_REMOTE: undefined } })
  expect(served.error).toBeUndefined()
  const stdout = served.stdout
  expect(stdout, served.stderr).toContain("artifact targets declared without a lifecycle policy")
  expect(stdout).toContain("\"warn\"")
})

it("keeps blocking artifacts and unrelated evergreen failures red", async () => {
  const root = await fixture({ blocking: true, run: "ci" })
  expect((await serve(root, ["test", "//..."])).exitCode).toBe(1)
  await write(root, ".smithers/FACTORY.ts", factory({ blocking: false, run: "ci" }))
  const source = await Fs.readFile(Path.join(root, "PACKAGE.ts"), "utf8")
  await write(root, "PACKAGE.ts", source.replace("shell: \"true\"", "shell: \"false\""))
  for (const command of [["test", "//..."], ["ci", "//..."], ["affected", "ci", "//...", "--files", "PACKAGE.ts"]]) {
    expect((await serve(root, command)).exitCode).toBe(1)
  }
})

it("keeps artifact failures advisory through ci and affected", async () => {
  const root = await fixture({ blocking: false, run: "ci" })
  for (const command of [["ci", "//..."], ["affected", "ci", "//...", "--files", "PACKAGE.ts"]]) {
    const served = await serve(root, command)
    expect(served.exitCode, served.stdout + served.stderr).toBe(0)
    expect(served.stderr).toContain("advisory red (artifact lifecycle): //:stale")
  }
})

it("filters docs roots with artifact and all", async () => {
  const root = await fixture({ blocking: false, run: "ci" })
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const good = S.DocsParity({ deps: [], readme: S.file("README.md") })
const stale = S.DocsParity({ deps: [], readme: S.file("README.md"), lifecycle: "artifact", summary: "Captured docs check" })
export const Package = S.Package({ targets: { good, stale } })\n`
  )
  await write(root, "README.md", "# Fixture\nCaptured prose.\n")
  const all = await serve(root, ["docs", "//...", "--plan", "--lifecycle", "all"])
  expect(all.exitCode, all.stdout).toBe(0)
  expect(all.stdout).toContain("//:good")
  expect(all.stdout).toContain("//:stale")
  const artifact = await serve(root, ["docs", "//...", "--plan", "--lifecycle", "artifact"])
  expect(artifact.exitCode, artifact.stdout).toBe(0)
  expect(artifact.stdout).not.toContain("//:good")
  expect(artifact.stdout).toContain("//:stale")
})

it("does not key execution on lifecycle metadata", async () => {
  const root = await fixture({ blocking: false, run: "ci" })
  const key = async () => {
    const index = await openPackageIndex({ workspace: root })
    const planned = await PackageExec.plan({ index, verb: "test", patterns: ["//:stale"], cacheDirectory: ".flows" })
    return planned.nodes.get("//:stale")!.keyPreview
  }
  const artifactKey = await key()
  const source = await Fs.readFile(Path.join(root, "PACKAGE.ts"), "utf8")
  await write(root, "PACKAGE.ts", source.replace("lifecycle: \"artifact\"", "lifecycle: \"evergreen\""))
  expect(await key()).toBe(artifactKey)
})
