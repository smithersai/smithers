import { Effect } from "effect"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { expect, it } from "vitest"
import { openCache } from "../../../build-cli/src/Cache.ts"
import * as PackageExec from "../../../build-cli/src/PackageExec.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../../../build-cli/src/internal/PackageRunner.ts"
import { runnerFixture } from "../../../build-cli/test/helpers/PackageRunnerFixture.ts"
import { createHandler } from "../protocol.ts"
import { MemoryActionCache, MemoryContentStore } from "./MemoryStores.ts"
import { createHash } from "node:crypto"

it.each([1, 520])("reports a real target hit and restores %i outputs after all local cache files are removed", async count => {
  const f = await runnerFixture(`
const command = S.ToolBuild({
  tool: "sh", command: "sh",
  args: ["-c", "mkdir -p out && printf artifact > out/program && chmod 755 out/program && i=1; while [ $i -lt ${count} ]; do printf artifact-%s $i > out/file-$i; i=$((i+1)); done; printf run >> calls.log"],
  inputs: [], outputs: ["out"], deps: [], env: {}, cache: true
})
export const Package = S.Package({ targets: { command } })
`, { ".gitignore": "calls.log\n.flows\n" }, "sandboxes: S.Sandboxes({ default: S.Sandbox.None() }),")
  const first = await PackageExec.execute(f.plan, f.options)
  expect(first.ok, JSON.stringify(first.results)).toBe(true)
  expect(first.results).toMatchObject([{ label: "//:command", status: "ran" }])
  const key = f.plan.nodes.get("//:command")!.keyPreview
  const local = await openCache({ workspaceRoot: f.root })
  const result = await local.get(key)
  expect(result).not.toBeNull()
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const batches: Array<number> = []
  class SlowContentStore extends MemoryContentStore {
    override async presentDigests(digests: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
      batches.push(digests.length)
      // One 520-digest probe would exceed the metadata read budget.
      await new Promise(resolve => setTimeout(resolve, digests.length * 8))
      return super.presentDigests(digests)
    }
  }
  const actionCache = new MemoryActionCache()
  const handler = createHandler({
    actionCache, contentStore: new SlowContentStore(),
    readTokenHash: hash("reader-credential-for-runner-test"), writeTokenHash: hash("writer-credential-for-runner-test")
  })
  const options = {
    workspaceRoot: f.root, endpoint: "https://cache.test",
    readToken: () => "reader-credential-for-runner-test",
    writeToken: () => "writer-credential-for-runner-test",
    fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => handler(new Request(input, init)),
    warn: (line: string) => { throw new Error(line) }
  }
  // The unconfined fixture produces a local result. The real client seeds
  // the trusted service explicitly; the runner's publication guard is unchanged.
  const publisher = await openCache(options)
  await publisher.put(key, result!)
  expect(actionCache.entries.has(key)).toBe(true)
  expect(batches).toEqual(count === 520 ? [128, 128, 128, 128, 8] : [1])
  await Fs.rm(Path.join(f.root, ".flows"), { recursive: true, force: true })
  await Fs.rm(Path.join(f.root, "out"), { recursive: true })
  const second = await Effect.runPromise(executeEffect(f.plan, f.options).pipe(Effect.provideService(ExecutionServices, {
    ...executionServicesLive,
    cache: () => Effect.tryPromise(() => openCache(options))
  })))
  expect(second.ok, JSON.stringify(second.results)).toBe(true)
  expect(second.results).toMatchObject([{ label: "//:command", status: "hit" }])
  expect(await Fs.readFile(Path.join(f.root, "out/program"), "utf8")).toBe("artifact")
  expect((await Fs.stat(Path.join(f.root, "out/program"))).mode & 0o777).toBe(0o755)
  expect(await Fs.readFile(Path.join(f.root, "calls.log"), "utf8")).toBe("run")
  expect(await Fs.readdir(Path.join(f.root, "out"))).toHaveLength(count)
  for (let i = 1; i < count; i++) {
    expect(await Fs.readFile(Path.join(f.root, "out/file-" + i), "utf8")).toBe("artifact-" + i)
  }
})
