import { Layer } from "effect"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as TargetRuns from "../../src/operator/TargetRuns.ts"

const roots: Array<string> = []

/** Removes every workspace this module created. */
export const removeWorkspaces = async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

/** Replaces the workspace's PACKAGE.ts; `S` is the targets catalog. */
export const declare = (root: string, targets: string) =>
  writeFile(join(root, "PACKAGE.ts"), `import { Smithers as S } from "@smthrs/targets"\n${targets}\n`)

/** A build workspace whose PACKAGE.ts holds the given targets. */
export const workspace = async (targets: string) => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-cron-targets-"))
  roots.push(root)
  await mkdir(join(root, "node_modules/@smthrs"), { recursive: true })
  await symlink(
    dirname(createRequire(import.meta.url).resolve("@smthrs/targets/package.json")),
    join(root, "node_modules/@smthrs/targets"),
    "dir"
  )
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "cron-fixture", type: "module", packageManager: "pnpm@11.25.0" })
  )
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await writeFile(
    join(root, "WORKSPACE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("cron-fixture", {
  repository: "https://example.invalid/cron-fixture",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=22.19.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})
`
  )
  await declare(root, targets)
  return root
}

/** A project directory that is not a build workspace. */
export const bareProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-cron-bare-"))
  roots.push(root)
  return root
}

/** The real program, started the way an installed `smthrs` starts itself. */
export const command = (root: string) =>
  TargetRuns.layerCommand({
    entry: fileURLToPath(new URL("../../bin/smithers.mjs", import.meta.url)),
    environment: { PATH: process.env.PATH, HOME: root, NODE_OPTIONS: process.env.NODE_OPTIONS }
  }).pipe(Layer.provide(TargetRuns.layerSpawner))

/** Polls `read` until `done` accepts its value or the time runs out; answers the last value. */
export const until = async <A>(
  read: () => Promise<A>,
  done: (value: A) => boolean,
  timeoutMs = 60_000
): Promise<A> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}
