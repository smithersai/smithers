import { Effect } from "effect"
import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as tar from "tar"
import vibelang from "vibelang-unplugin/esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as LoadSuite from "../src/evaluation/LoadSuite.vibe"

let directory: string
let installed: string
const timestamp = "2026-11-04T00:00:00.000Z"

// Pack the real eval command as a CLI fixture. Its installed dependencies are
// real; projects cannot reach them by walking their own directory ancestors.
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "smithers-evaluation-host-imports-"))
  const stage = join(directory, "stage")
  await mkdir(join(stage, "bin"), { recursive: true })
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({
      name: "@smthrs/cli",
      version: "1.0.0",
      type: "module",
      files: ["bin", "dist"],
      exports: { "./package.json": "./package.json" }
    })
  )
  await build({
    entryPoints: [join(import.meta.dirname, "../src/evaluation/EvalCli.ts")],
    outfile: join(stage, "dist/esm/EvalCli.js"),
    plugins: [vibelang({ root: join(import.meta.dirname, "..") })],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "es2022"
  })
  await writeFile(
    join(stage, "bin/smithers.mjs"),
    `
import { installEffectResolution } from "@smthrs/build-cli/effect-resolution"
installEffectResolution()
const { createEvalCli } = await import("../dist/esm/EvalCli.js")
await createEvalCli().serve(process.argv.slice(2))
`
  )
  const archive = join(directory, "cli.tgz")
  const packed = spawnSync("pnpm", ["pack", "--out", archive], { cwd: stage, encoding: "utf8", timeout: 20_000 })
  expect(packed.status, packed.stderr + packed.stdout).toBe(0)
  const installation = join(directory, "installation")
  await mkdir(installation)
  await tar.x({ file: archive, cwd: installation })
  installed = join(installation, "package")
  await symlink(join(import.meta.dirname, "../node_modules"), join(installed, "node_modules"), "dir")
})

afterAll(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
})

const command = (root: string, args: ReadonlyArray<string>) => {
  const response = spawnSync(process.execPath, [
    "--no-warnings",
    join(installed, "bin/smithers.mjs"),
    ...args,
    "--root",
    root,
    "--json"
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, SMITHERS_REMOTE: "", XDG_CONFIG_HOME: root, XDG_DATA_HOME: root }
  })
  return { code: response.status, output: response.stdout, error: response.stderr }
}

