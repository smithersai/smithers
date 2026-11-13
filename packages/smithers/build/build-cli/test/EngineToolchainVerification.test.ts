import * as TargetPackageManager from "@smthrs/targets/PackageManager"
import * as TargetRuntime from "@smthrs/targets/Runtime"
import * as Effect from "effect/Effect"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  layerNonInteractiveNodeServices,
  packageManagerEnvironment,
  targetToolchain,
  verifyTargetToolchain
} from "../src/engine.ts"

let root = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "smithers-engine-toolchain-"))
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

/**
 * Writes an executable into the target directory that records its own name in
 * `probes.log`, relative to the directory it runs in, and prints `version`.
 */
const tool = async (name: string, version: string): Promise<string> => {
  const path = join(root, name)
  await writeFile(path, `#!/bin/sh\necho ${name} >> probes.log\necho ${version}\n`)
  await chmod(path, 0o755)
  return `./${name}`
}

/** The tools that ran, in order, as seen from the target directory. */
const probes = async (): Promise<Array<string>> =>
  (await readFile(join(root, "probes.log"), "utf8").catch(() => "")).split("\n").filter((line) => line !== "")

const verify = (toolchain: ReturnType<typeof targetToolchain>) =>
  Effect.runPromise(
    verifyTargetToolchain(toolchain, root, packageManagerEnvironment(process.env)).pipe(
      Effect.result,
      Effect.provide(layerNonInteractiveNodeServices)
    )
  )

const bunRuntime = (executable: string, version = ">=1.4.0") =>
  TargetRuntime.ResolvedBunRuntime.make({ name: "bun", version, executable })

const bunManager = (executable: string, runtime: TargetRuntime.ResolvedBunRuntime, version = ">=1.4.0") =>
  TargetPackageManager.ResolvedBunPackageManager.make({ name: "bun", version, executable, runtime })

describe.skipIf(process.platform === "win32")("target toolchain verification", () => {
  it("verifies a runtime-only declaration once, in the target directory", async () => {
    const runtime = bunRuntime(await tool("bun", "1.4.2"))
    const result = await verify({ runtime, packageManager: undefined })
    expect(result._tag).toBe("Success")
    expect(await probes()).toEqual(["bun"])
  })

  it("does not probe the manager's runtime again when it is the target runtime", async () => {
    const runtime = bunRuntime(await tool("bun", "1.4.2"))
    const result = await verify({ runtime, packageManager: bunManager(runtime.executable, runtime) })
    expect(result._tag).toBe("Success")
    expect(await probes()).toEqual(["bun"])
  })

  it("probes the manager's runtime when its name, version or executable differs", async () => {
    const shared = await tool("bun", "1.5.1")
    const other = await tool("bun-other", "1.5.1")
    const node = TargetRuntime.ResolvedNodeRuntime.make({
      name: "node",
      version: ">=26.4.0",
      executable: await tool("node", "v26.4.0")
    })
    const cases = [
      { runtime: node, managerRuntime: bunRuntime(shared), expected: ["node", "bun"] },
      { runtime: bunRuntime(shared), managerRuntime: bunRuntime(shared, ">=1.5.0"), expected: ["bun", "bun"] },
      { runtime: bunRuntime(shared), managerRuntime: bunRuntime(other), expected: ["bun", "bun-other"] }
    ]
    for (const { expected, managerRuntime, runtime } of cases) {
      await rm(join(root, "probes.log"), { force: true })
      const packageManager = bunManager(managerRuntime.executable, managerRuntime, managerRuntime.version)
      const result = await verify({ runtime, packageManager })
      expect(result._tag).toBe("Success")
      expect(await probes()).toEqual(expected)
    }
  })

  it("holds a separately named Bun manager executable to its own requirement", async () => {
    const runtime = bunRuntime(await tool("bun", "1.4.2"))
    const stale = bunManager(await tool("bun-stale", "1.3.0"), runtime)
    const refused = await verify({ runtime, packageManager: stale })
    expect(refused._tag).toBe("Failure")
    expect(refused).toMatchObject({ failure: { _tag: "smithers-build/RuntimeError", code: "unsatisfied" } })
    expect(await probes()).toEqual(["bun", "bun-stale"])
  })

  it("probes a Bun manager whose requirement differs even on the runtime's executable", async () => {
    const runtime = bunRuntime(await tool("bun", "1.4.2"))
    const refused = await verify({ runtime, packageManager: bunManager(runtime.executable, runtime, ">=1.5.0") })
    expect(refused).toMatchObject({ failure: { _tag: "smithers-build/RuntimeError", code: "unsatisfied" } })
    expect(await probes()).toEqual(["bun", "bun"])
  })

  it("refuses a target whose runtime is older than declared before probing the manager", async () => {
    const runtime = bunRuntime(await tool("bun", "1.3.9"))
    const refused = await verify({ runtime, packageManager: bunManager(await tool("bun-other", "1.5.0"), runtime) })
    expect(refused).toMatchObject({ failure: { code: "unsatisfied" } })
    expect(await probes()).toEqual(["bun"])
  })
})

describe.skipIf(process.platform === "win32")("target package-manager verification", () => {
  const pnpm = async (version: string) => {
    const runtime = TargetRuntime.ResolvedNodeRuntime.make({
      name: "node",
      version: ">=26.4.0",
      executable: await tool("node", "v26.4.0")
    })
    return TargetPackageManager.ResolvedPnpmPackageManager.make({
      name: "pnpm",
      version: "11.21.0",
      executable: await tool("pnpm", version),
      runtime
    })
  }

  it("verifies a manager-only declaration's runtime and then the manager itself", async () => {
    const result = await verify({ runtime: undefined, packageManager: await pnpm("11.21.0") })
    expect(result._tag).toBe("Success")
    expect(await probes()).toEqual(["node", "pnpm"])
  })

  it("refuses a manager whose measured version misses its pin", async () => {
    const refused = await verify({ runtime: undefined, packageManager: await pnpm("10.0.0") })
    expect(refused).toMatchObject({ failure: { _tag: "smithers-build/PackageManagerError" } })
    expect(await probes()).toEqual(["node", "pnpm"])
  })
})

describe("target toolchain selection", () => {
  const node = TargetRuntime.ResolvedNodeRuntime.make({ name: "node", version: ">=26.4.0", executable: "node" })
  const pnpm = TargetPackageManager.ResolvedPnpmPackageManager.make({
    name: "pnpm",
    version: "11.21.0",
    executable: "pnpm",
    runtime: node
  })

  it("selects both declared tools for an ordinary target", () => {
    expect(targetToolchain("NodeBinary", { runtime: node, packageManager: pnpm })).toEqual({
      runtime: node,
      packageManager: pnpm
    })
  })

  it("lets Vitest's Bun runtime replace the declared manager with Bun itself", () => {
    const bun = bunRuntime("bun")
    const selected = targetToolchain("Vitest", { runtime: bun, packageManager: pnpm })
    expect(selected.runtime).toBe(bun)
    expect(selected.packageManager).toMatchObject({
      name: "bun",
      version: ">=1.4.0",
      executable: "bun",
      runtime: { name: "bun", version: ">=1.4.0", executable: "bun" }
    })
  })

  it("keeps the declared manager for Vitest under Node", () => {
    expect(targetToolchain("Vitest", { runtime: node, packageManager: pnpm })).toEqual({
      runtime: node,
      packageManager: pnpm
    })
  })
})
