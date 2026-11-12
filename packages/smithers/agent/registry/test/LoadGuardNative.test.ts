/**
 * The load guard under the actual runtimes. Vitest evaluates a test's imports
 * itself, so only a real process shows Node's resolver letting the measured
 * copies through and refusing their unmeasured neighbours.
 */
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const driver = fileURLToPath(new URL("./fixtures/native/load-guard-contract.ts", import.meta.url))

const tool = `import { createRequire } from "node:module"
import { join } from "node:path"
// The repository the flow works on brings its own TypeScript.
export const version = (target) => createRequire(join(target, "package.json"))("typescript").version
export const beside = (specifier) => createRequire(import.meta.url)(specifier)
export const from = (parent, specifier) => createRequire(parent)(specifier)
`
const flow = (name: string, prelude: string) =>
  `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
${prelude}
export default Flow.make("${name}", {
  description: "Loads code by a path it computes", payload: {}, success: Schema.String,
  body: () => Node.succeed("loaded")
})
`
const exposed = (name: string) =>
  `import * as tool from "./tool.mjs"\nReflect.set(globalThis, "issue4718/${name}", tool)`

const files: Readonly<Record<string, string>> = {
  "bundler.config.cjs": `module.exports = "the repository's own configuration"`,
  "target/package.json": JSON.stringify({ name: "target" }),
  "target/node_modules/typescript/package.json": JSON.stringify({ main: "index.js" }),
  "target/node_modules/typescript/index.js": `exports.version = "9.9.9-target"`,
  ".smithers/flows/held/flow.ts": flow("held", `import "./measured.cjs"\n${exposed("held")}`),
  ".smithers/flows/held/tool.mjs": tool,
  ".smithers/flows/held/measured.cjs": `module.exports = "measured"`,
  ".smithers/flows/held/unmeasured.cjs": `module.exports = "unmeasured"`,
  ".smithers/flows/plain/flow.ts": flow(
    "plain",
    `import { value } from "./helper.ts"\nReflect.set(globalThis, "issue4718/plain", value)`
  ),
  ".smithers/flows/plain/helper.ts": `export const value = "a measured helper"`,
  // Reached through `.smithers/flows/linked`, a symbolic link out of the source root.
  "moved/linked/flow.ts": flow("linked", exposed("linked")),
  "moved/linked/tool.mjs": tool
}

interface Loaded {
  readonly loaded?: true
  readonly code?: string
  readonly message?: string
}
interface Attempt {
  readonly value?: unknown
  readonly refused?: string
  readonly path?: string
  readonly root?: string
}
interface Result {
  readonly held: Loaded
  readonly runs?: Readonly<Record<"version" | "unmeasured" | "original" | "dotdot" | "config", Attempt>>
  readonly plain: Loaded
  readonly plainValue?: string
  readonly linked: Loaded
  readonly linkedEvaluated: boolean
  readonly leftovers: ReadonlyArray<string>
}

const run = async (runtime: string) => {
  const root = await realpath(await mkdtemp(join(modulesRoot, ".native-guard-")))
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true })
      await writeFile(join(root, path), content)
    }
    await symlink(join(root, "moved/linked"), join(root, ".smithers/flows/linked"), "dir")
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        runtime,
        [driver, root, join(root, "target")],
        { timeout: 120_000 },
        (error, output, stderr) => error === null ? resolve(output) : reject(new Error(`${error.message}\n${stderr}`))
      )
    )
    return { root, result: JSON.parse(stdout) as Result }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("a flow that computes the target of a load", () => {
  it("runs under actual Node, held to its source root by real path", async () => {
    const { result, root } = await run(process.execPath)
    const sourceRoot = join(root, ".smithers/flows")
    const refused = (file: string): Attempt => ({
      refused: "flows/registry/UnmeasuredLoadError",
      path: join(sourceRoot, file),
      root: sourceRoot
    })
    expect(result.held, JSON.stringify(result)).toEqual({ loaded: true })
    expect(result.runs).toEqual({
      version: { value: "9.9.9-target" },
      unmeasured: refused("held/unmeasured.cjs"),
      original: refused("held/measured.cjs"),
      dotdot: refused("held/unmeasured.cjs"),
      config: { value: "the repository's own configuration" }
    })
    // Another flow's measured copies still load from the root the guard holds.
    expect(result.plain).toEqual({ loaded: true })
    expect(result.plainValue).toBe("a measured helper")
    expect(result.linked.code).toBe("body_unavailable")
    expect(result.linked.message).toContain("is reached through a symbolic link that leaves the flow source root")
    expect(result.linkedEvaluated).toBe(false)
    expect(result.leftovers).toEqual([])
  }, 180_000)

  it("stays refused under actual Bun, which has no module hooks to check a load with", async () => {
    const { result } = await run("bun")
    for (const refusedFlow of [result.held, result.linked]) {
      expect(refusedFlow.code, JSON.stringify(result)).toBe("body_unavailable")
      expect(refusedFlow.message).toContain("cannot pin")
      expect(refusedFlow.message).toContain("takes a LoadGuard and the default loader")
    }
    expect(result.runs).toBeUndefined()
    expect(result.linkedEvaluated).toBe(false)
    expect(result.plain).toEqual({ loaded: true })
    expect(result.plainValue).toBe("a measured helper")
    expect(result.leftovers).toEqual([])
  }, 180_000)
})
