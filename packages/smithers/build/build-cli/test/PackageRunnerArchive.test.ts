import * as Exec from "@smthrs/targets/Exec"
import { Effect } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
const removable = async (path: string): Promise<void> => {
  const stat = await Fs.lstat(path).catch(() => undefined)
  if (stat?.isDirectory()) {
    await Fs.chmod(path, stat.mode | 0o700)
    for (const entry of await Fs.readdir(path)) await removable(Path.join(path, entry))
  }
}
afterAll(async () => {
  for (const root of roots) {
    await removable(root)
    await Fs.rm(root, { recursive: true, force: true })
  }
})

const fixture = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-go-archive-")))
  roots.push(root)
  await write(root, "go.mod", "module example.invalid/archive\n\ngo 1.26.0\n")
  await write(root, "go.sum", "")
  await write(root, ".gomodcache/seed", "fixture module bytes\n")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const go = S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: S.Nix.DevShell({ flake: S.file("//go.mod"), lock: S.file("//go.sum") }), cgo: false })
export const Workspace = S.Workspace("archive", { repository: "git+https://example.invalid/archive.git", cache: S.Cache({ directory: ".flows" }), toolchains: [go] })`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { fetch: S.Go.ModDownload({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), outDirs: ["//.gomodcache"], sandbox: "none" }) } })`
  )
  const options = {
    index: PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root),
    cacheDirectory: ".flows",
    verb: "auto" as const,
    patterns: ["//:fetch"]
  }
  const plan = await PackageExec.plan(options)
  const node = plan.workList.find((entry) => entry.label === "//:fetch")!
  return { root, options, plan, node }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
const entryOf = async ({ root, node }: Fixture) => {
  const store = await Effect.runPromise(executionServicesLive.cache({ workspaceRoot: root, cacheDirectory: ".flows" }))
  try {
    const entry = await store.get(node.keyPreview)
    expect(entry).not.toBeNull()
    return entry!
  } finally {
    await store.close()
  }
}
const poison = async (f: Fixture, output: unknown) => {
  const entry = await entryOf(f)
  await Fs.writeFile(
    Path.join(f.root, ".flows/cache", f.node.keyPreview.slice(0, 2), `${f.node.keyPreview}.json`),
    JSON.stringify({ ...entry, output })
  )
}
const first = async (f: Fixture) => {
  const result = await PackageExec.execute(f.plan, f.options)
  expect(result.results).toMatchObject([{ status: "ran" }])
  expect(result.ok, JSON.stringify(result.results)).toBe(true)
}

