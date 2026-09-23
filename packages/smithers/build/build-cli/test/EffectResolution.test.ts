/**
 * The CommonJS half of the declaration-module resolution contract.
 *
 * tsx classifies a declaration module by its nearest package.json, so a
 * workspace that declares no `type` evaluates PACKAGE.ts and WORKSPACE.ts
 * through the CommonJS bridge on Node 22.19.0, which this repository once
 * pinned; a newer Node keeps the same file on the ES-module path. The
 * ES-module hook re-parents the CLI-owned bare specifiers. CommonJS uses
 * ordinary installed dependencies and tsx maps `./x.js` onto `x.ts`.
 */
import * as Fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import { installEffectResolution } from "../src/effect-resolution.js"
import { jsExtensionSiblings } from "../src/internal/js-extension-siblings.js"

installEffectResolution()

/** A directory outside this repository, the way a bootstrapped workspace sits. */
let outside = ""

beforeAll(async () => {
  outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-effect-resolution-")))
  await Fs.mkdir(NodePath.join(outside, "src"), { recursive: true })
  await Fs.mkdir(NodePath.join(outside, "environments"), { recursive: true })
  await Fs.mkdir(NodePath.join(outside, "node_modules", "@smthrs"), { recursive: true })
  const require = createRequire(import.meta.url)
  for (const name of ["effect", "@smthrs/targets"]) {
    await Fs.symlink(
      NodePath.dirname(require.resolve(`${name}/package.json`)),
      NodePath.join(outside, "node_modules", name),
      "dir"
    )
  }
  await Fs.writeFile(NodePath.join(outside, "src", "PACKAGE.ts"), "export const Package = {}\n", "utf8")
})

afterAll(async () => {
  await Fs.rm(outside, { recursive: true, force: true })
})

describe("the CommonJS resolver a bridged declaration module gets", () => {
  it("resolves the installed shared dependencies from the requester", () => {
    const require = createRequire(NodePath.join(outside, "WORKSPACE.ts"))
    expect(require.resolve("@smthrs/targets")).toContain(NodePath.join("packages", "smithers", "build", "targets"))
    expect(require.resolve("effect")).toContain(NodePath.join("node_modules", "effect"))
  })

  it("maps a NodeNext `.js` specifier onto the TypeScript file next to it", () => {
    const require = createRequire(NodePath.join(outside, "environments", "PACKAGE.ts"))
    expect(require.resolve("../src/PACKAGE.js")).toBe(NodePath.join(outside, "src", "PACKAGE.ts"))
  })

  it("still reports a specifier that resolves to nothing", () => {
    const require = createRequire(NodePath.join(outside, "environments", "PACKAGE.ts"))
    expect(() => require.resolve("../src/Missing.js")).toThrow(/Cannot find module '\.\.\/src\/Missing\.js'/)
  })

  it("pins the shared `./x.js` -> `x.ts` table to the compiler's mapping", () => {
    expect(jsExtensionSiblings).toEqual({
      ".js": [".ts", ".tsx"],
      ".jsx": [".tsx"],
      ".mjs": [".mts"],
      ".cjs": [".cts"]
    })
  })
})

/**
 * The same workspace, evaluated in both module formats.
 *
 * tsx picks the format from the nearest package.json, so the only difference
 * between these two copies is the one `type` field: the copy that declares
 * nothing routes its declaration modules through the CommonJS bridge on Node
 * 22.19.0, and the copy that declares `"module"` takes the ES-module path on
 * every version. A workspace's meaning must not depend on that choice, so the
 * two target graphs are compared directly rather than each being checked
 * against a hand-written list.
 */
const fixture = NodePath.join(NodePath.dirname(fileURLToPath(import.meta.url)), "fixtures", "viem-node-spec")

/** Copies the fixture and rewrites its root package.json `type`. */
const workspaceTyped = async (type: string | undefined) => {
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), `smthrs-format-${type ?? "none"}-`))
  await Fs.cp(fixture, root, { recursive: true })
  const manifest = NodePath.join(root, "package.json")
  const declared = JSON.parse(await Fs.readFile(manifest, "utf8")) as Record<string, unknown>
  if (type === undefined) delete declared.type
  else declared.type = type
  await Fs.writeFile(manifest, `${JSON.stringify(declared, null, 2)}\n`, "utf8")
  return root
}

/** Runs `query //...` against one workspace root and returns its target rules. */
const queryTargets = async (root: string) => {
  let exitCode = 0
  let output = ""
  await makeCli({}).serve([...normalizeArgv(["query", "//...", "--format", "json"]), "--workspace", root], {
    exit: (code) => void (exitCode = code),
    stdout: (text) => void (output += text)
  })
  return { exitCode, output }
}

describe("a declaration module means the same thing in either module format", () => {
  it("produces one target graph whether or not the workspace declares type: module", async () => {
    const [bridged, esm] = await Promise.all([workspaceTyped(undefined), workspaceTyped("module")])
    try {
      const bridgedResult = await queryTargets(bridged)
      const esmResult = await queryTargets(esm)
      expect(bridgedResult.exitCode, bridgedResult.output).toBe(0)
      expect(esmResult.exitCode, esmResult.output).toBe(0)
      const labels = (raw: string) =>
        (JSON.parse(raw).targets as ReadonlyArray<{ readonly label: string; readonly target: string }>)
          .map((row) => `${row.label} ${row.target}`)
          .sort()
      const bridgedLabels = labels(bridgedResult.output)
      expect(bridgedLabels.length).toBeGreaterThan(10)
      expect(bridgedLabels).toEqual(labels(esmResult.output))
    } finally {
      await Promise.all([
        Fs.rm(bridged, { recursive: true, force: true }),
        Fs.rm(esm, { recursive: true, force: true })
      ])
    }
  })
})