const fixture = async (suffix: string, type: "module" | "commonjs" | undefined) => {
  const root = join(directory, `project-${type}-${suffix}`)
  await mkdir(join(root, "evals"), { recursive: true })
  await writeFile(join(root, "package.json"), JSON.stringify({ type }))
  await expect(access(join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" })
  await writeFile(
    join(root, "evals/helper.mjs"),
    `
import { Effect } from "effect"
import { CaseExecutor, Suite } from "@smthrs/evals"
import { Binding, Scorer } from "@smthrs/scorers"
import { appendFile } from "node:fs/promises"
const target = { name: "original-target" }
const scorer = Scorer.make({ id: "original/exact", version: "1", name: "exact",
  score: () => Effect.succeed({ score: 1 }) })
export const suite = Suite.make({ name: "original/suite", concurrency: 1,
  cases: [{ name: "original-case", input: 7 }], bindings: [Binding.make({ scorer, appliesTo: target })] })
export const executor = CaseExecutor.make((entry) => Effect.promise(async () => {
  await appendFile(new URL("./calls", import.meta.url), "executed\\n")
  return { output: entry.input, stepKey: "original-step", latencyMs: 0, target }
}))
`
  )
  const file = join(root, "evals", `exact.eval.${suffix}`)
  if (suffix === "ts") {
    await writeFile(
      join(root, "evals/typed.ts"),
      "export const value: number = 42; export { suite, executor } from \"./helper.mjs\"\n"
    )
    await writeFile(file, "export { suite, executor } from \"./typed.js\"\n")
  } else {
    await writeFile(file, "export { suite, executor } from \"./helper.mjs\"\n")
  }
  return { root, file }
}

describe("packed evaluation suite host imports", () => {
  it.each(
    [
      ["ts", "module"],
      ["mts", "module"],
      ["js", "module"],
      ["mjs", "module"],
      ["ts", "commonjs"],
      ["js", "commonjs"],
      ["mts", "commonjs"],
      ["mjs", "commonjs"],
      ["ts", undefined],
      ["js", undefined]
    ] as const
  )("runs a %s suite in a %s project and replays its original identity", async (suffix, type) => {
    const { root } = await fixture(suffix, type)
    const first = command(root, ["run", "exact", "--run-id", "original-run", "--at", timestamp])
    expect(first.code, first.error + first.output).toBe(0)
    expect(JSON.parse(first.output)).toMatchObject({
      runId: "original-run",
      suite: "original/suite",
      cases: [{ case: "original-case" }],
      observations: [{ case: "original-case", scorerName: "exact", stepKey: "original-step", at: timestamp, score: 1 }]
    })
    // Lose only the published artifact, as after a crash between durable
    // completion and publication; the engine must replay the same run.
    await unlink(JSON.parse(first.output).file)
    const resumed = command(root, ["run", "exact", "--run-id", "original-run"])
    expect(resumed.code, resumed.error + resumed.output).toBe(0)
    expect(JSON.parse(resumed.output)).toEqual(JSON.parse(first.output))
    expect(await readFile(join(root, "evals/calls"), "utf8")).toBe("executed\n")
    await expect(access(join(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("evaluation host module identity", () => {
  it.each(["mjs", "ts"])("retains one %s module across loads", async (suffix) => {
    const root = join(directory, `identity-${suffix}`)
    await mkdir(root)
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }))
    const file = join(root, `identity.eval.${suffix}`)
    await writeFile(file, "import { Effect } from \"effect\"; export const value = Effect.succeed(42)\n")
    const first = await Effect.runPromise(LoadSuite.load(file)) as { value: Effect.Effect<number> }
    expect(await Effect.runPromise(first.value)).toBe(42)
    expect(await Effect.runPromise(LoadSuite.load(file))).toBe(first)
    if (suffix === "mjs") expect(await import(pathToFileURL(file).href)).toBe(first)
  })
})

describe("shared evaluation admission", () => {
  it("keeps explicit admission when a different resolver copy installed the hooks", async () => {
    const host = join(directory, "second-host")
    await mkdir(join(host, "src"), { recursive: true })
    await writeFile(join(host, "package.json"), JSON.stringify({ type: "module" }))
    const resolver = join(import.meta.dirname, "../build/build-cli/src/effect-resolution.js")
    const copy = join(host, "src/effect-resolution.js")
    await writeFile(copy, await readFile(resolver))
    await symlink(join(import.meta.dirname, "../build/build-cli/node_modules"), join(host, "node_modules"), "dir")
    const project = join(directory, "admitted-project")
    await mkdir(project)
    await writeFile(join(project, "package.json"), JSON.stringify({ type: "commonjs" }))
    const entry = join(project, "arbitrary.eval.ts")
    await writeFile(entry, "export { string } from \"./helper.js\"\n")
    await writeFile(
      join(project, "helper.ts"),
      "import { Schema } from \"effect\"; export const string: typeof Schema.String = Schema.String\n"
    )
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict"
      const first = await import(${JSON.stringify(pathToFileURL(resolver).href)})
      first.installEffectResolution()
      const second = await import(${JSON.stringify(pathToFileURL(copy).href)})
      const url = second.buildModuleUrl(${JSON.stringify(pathToFileURL(entry).href)})
      const loaded = await second.importDeclarationModule(url, import.meta.url)
      const { Schema } = await import("effect")
      assert.equal(loaded.string, Schema.String)
    `
    ], { cwd: project, encoding: "utf8", timeout: 20_000 })
    expect(child.status, child.stderr + child.stdout).toBe(0)
    await expect(access(join(project, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
