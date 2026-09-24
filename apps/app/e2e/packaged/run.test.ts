import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { resolve, join } from "node:path"
import { stagePackageProject } from "./run"

test("failed package copying removes the partially staged workspace", async () => {
  let root: string | undefined
  const copyError = new Error("injected copy failure after writing partial data")
  const copy = spyOn(fs, "cp").mockImplementation(async (_source, destination) => {
    root = resolve(String(destination), "../../..")
    await fs.mkdir(String(destination), { recursive: true })
    await fs.writeFile(join(String(destination), "partial"), "copied data")
    throw copyError
  })
  try {
    await expect(stagePackageProject()).rejects.toBe(copyError)
    expect(root).toBeDefined()
    expect(await fs.access(root!).then(() => true, () => false)).toBe(false)
  } finally {
    copy.mockRestore()
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true })
  }
})

test("failed staging preserves both the copy and cleanup errors", async () => {
  let root: string | undefined
  const copyError = new Error("injected copy failure")
  const cleanupError = new Error("injected cleanup failure")
  const copy = spyOn(fs, "cp").mockImplementation(async (_source, destination) => {
    root = resolve(String(destination), "../../..")
    throw copyError
  })
  const remove = spyOn(fs, "rm").mockRejectedValue(cleanupError)
  try {
    const error = await stagePackageProject().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([copyError, cleanupError])
  } finally {
    copy.mockRestore()
    remove.mockRestore()
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true })
  }
})


test("staging creates one independent app package and links sibling apps", async () => {
  const source = await fs.mkdtemp(join((await import("node:os")).tmpdir(), "package-source-"))
  const priorHome = process.env.HUTCH_HOME
  let stage: Awaited<ReturnType<typeof stagePackageProject>> | undefined
  try {
    for (const dir of ["apps/app/node_modules", "apps/app/build", "apps/tui", "node_modules", "packages", "flows", "e2e", "examples", "patches", "hutch/releases", "hutch/toolchains", "hutch/npm"])
      await fs.mkdir(join(source, dir), { recursive: true })
    for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "bun.lock"])
      await fs.writeFile(join(source, file), "{}")
    await fs.writeFile(join(source, "apps/app/package.json"), '{"name":"smithers-app"}')
    await fs.writeFile(join(source, "apps/app/build/stale"), "stale")
    process.env.HUTCH_HOME = join(source, "hutch")
    stage = await stagePackageProject(source)
    expect(stage.app).toBe(join(stage.root, "workspace/apps/app"))
    expect((await fs.lstat(stage.app)).isSymbolicLink()).toBe(false)
    expect(await fs.realpath(join(stage.app, "../tui"))).toBe(await fs.realpath(join(source, "apps/tui")))
    expect(await fs.readdir(join(stage.app, ".."))).toEqual(["app", "tui"])
    expect(await fs.access(join(stage.app, "build")).then(() => true, () => false)).toBe(false)
  } finally {
    if (priorHome === undefined) delete process.env.HUTCH_HOME
    else process.env.HUTCH_HOME = priorHome
    if (stage) await fs.rm(stage.root, { recursive: true, force: true })
    await fs.rm(source, { recursive: true, force: true })
  }
}, 30_000)
