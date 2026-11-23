import { Smithers as S } from "@smthrs/targets"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const temporaryWorkspace = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-shell-test-out-"))))

describe("Shell.Test outFiles", () => {
  it("rejects shards > 1 combined with outFiles or outDirs", () => {
    expect(() =>
      S.Shell.Test({
        bin: S.Host.bin("node"),
        args: ["-e", "process.exit(0)"],
        shards: 2,
        outFiles: ["report.json"]
      })
    ).toThrow(/shards > 1 cannot declare outDirs or outFiles/)
  })

  it("captures and materializes cached outFiles on Shell.Test cache hits", async () => {
    const root = await temporaryWorkspace()
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["node"] })
})
`
    )
    await write(root, "src/input.txt", "v1\n")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const input = S.Filegroup({ srcs: [S.file("src/input.txt")] })
const bench = S.Shell.Test({
  bin: S.Host.bin("node"),
  args: ["-e", "const fs=require('node:fs'); fs.mkdirSync('results',{recursive:true}); const v=fs.readFileSync('src/input.txt','utf8').trim(); fs.writeFileSync('results/bench.json', JSON.stringify({v})); fs.appendFileSync('runs.log', v + String.fromCharCode(10));"],
  data: [input],
  exclusive: true,
  sandbox: "none",
  outFiles: ["results/bench.json"]
})
export const Package = S.Package({ targets: { input, bench } })
`
    )
    const first = await serve(root, ["test", "//:bench"])
    expect(first.exitCode, `${first.output}\n${first.logs}`).toBe(0)
    expect(JSON.parse(await Fs.readFile(NodePath.join(root, "results/bench.json"), "utf8"))).toEqual({ v: "v1" })
    expect((await Fs.readFile(NodePath.join(root, "runs.log"), "utf8")).trim().split("\n")).toEqual(["v1"])

    // Delete the output file and re-run: cache hit must materialize it without re-running the tool.
    await Fs.rm(NodePath.join(root, "results/bench.json"))
    const second = await serve(root, ["test", "//:bench"])
    expect(second.exitCode).toBe(0)
    expect(JSON.parse(await Fs.readFile(NodePath.join(root, "results/bench.json"), "utf8"))).toEqual({ v: "v1" })
    expect((await Fs.readFile(NodePath.join(root, "runs.log"), "utf8")).trim().split("\n")).toEqual(["v1"])

    // Modifying the declared input invalidates the cache and re-runs the benchmark.
    await write(root, "src/input.txt", "v2\n")
    const third = await serve(root, ["test", "//:bench"])
    expect(third.exitCode).toBe(0)
    expect(JSON.parse(await Fs.readFile(NodePath.join(root, "results/bench.json"), "utf8"))).toEqual({ v: "v2" })
    expect((await Fs.readFile(NodePath.join(root, "runs.log"), "utf8")).trim().split("\n")).toEqual(["v1", "v2"])
  })

  it("replays cached stdout and stderr on Shell.Test cache hits with --verbose", async () => {
    const root = await temporaryWorkspace()
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["node"] })
})
`
    )
    await write(root, "src/input.txt", "42\n")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const input = S.Filegroup({ srcs: [S.file("src/input.txt")] })
const bench = S.Shell.Test({
  bin: S.Host.bin("node"),
  args: ["-e", "const fs=require('node:fs'); const v=fs.readFileSync('src/input.txt','utf8').trim(); console.log('BENCH_METRIC=' + v); console.error('BENCH_DETAIL=' + v);"],
  data: [input],
  sandbox: "none"
})
export const Package = S.Package({ targets: { input, bench } })
`
    )
    const first = await serve(root, ["test", "//:bench", "--verbose"])
    expect(first.exitCode).toBe(0)
    expect(first.logs).toContain("BENCH_METRIC=42")
    expect(first.logs).toContain("BENCH_DETAIL=42")

    // Cache hit must still replay the recorded benchmark output to observers.
    const second = await serve(root, ["test", "//:bench", "--verbose"])
    expect(second.exitCode).toBe(0)
    expect(second.logs).toContain("//:bench  hit")
    expect(second.logs).toContain("BENCH_METRIC=42")
    expect(second.logs).toContain("BENCH_DETAIL=42")
  })

  it("allows Shell.Test bin to target a Shell.Build with one outFiles executable", async () => {
    const root = await temporaryWorkspace()
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["node"] })
})
`
    )
    await write(root, "src/val.txt", "alpha\n")
    await write(
      root,
      "sub/make-tool.mjs",
      `import * as fs from "node:fs"
fs.mkdirSync("dist/bin", { recursive: true })
const v = fs.readFileSync("src/val.txt", "utf8").trim()
const script = [
  "#!/usr/bin/env node",
  'import * as fs from "node:fs"',
  'fs.mkdirSync("out", { recursive: true })',
  'fs.writeFileSync("out/result.json", JSON.stringify({ v: ' + JSON.stringify(v) + ', arg: process.argv[2] }))'
].join("\\n") + "\\n"
fs.writeFileSync("dist/bin/tool.mjs", script)
fs.chmodSync("dist/bin/tool.mjs", 0o755)
`
    )
    await write(
      root,
      "sub/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const src = S.Filegroup({ srcs: [S.file("//src/val.txt"), S.file("make-tool.mjs")] })
const build = S.Shell.Build({
  bin: S.Host.bin("node"),
  args: ["sub/make-tool.mjs"],
  data: [src],
  outFiles: ["//dist/bin/tool.mjs"],
  sandbox: "none"
})
const bench = S.Shell.Test({
  bin: build,
  args: ["ok"],
  exclusive: true,
  sandbox: "none",
  outFiles: ["//out/result.json"]
})
export const Package = S.Package({ targets: { src, build, bench } })
`
    )
    const first = await serve(root, ["test", "//sub:bench"])
    expect(first.exitCode, `${first.output}\n${first.logs}`).toBe(0)
    expect(JSON.parse(await Fs.readFile(NodePath.join(root, "out/result.json"), "utf8"))).toEqual({
      v: "alpha",
      arg: "ok"
    })

    // Deleting both the compiled binary and output must restore cleanly. An unconfined
    // Shell.Build reruns (nothing observes its reads), but it reproduces identical
    // executable bytes, so the dependent benchmark keys alike and replays from cache.
    await Fs.rm(NodePath.join(root, "dist/bin/tool.mjs"))
    await Fs.rm(NodePath.join(root, "out/result.json"))
    const second = await serve(root, ["test", "//sub:bench"])
    expect(second.exitCode, `${second.output}\n${second.logs}`).toBe(0)
    expect(second.logs).toContain("//sub:bench  hit")
    expect(JSON.parse(await Fs.readFile(NodePath.join(root, "out/result.json"), "utf8"))).toEqual({
      v: "alpha",
      arg: "ok"
    })
  })
})
