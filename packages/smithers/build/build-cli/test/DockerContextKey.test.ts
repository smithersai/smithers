import { Smithers as S } from "@smthrs/targets"
import type * as Target from "@smthrs/targets/Target"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import { writeExecutable } from "./helpers/Executable.ts"

// The planner resolves docker before it keys a build. The stub answers the
// three probes `resolveDocker` makes and nothing else, so planning runs on a
// host without an engine and no case here can reach a daemon.
let root = ""
let originalPath = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "smthrs-docker-context-key-"))
  await mkdir(join(root, "bin"))
  await writeExecutable(
    join(root, "bin", "docker"),
    `#!/bin/sh
case "$1" in
  --version) echo 'Docker version 0.0.0-stub, build stub' ;;
  info) echo '0.0.0-stub' ;;
  buildx) echo 'NAME/NODE DRIVER/ENDPOINT STATUS' ;;
  *) exit 97 ;;
esac
`
  )
  originalPath = process.env["PATH"] ?? ""
  process.env["PATH"] = `${join(root, "bin")}${delimiter}${originalPath}`
  for (
    const [file, value] of Object.entries({
      "package.json": "{}",
      "yarn.lock": "",
      "PACKAGE.ts": "",
      "Dockerfile": "FROM scratch\nCOPY copied.txt /copied.txt\n",
      "docker-bake.hcl": "target \"app\" {}\n",
      "copied.txt": "first"
    })
  ) {
    await writeFile(join(root, file), value)
  }
})

afterEach(async () => {
  process.env["PATH"] = originalPath
  await rm(root, { recursive: true, force: true })
})

const planOf = (targets: Readonly<Record<string, Target.AnyTarget>>) => {
  const packageJson = S.file("//package.json")
  const index = PackageIndex.make({
    root,
    factory: undefined,
    workspace: S.Workspace("docker-context-key", {
      repository: "git+https://example.invalid/fixture.git",
      cache: S.Cache({ directory: ".flows" }),
      runtime: S.Runtime.Node({ version: "26" }),
      packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
      nodeModules: S.Npm.NodeModules({ packageJson })
    }),
    packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets }) }]
  })
  return PackageExec.plan({ index, cacheDirectory: ".flows", verb: "auto", patterns: ["//..."] })
}

it("keys a Docker.Build on the files its context holds, not the Dockerfile alone", async () => {
  const targets = { image: S.Docker.Build({ dockerfile: S.file("Dockerfile"), context: "." }) }
  const before = (await planOf(targets)).nodes.get("//:image")!
  expect(before.cacheable).toBe(true)
  await writeFile(join(root, "copied.txt"), "second")
  const after = (await planOf(targets)).nodes.get("//:image")!
  expect(after.keyPreview).not.toBe(before.keyPreview)
})

it("does not key a Docker.Build on the archive it writes inside its own context", async () => {
  const targets = { image: S.Docker.Build({ dockerfile: S.file("Dockerfile"), context: "." }) }
  const before = (await planOf(targets)).nodes.get("//:image")!
  await mkdir(join(root, "docker-image"))
  await writeFile(join(root, "docker-image", "image.tar"), "archive")
  const after = (await planOf(targets)).nodes.get("//:image")!
  expect(after.keyPreview).toBe(before.keyPreview)
})

it("caches a Docker.Bake only when data declares what its contexts read", async () => {
  const plan = await planOf({
    bare: S.Docker.Bake({ config: S.file("docker-bake.hcl"), target: "app" }),
    covered: S.Docker.Bake({ config: S.file("docker-bake.hcl"), target: "app", data: [S.file("copied.txt")] })
  })
  expect(plan.nodes.get("//:bare")!.cacheable).toBe(false)
  expect(plan.nodes.get("//:covered")!.cacheable).toBe(true)
})
