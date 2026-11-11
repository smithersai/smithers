/**
 * File-backed flows in both source languages cross the real CLI boundary.
 * Discovery stays metadata-only; execution imports and runs the selected body.
 */
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { temporaryEnvironment } from "./temporaryEnvironment.ts"

const execute = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const modules = fileURLToPath(new URL("../node_modules", import.meta.url))
const roots: Array<string> = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const project = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-flow-languages-")))
  roots.push(root)
  await mkdir(root, { recursive: true })
  await symlink(modules, join(root, "node_modules"), "dir")
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        skipLibCheck: true
      },
      include: [".smithers/flows/**/*"]
    })
  )
  const command = async (...args: Array<string>) => {
    const result = await execute(process.execPath, [
      "--no-warnings",
      "--import",
      preload,
      bin,
      ...args,
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
      timeout: 90_000
    }).catch((cause: { code?: number; stdout?: string; stderr?: string }) => {
      throw new Error(`CLI ${args[0]} failed (${cause.code}):\n${cause.stdout ?? ""}\n${cause.stderr ?? ""}`)
    })
    return JSON.parse(result.stdout)
  }
  return { root, command }
}

describe("flow source languages", () => {
  it("starts a directory whose sole file is flow.vibe", async () => {
    const { root, command } = await project()
    const directory = join(root, ".smithers", "flows", "solo")
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "flow.vibe"),
      `import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
const Echo = Action.make("solo/value", { payload: { value: Schema.String }, success: Schema.String })
export const layer = Echo.toLayer(effect ({ value }) => {
  try yieldNow
  return value
})
export default Flow.make("solo", {
  description: "Echo a value from VibeLang",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: { value: Schema.String },
  success: Schema.String,
  body: Node.capture({ action: Echo.name }, ({ value }) => Echo.call({ value }))
})
`
    )
    expect(await readdir(directory)).toEqual(["flow.vibe"])
    expect((await command("flow", "list")).items).toContainEqual(expect.objectContaining({ flowId: "solo" }))
    const started = await command("flow", "start", "solo", "--data", "{\"value\":\"hello\"}", "--wait")
    expect((await command("runs", "list")).items).toContainEqual(expect.objectContaining({
      runId: started.runId,
      flowId: "solo",
      status: "completed"
    }))
  }, 180_000)

  it.each([
    { language: "ts", specifier: "./helper.ts", helper: "helper.ts" },
    { language: "vibe", specifier: "./helper.vibe", helper: "helper.vibe" },
    { language: "vibe", specifier: "./helper.ts", helper: "helper.ts" },
    { language: "vibe", specifier: "./helper", helper: "helper.vibe" },
    { language: "vibe", specifier: "./helper.js", helper: "helper.vibe" },
    { language: "vibe", specifier: "./helper", helper: "helper/index.vibe" }
  ])("lists and completes flow.$language importing $specifier ($helper)", async ({ language, specifier, helper }) => {
    const { root, command } = await project()
    const directory = join(root, ".smithers", "flows", "echo")
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "loaded.ts"),
      `import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(join(root, "loaded.txt"))}, "loaded")`
    )
    await mkdir(join(directory, "helper"), { recursive: true })
    await writeFile(
      join(directory, helper),
      language === "vibe"
        ? "export effect function echo({ value }: { readonly value: string }) { return value }\n"
        : "import { Effect } from \"effect\"\nexport const echo = ({ value }: { readonly value: string }) => Effect.succeed(value)\n"
    )
    if (language === "vibe" && helper.endsWith(".ts")) {
      await writeFile(join(directory, helper), "export { echo } from \"./leaf\"\n")
      await writeFile(
        join(directory, "leaf.vibe"),
        "export effect function echo({ value }: { readonly value: string }) { return value }\n"
      )
    }
    await writeFile(
      join(directory, `flow.${language}`),
      `import "./loaded.ts"
import { echo } from "${specifier}"
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
const Echo = Action.make("echo/value", { payload: { value: Schema.String }, success: Schema.String })
export const layer = Echo.toLayer(echo)
export default Flow.make("echo", {
  description: "Echo a value without a model",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: { value: Schema.String },
  success: Schema.String,
  body: Node.capture({ action: Echo.name }, ({ value }) => Echo.call({ value }))
})
`
    )
    const listed = await command("flow", "list")
    expect(listed.items.filter((item: { flowId: string }) => item.flowId === "echo")).toMatchObject([{
      flowId: "echo",
      inputSchema: { schema: { properties: { value: { type: "string" } }, required: ["value"] } }
    }])
    await expect(access(join(root, "loaded.txt"))).rejects.toThrow()
    const started = await command("flow", "start", "echo", "--data", "{\"value\":\"hello\"}", "--wait")
    expect(started.runId).toEqual(expect.any(String))
    expect(await readFile(join(root, "loaded.txt"), "utf8")).toBe("loaded")
    const runs = await command("runs", "list")
    expect(runs.items).toContainEqual(
      expect.objectContaining({ runId: started.runId, flowId: "echo", status: "completed" })
    )
  }, 180_000)

  it.each(["init", "generate"])(
    "scaffolds a VibeLang entry with %s and retains it on init",
    async (verb) => {
      const { root, command } = await project()
      const result = verb === "init"
        ? (await command("init", "starter", "--vibe")).flow
        : await command("generate", "flow", "starter", "--vibe")
      expect(result).toMatchObject({
        created: true,
        flowFile: join(root, ".smithers", "flows", "starter", "flow.vibe")
      })
      const source = await readFile(result.flowFile, "utf8")
      expect(source).toContain("body: Node.capture(")
      expect(source).toContain("(input) => Work.call(input)")
      const config = JSON.parse(await readFile(join(root, ".smithers", "flows", "starter", "tsconfig.json"), "utf8"))
      expect(config.include).toContain("*.vibe")
      expect(source).toContain("prompt: ({ args }) =>")
      expect((await command("init", "starter")).flow).toMatchObject({ created: false, flowFile: result.flowFile })
      expect(await readFile(result.flowFile, "utf8")).toBe(source)
      const listed = await command("flow", "list")
      expect(listed.items).toContainEqual(expect.objectContaining({ flowId: "starter" }))
    },
    180_000
  )
})
