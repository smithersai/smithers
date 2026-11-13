import { Smithers as S } from "@smthrs/targets"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import * as Target from "@smthrs/targets/Target"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import { runTarget } from "../src/TargetExecution.ts"

it("executes an empty Biome source set without invoking a tool over the working directory", async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-biome-empty-")))
  try {
    await Fs.writeFile(Path.join(root, "biome.json"), "{}\n")
    await Fs.writeFile(Path.join(root, "unrelated.ts"), "this is not valid TypeScript )\n")
    const packageManager = PackageManager.ResolvedPnpmPackageManager.make({
      name: "pnpm",
      version: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
      executable: "pnpm",
      runtime: Runtime.ResolvedNodeRuntime.make({
        name: "node",
        version: process.versions.node,
        executable: process.execPath
      })
    })
    const target = S.BiomeCheck({
      packageManager,
      sources: [S.glob("missing/**/*.ts")],
      deps: [],
      config: S.file("biome.json"),
      lint: true,
      format: true
    })
    const exit = await Effect.runPromiseExit(
      runTarget(root, ".flows", target, Target.metadata(target).attrs, "biome-empty-source-set", [])
    )
    expect(exit).toMatchObject({ _tag: "Success", value: { check: null, format: null } })
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})
