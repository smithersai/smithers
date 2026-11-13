/**
 * The PATH a target with declared `tools` spawns under: the tools directory
 * first, then the PATH the target would have had without it.
 */
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { planEffect, PlanningServices, planningServicesLive } from "../src/internal/PackagePlanner.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

/** A workspace whose `check` calls the declared host tool `helper`, which records its PATH. */
const fixture = async (nix: boolean) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-tool-path-")))
  roots.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("tool-path", {
  repository: "git+https://example.invalid/tool-path.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["helper"] }),
  ${nix ? "environment: S.Nix.Environment({ file: S.file(\"//environment.nix\") })," : ""}
})\n`
  )
  await write(root, "environment.nix", "{}\n")
  await write(root, "package.json", "{\"name\":\"tool-path\",\"private\":true}\n")
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  check: S.Shell.Test({ shell: "helper", tools: [S.Host.bin("helper")], sandbox: "none" })
} })\n`
  )
  const bin = Path.join(root, "closure", "bin")
  await write(
    root,
    "closure/bin/helper",
    `#!/bin/sh\nprintf '%s' "$PATH" > ${JSON.stringify(Path.join(root, "path.txt"))}\n`
  )
  await Fs.chmod(Path.join(bin, "helper"), 0o755)
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  return { root, bin, options: { index, cacheDirectory: ".flows", verb: "test" as const, patterns: ["//:check"] } }
}

describe("the PATH of a target with declared tools", () => {
  it("puts the Nix closure's PATH after the tools directory", async () => {
    const { root, bin, options } = await fixture(true)
    const closure = {
      storePath: Path.join(root, "closure"),
      hash: "0".repeat(32),
      path: [bin, "/usr/bin", "/bin"],
      variables: {},
      closure: [Path.join(root, "closure")],
      nix: { executable: "nix", version: "nix (Nix) 2.99.0" },
      system: "x86_64-linux",
      inputs: []
    }
    const runOptions = { ...options, environment: { PATH: "/host/only" } }
    const planned = await Effect.runPromise(
      planEffect(runOptions).pipe(
        Effect.provideService(PlanningServices, {
          ...planningServicesLive,
          resolveNixEnvironment: () => Effect.succeed(closure)
        })
      )
    )
    const node = planned.nodes.get("//:check")!
    expect(node.refusal).toBeUndefined()
    expect(node.pathTools).toEqual([{ name: "helper", path: "{smthrs:root}/closure/bin/helper" }])
    const result = await PackageExec.execute(planned, runOptions)
    expect(result.ok, JSON.stringify(result.results)).toBe(true)
    const [tools, ...rest] = (await Fs.readFile(Path.join(root, "path.txt"), "utf8")).split(Path.delimiter)
    expect(tools).toBe(Path.join(root, ".flows", "tmp", `path-${node.keyPreview.slice(0, 16)}`))
    // The closure's PATH, never the host's.
    expect(rest).toEqual([bin, "/usr/bin", "/bin"])
  })

  it("adds nothing after the tools directory when the host PATH is empty", async () => {
    const { root, bin, options } = await fixture(false)
    const planned = await PackageExec.plan({ ...options, environment: { PATH: bin } })
    const node = planned.nodes.get("//:check")!
    expect(node.refusal).toBeUndefined()
    expect(node.pathTools).toEqual([{ name: "helper", path: "{smthrs:root}/closure/bin/helper" }])
    const result = await PackageExec.execute(planned, { ...options, environment: { PATH: "" } })
    expect(result.ok, JSON.stringify(result.results)).toBe(true)
    expect(await Fs.readFile(Path.join(root, "path.txt"), "utf8")).toBe(
      Path.join(root, ".flows", "tmp", `path-${node.keyPreview.slice(0, 16)}`)
    )
  })
})
