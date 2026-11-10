import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, expect, it } from "vitest"
import * as DocsCheckRule from "../src/internal/rules/DocsCheckRule.vibe"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { serve } from "./helpers/ServeCli.ts"

const ignore = { frontmatterKeys: ["verified"], sections: ["Log"] }
const text =
  "---\nowner: Will\nverified: yesterday\n---\n# Guide\nKeep this promise.\n## Log\nVerified yesterday.\n## Contract\nKeep this too.\n"

const dirs: Array<string> = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => Fs.rm(dir, { recursive: true, force: true })))
})

it("checks authored docs and local external evidence through the CLI", async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "authored-docs-")))
  dirs.push(root)
  const write = (path: string, value: string) => Fs.writeFile(Path.join(root, path), value)
  await write("package.json", "{\"name\":\"authored-docs\",\"private\":true}\n")
  await write("yarn.lock", "")
  await write(
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("authored", {
 repository: "git+https://example.invalid/authored.git", cache: S.Cache({ directory: ".flows" }),
 runtime: S.Runtime.Node({ version: "26" }),
 packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
 nodeModules: S.Npm.NodeModules({ packageJson: manifest })
})`
  )
  const packageModule = `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({targets: { fresh: S.Docs.Check({
 stamp: S.file("stamp.json"), output: S.file("guide.md"), inputs: [S.file("policy.md")],
 authored: true, producer: "Will", ignore: ${JSON.stringify(ignore)},
 evidence: [{file: S.file("evidence.json"), dependency: "live:service", ttlMs: 60000}]
})}})`
  await write("PACKAGE.ts", packageModule)
  await write("guide.md", text)
  await write("policy.md", "policy-v1")
  const record = (digest: string, observedAt = Date.now(), dependency = "live:service") =>
    JSON.stringify({ format: 1, dependency, digest, observedAt })
  const run = (args: Array<string>) => serve(root, args)
  const check = () => run(["docs", "//:fresh"])
  const stamp = () => run(["docs", "//:fresh", "--write"])
  const expectUnknown = async () => {
    const result = await check()
    expect(result.exitCode, result.logs).toBe(1)
    expect(result.logs).toContain("unknown:")
    const refused = await stamp()
    expect(refused.exitCode, refused.logs).toBe(1)
    expect(refused.logs).toContain("unknown:")
  }
  await expectUnknown()
  await write("evidence.json", record("external-v1"))
  const stamped = await stamp()
  expect(stamped.exitCode, stamped.logs).toBe(0)
  const original = await Fs.readFile(Path.join(root, "stamp.json"), "utf8")
  const fresh = await check()
  expect(fresh.exitCode, fresh.logs).toBe(0)
  await write("guide.md", text.replaceAll("yesterday", "today"))
  const verified = await check()
  expect(verified.exitCode, verified.logs).toBe(0)
  await write("evidence.json", record("external-v1", Date.now() - 1000))
  const renewed = await check()
  expect(renewed.exitCode, renewed.logs).toBe(0)
  expect(await Fs.readFile(Path.join(root, "stamp.json"), "utf8")).toBe(original)
  await write("guide.md", text.replace("Keep this promise", "Change this promise"))
  const modified = await check()
  expect(modified.exitCode).toBe(1)
  expect(modified.logs).toContain("modified:")
  expect(modified.logs).toContain("re-verify the doc")
  expect(modified.logs).not.toContain("regenerate")
  await write("guide.md", text)
  await write("evidence.json", record("external-v2"))
  const stale = await check()
  expect(stale.exitCode).toBe(1)
  expect(stale.logs).toContain("stale: ")
  expect(stale.logs).toContain("evidence.json changed")
  for (
    const invalid of [
      record("external-v1", Date.now() - 60000),
      record("external-v1", Date.now() + 60000),
      record("external-v1", Date.now(), "other-dependency"),
      "not json",
      "{}"
    ]
  ) {
    await write("evidence.json", invalid)
    await expectUnknown()
  }
  await Fs.rm(Path.join(root, "evidence.json"))
  await expectUnknown()
  await write("evidence.json", record("external-v1"))

  await Fs.rm(Path.join(root, "guide.md"))
  const absent = await stamp()
  expect(absent.exitCode).toBe(1)
  expect(absent.logs).toContain("re-verify the doc first")
  expect(absent.logs).not.toContain("regenerate")
  await write("guide.md", text)
  await write("stamp.json", "invalid stamp")
  const missingStamp = await check()
  expect(missingStamp.exitCode).toBe(1)
  expect(missingStamp.logs).toContain("re-verify the doc")

  // The actual planner's closure must include every observed dependency, even
  // if a corrupted execution request loses one of its rows.
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  const plan = await PackageExec.plan({ index, cacheDirectory: ".flows", verb: "docs", patterns: ["//:fresh"] })
  const writePlan = await PackageExec.plan({
    index,
    cacheDirectory: ".flows",
    verb: "docs",
    patterns: ["//:fresh"],
    write: true
  })
  const node = plan.nodes.get("//:fresh")!
  const writeNode = writePlan.nodes.get("//:fresh")!
  if (!DocsCheckRule.accepts(node) || !DocsCheckRule.accepts(writeNode)) throw new Error("expected docs-check nodes")
  await expect(DocsCheckRule.contract.execute({ ...node, lane: { ...node.lane, files: [] } }, {
    root,
    signal: undefined
  })).rejects.toThrow(/not included in the planned closure/)

  await Fs.rm(Path.join(root, "stamp.json"))
  await Fs.mkdir(Path.join(root, "stamp.json"))
  // A real filesystem failure after planning must propagate from the executor.
  await expect(DocsCheckRule.contract.execute(node, { root, signal: undefined }))
    .rejects.toThrow("Docs.Check could not read stamp.json")
  await expect(DocsCheckRule.contract.execute(writeNode, { root, signal: undefined }))
    .rejects.toThrow("Docs.Check could not write stamp.json")
  await Fs.rmdir(Path.join(root, "stamp.json"))

  for (
    const [inputs, message] of [
      ["S.file(\"//guide.md\")", "inputs must not include the page"],
      ["S.file(\"//stamp.json\")", "inputs must not include the stamp"],
      [
        "S.Shell.Build({ shell: \"false\", outFiles: [\"unused.txt\"] })",
        "inputs must be files, globs, or Filegroup targets"
      ]
    ]
  ) {
    await write("PACKAGE.ts", packageModule.replace("S.file(\"policy.md\")", inputs!))
    const refused = await stamp()
    expect(refused.exitCode, refused.logs).toBe(1)
    expect(refused.logs + refused.output).toContain(message)
  }
  await write(
    "PACKAGE.ts",
    packageModule.replace(
      "evidence: [",
      "evidence: [{file: S.file(\"//evidence.json\"), dependency: \"live:service\", ttlMs: 60000}, "
    )
  )
  const duplicate = await stamp()
  expect(duplicate.exitCode, duplicate.logs).toBe(1)
  expect(duplicate.logs + duplicate.output).toContain("evidence files must be distinct")
})
