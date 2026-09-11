import { afterEach, describe, expect, test } from "bun:test"
import { constants } from "node:fs"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PackagedFixtureRun } from "./FixtureRun"

const roots: Array<string> = []

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "smithers-fixture-run-test-"))
  roots.push(root)
  return root
}

const exists = (path: string): Promise<boolean> => access(path, constants.F_OK).then(() => true, () => false)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("the packaged E2E fixture lease", () => {
  test("removes a test directory before clearing its marker and accepts the next test", async () => {
    const registry = await scratch()
    const run = await PackagedFixtureRun.start({ registryDirectory: registry })
    const first = await run.beginTest("first")
    const payload = await first.makeDirectory("payload")
    await writeFile(join(payload, "value.txt"), "real fixture data")

    expect(await exists(join(registry, "active", "active-test.json"))).toBe(true)
    expect(await readFile(join(payload, "value.txt"), "utf8")).toBe("real fixture data")
    await first.cleanup()
    expect(await exists(first.directory)).toBe(false)
    expect(await exists(join(registry, "active", "active-test.json"))).toBe(false)

    const second = await run.beginTest("second")
    await second.cleanup()
    await run.cleanup()
    expect(await exists(join(registry, "active"))).toBe(false)
    expect(await exists(registry)).toBe(false)
  })

  test("refuses to start a new test when the prior test never cleaned up", async () => {
    const registry = await scratch()
    const run = await PackagedFixtureRun.start({ registryDirectory: registry })
    const leaked = await run.beginTest("leaked test")

    await expect(run.beginTest("must not run")).rejects.toThrow("cleanup never completed for prior test")
    await leaked.cleanup()
    await run.cleanup()
  })

  test("rejects a concurrent live suite without touching its fixtures", async () => {
    const registry = await scratch()
    const first = await PackagedFixtureRun.start({ registryDirectory: registry })
    const fixture = await first.beginTest("live")
    await writeFile(join(fixture.directory, "sentinel"), "keep")

    await expect(PackagedFixtureRun.start({ registryDirectory: registry })).rejects.toThrow(
      "Another packaged E2E run is active"
    )
    expect(await readFile(join(fixture.directory, "sentinel"), "utf8")).toBe("keep")
    await fixture.cleanup()
    await first.cleanup()
  })

  test("preserves an initializing or unreadable owner regardless of recovery permission", async () => {
    for (const allowStaleRecovery of [false, true]) {
      for (const leaseText of [undefined, "not json"]) {
        const registry = await scratch()
        const work = join(registry, "active", "work")
        await mkdir(work, { recursive: true })
        await writeFile(join(work, "sentinel"), "keep")
        if (leaseText !== undefined) await writeFile(join(registry, "active", "lease.json"), leaseText)
        await expect(PackagedFixtureRun.start({
          registryDirectory: registry, allowStaleRecovery, isProcessAlive: () => false
        })).rejects.toThrow()
        expect(await readFile(join(work, "sentinel"), "utf8")).toBe("keep")
      }
    }
  })

  test("20 simultaneous acquisitions leave exactly one live owner intact", async () => {
    for (const allowStaleRecovery of [false, true]) {
      const registry = await scratch()
      const results = await Promise.allSettled(Array.from({ length: 20 }, () =>
        PackagedFixtureRun.start({ registryDirectory: registry, allowStaleRecovery })))
      const owners = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
      expect(owners).toHaveLength(1)
      const owner = owners[0]!
      const fixture = await owner.beginTest("winning owner")
      await writeFile(join(fixture.directory, "sentinel"), "keep")
      const lease = JSON.parse(await readFile(join(registry, "active", "lease.json"), "utf8"))
      expect(lease.runId).toBe(owner.runId)
      expect(await readFile(join(fixture.directory, "sentinel"), "utf8")).toBe("keep")
      await fixture.cleanup()
      await owner.cleanup()
    }
  })

  test("reports a crashed prior suite without deleting it unless recovery is enabled", async () => {
    const registry = await scratch()
    const artifacts = join(registry, "artifacts")
    const crashed = await PackagedFixtureRun.start({ registryDirectory: registry })
    const leaked = await crashed.beginTest("process was killed")
    await writeFile(join(leaked.directory, "orphan"), "stale")

    await expect(PackagedFixtureRun.start({
      registryDirectory: registry,
      artifactsDirectory: artifacts,
      isProcessAlive: () => false
    })).rejects.toThrow("Detected an unclean prior packaged E2E run")
    expect(await readFile(join(leaked.directory, "orphan"), "utf8")).toBe("stale")
    expect((await Array.fromAsync(new Bun.Glob("stale-fixture.*.json").scan(artifacts))).length).toBe(1)

    const clean = await PackagedFixtureRun.start({
      registryDirectory: registry, allowStaleRecovery: true, isProcessAlive: () => false
    })
    expect(await exists(leaked.directory)).toBe(false)
    await expect(crashed.cleanup()).rejects.toThrow("does not own")
    expect(await exists(clean.workDirectory)).toBe(true)
    await clean.cleanup()
  })

  test("concurrent recovery retires only the inspected generation", async () => {
    const registry = await scratch()
    const crashed = await PackagedFixtureRun.start({ registryDirectory: registry })
    const leasePath = join(registry, "active", "lease.json")
    const lease = JSON.parse(await readFile(leasePath, "utf8"))
    lease.pid = 99999999
    await writeFile(leasePath, JSON.stringify(lease))
    const results = await Promise.allSettled(Array.from({ length: 20 }, () =>
      PackagedFixtureRun.start({
        registryDirectory: registry, allowStaleRecovery: true,
        isProcessAlive: (pid) => pid !== lease.pid
      })))
    const owners = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
    expect(owners).toHaveLength(1)
    const owner = owners[0]!
    expect(owner.runId).not.toBe(crashed.runId)
    expect(JSON.parse(await readFile(leasePath, "utf8")).runId).toBe(owner.runId)
    expect(await exists(owner.workDirectory)).toBe(true)
    await owner.cleanup()
  })
})