describe("module cache archive boundaries", () => {
  it.each([
    ["null", null],
    ["primitive", 7],
    ["wrong kind", { kind: "other" }],
    ["wrong directory", { kind: "directory-archive", outDir: "other", digest: "a".repeat(64) }],
    ["non-string digest", { kind: "directory-archive", outDir: ".gomodcache", digest: 7 }],
    ["invalid digest", { kind: "directory-archive", outDir: ".gomodcache", digest: "invalid" }]
  ])("reruns the real fetch when the archive record has %s", async (_fault, output) => {
    const f = await fixture()
    await first(f)
    await poison(f, output)
    const result = await PackageExec.execute(f.plan, f.options)
    expect(result.results).toMatchObject([{ status: "ran" }])
    expect(await Fs.readFile(Path.join(f.root, ".gomodcache/seed"), "utf8")).toBe("fixture module bytes\n")
    expect((await entryOf(f)).output).toMatchObject({ kind: "directory-archive", outDir: ".gomodcache" })
  })

  it("reruns a fetch when the recorded archive blob has disappeared", async () => {
    const f = await fixture()
    await first(f)
    const entry = await entryOf(f)
    const output = entry.output as { digest: string }
    await Fs.unlink(Path.join(f.root, ".flows/cas", output.digest))
    expect((await PackageExec.execute(f.plan, f.options)).results).toMatchObject([{ status: "ran" }])
    expect(await Fs.stat(Path.join(f.root, ".flows/cas", output.digest))).toBeDefined()
  })

  it.each([[[]], [[".gomodcache", "another-cache"]]] as const)(
    "refuses an archive plan with output roots %j",
    async (outDirs) => {
      const f = await fixture()
      for (const directory of outDirs) await write(f.root, `${directory}/seed`, "seed")
      const invalid = { ...f.node, outDirs } as unknown as PackageExec.PackageNode
      const result = await PackageExec.execute({
        ...f.plan,
        workList: [invalid],
        nodes: new Map([[invalid.label, invalid]])
      }, f.options)
      expect(result.results).toMatchObject([{
        status: "failed",
        error: "directory archive requires exactly one declared outDir"
      }])
    }
  )

  it.each([false, true])("reports a missing tar binary after a real fetch (cached=%s)", async (cached) => {
    const f = await fixture()
    if (cached) await first(f)
    const bin = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-archive-path-"))
    roots.push(bin)
    for (const name of ["go", "node", "git", "sh"]) {
      const found = PackageTree.findOnPath(name)
      expect(found).toBeDefined()
      await Fs.symlink(found!, Path.join(bin, name))
    }
    const before = process.env.PATH
    process.env.PATH = bin
    try {
      const result = await PackageExec.execute(f.plan, f.options)
      expect(result.results).toMatchObject([{
        status: "failed",
        error: expect.stringContaining("host binary \"tar\" is not present on PATH")
      }])
    } finally {
      if (before === undefined) delete process.env.PATH
      else process.env.PATH = before
    }
  })

  it.each(["missing", "nul", "absolute", "parent"] as const)(
    "discards an archive whose listing becomes %s",
    async (fault) => {
      const f = await fixture()
      await first(f)
      let faults = 0
      let fetched = 0
      const result = await Effect.runPromise(
        executeEffect(f.plan, f.options).pipe(Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          exec: (options, payload) =>
            executionServicesLive.exec(options, payload).pipe(Effect.tap(() =>
              Effect.promise(async () => {
                if (payload.argv[0] === f.node.argv?.[0]) fetched++
                const listing = payload.argv.at(-1)
                if (listing?.endsWith(".list")) {
                  faults++
                  if (fault === "missing") await Fs.unlink(listing)
                  else {await Fs.writeFile(
                      listing,
                      fault === "nul" ? "bad\0path\n" : fault === "absolute" ? "/outside\n" : "../outside\n"
                    )}
                }
              })
            ))
        }))
      )
      expect(faults).toBe(1)
      expect(fetched).toBe(1)
      expect(result.results).toMatchObject([{ status: "ran" }])
      expect(await Fs.readFile(Path.join(f.root, ".gomodcache/seed"), "utf8")).toBe("fixture module bytes\n")
    }
  )

  it("makes an existing read-only cache removable before restoring the captured tree", async () => {
    const f = await fixture()
    await first(f)
    await write(f.root, ".gomodcache/stale/nested/file", "stale")
    await Fs.chmod(Path.join(f.root, ".gomodcache/stale/nested"), 0o500)
    await Fs.chmod(Path.join(f.root, ".gomodcache/stale"), 0o500)
    await Fs.chmod(Path.join(f.root, ".gomodcache"), 0o500)
    const restored = await PackageExec.execute(f.plan, f.options)
    expect(restored.results).toMatchObject([{ status: "hit" }])
    await expect(Fs.stat(Path.join(f.root, ".gomodcache/stale"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await Fs.readFile(Path.join(f.root, ".gomodcache/seed"), "utf8")).toBe("fixture module bytes\n")
  })
})

describe("archive index host failure", () => {
  it("reruns the real fetch when the archive index process fails", async () => {
    const f = await fixture()
    await first(f)
    let indexed = 0
    let fetched = 0
    const result = await Effect.runPromise(
      executeEffect(f.plan, f.options).pipe(
        Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          exec: (settings, payload) => {
            if (payload.argv.at(-1)?.endsWith(".list")) {
              indexed++
              return Effect.fail(
                Exec.ExecError.make({
                  _tag: "smithers-build/ExecError",
                  argv: payload.argv,
                  cwd: payload.cwd,
                  code: "exit_status",
                  exitCode: 71,
                  stdout: "",
                  stderr: "archive index host failed"
                })
              )
            }
            if (payload.argv[0] === f.node.argv?.[0]) fetched++
            return executionServicesLive.exec(settings, payload)
          }
        })
      )
    )
    expect(indexed).toBe(1)
    expect(fetched).toBe(1)
    expect(result.results[0]?.status).toBe("ran")
    expect(await Fs.readFile(Path.join(f.root, ".gomodcache/seed"), "utf8")).toBe("fixture module bytes\n")
  })
})
