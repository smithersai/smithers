/**
 * The environment `runTarget` hands a target's tools: a planned Nix closure's
 * PATH and variables, an empty PATH when the host has none, and a declared
 * toolchain whose optional `env` attr is explicitly absent.
 */
import * as Node from "@smthrs/plan/Node"
import { Smithers as S } from "@smthrs/targets"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import * as Target from "@smthrs/targets/Target"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runTarget } from "../src/TargetExecution.ts"

const roots = new Set<string>()
afterEach(async () => {
  for (const root of roots) await Fs.rm(root, { force: true, recursive: true })
  roots.clear()
})

const workspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-target-environment-")))
  roots.add(root)
  await Fs.writeFile(Path.join(root, "package.json"), "{\"name\":\"target-environment\",\"private\":true}\n")
  return root
}

const node = () =>
  Runtime.ResolvedNodeRuntime.make({ name: "node", version: process.versions.node, executable: process.execPath })

/** A stub tool that answers `--version` and records the PATH it was given. */
const recordingTool = async (root: string, name: string, version: string): Promise<string> => {
  const path = Path.join(root, name)
  await Fs.writeFile(
    path,
    `#!${process.execPath}\n` +
      `require('node:fs').appendFileSync(${JSON.stringify(Path.join(root, `${name}.paths`))}, ` +
      `JSON.stringify(process.env.PATH ?? null) + '\\n')\n` +
      `process.stdout.write(${JSON.stringify(`${version}\n`)})\n`
  )
  await Fs.chmod(path, 0o755)
  return path
}

const readPaths = async (root: string, name: string): Promise<ReadonlyArray<string | null>> =>
  (await Fs.readFile(Path.join(root, `${name}.paths`), "utf8")).trim().split("\n").map((line) => JSON.parse(line))

describe.skipIf(process.platform === "win32")("target tool environment", () => {
  it("runs a non-pnpm tool under the planned Nix closure's PATH and variables", async () => {
    const root = await workspace()
    const output = Path.join(root, "seen.json")
    await Fs.writeFile(
      Path.join(root, "entry.cjs"),
      `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ ` +
        `path: process.env.PATH, marker: process.env.NIX_MARKER ?? null, ` +
        `store: process.env.pnpm_config_store_dir ?? null }))\n`
    )
    const target = S.NodeBinary({ runtime: node(), entry: S.file("entry.cjs"), args: [], srcs: [], deps: [] })
    const nix = {
      storePath: "/nix/store/0000000000000000000000000000000-environment",
      hash: "0000000000000000000000000000000",
      closure: [],
      path: [Path.dirname(process.execPath), "/usr/bin", "/bin"],
      variables: { NIX_MARKER: "from-closure" }
    }
    const exit = await Effect.runPromiseExit(
      runTarget(root, ".flows", target, Target.metadata(target).attrs, "nix-environment", [], undefined, nix)
    )
    expect(exit).toMatchObject({ _tag: "Success", value: { exitCode: 0 } })
    expect(JSON.parse(await Fs.readFile(output, "utf8"))).toEqual({
      path: nix.path.join(Path.delimiter),
      marker: "from-closure",
      // Only a pnpm target gets the shared install store.
      store: null
    })
  })

  it("gives a pnpm toolchain no lookup path when the host has none", async () => {
    const root = await workspace()
    const pnpm = await recordingTool(root, "pnpm", "11.25.0")
    const target = Target.make("PnpmWithoutHostPath", {
      attrs: Schema.Struct({ packageManager: PackageManager.PackageManager }),
      kinds: ["build"],
      success: Schema.String,
      implementation: () => Node.succeed("planned")
    })({
      packageManager: PackageManager.ResolvedPnpmPackageManager.make({
        name: "pnpm",
        version: "11.25.0",
        executable: pnpm,
        runtime: node()
      })
    })
    const hostPath = process.env["PATH"]
    delete process.env["PATH"]
    try {
      const exit = await Effect.runPromiseExit(
        runTarget(root, ".flows", target, Target.metadata(target).attrs, "no-host-path", [])
      )
      expect(exit).toMatchObject({ _tag: "Success", value: "planned" })
    } finally {
      process.env["PATH"] = hostPath
    }
    // The version probe ran with no lookup path at all, never a host one.
    expect(await readPaths(root, "pnpm")).toEqual([null])
  })

  it("treats an explicitly absent env attr of a declared toolchain as no variables", async () => {
    const root = await workspace()
    const target = Target.make("RuntimeWithOptionalEnv", {
      attrs: Schema.Struct({
        runtime: Runtime.Runtime,
        env: Schema.optional(Schema.Record(Schema.String, Schema.String))
      }),
      kinds: ["build"],
      success: Schema.String,
      implementation: (attrs) => Node.succeed(`env=${JSON.stringify(attrs.env ?? null)}`)
    })({ runtime: node(), env: undefined })
    const attrs = { runtime: node(), env: undefined }
    expect(Object.hasOwn(Target.metadata(target).attrsSchema.make(attrs) as object, "env")).toBe(true)
    const exit = await Effect.runPromiseExit(runTarget(root, ".flows", target, attrs, "absent-env", []))
    expect(exit).toMatchObject({ _tag: "Success", value: "env=null" })
  })
})
