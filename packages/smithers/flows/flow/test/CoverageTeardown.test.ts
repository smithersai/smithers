import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { TestProject } from "vitest/node"
import { setup } from "./CoverageTeardown.ts"

const projectWith = (reportsDirectory: string): TestProject =>
  ({ vitest: { config: { coverage: { reportsDirectory } } } }) as unknown as TestProject

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

describe("CoverageTeardown", () => {
  it("removes a scratch report under the OS temp directory after the run", async () => {
    const reportsDirectory = await mkdtemp(join(tmpdir(), "flows-flow-coverage-"))
    await writeFile(join(reportsDirectory, "coverage-final.json"), "{}")
    const teardown = setup(projectWith(reportsDirectory))
    expect(await exists(reportsDirectory)).toBe(true)
    await teardown()
    expect(await exists(reportsDirectory)).toBe(false)
  })

  it("keeps a report written anywhere else", async () => {
    const reportsDirectory = join(import.meta.dirname, "..", "coverage", `keep-probe-${process.pid}`)
    await mkdir(reportsDirectory, { recursive: true })
    try {
      await setup(projectWith(reportsDirectory))()
      expect(await exists(reportsDirectory)).toBe(true)
    } finally {
      await rm(reportsDirectory, { recursive: true, force: true })
    }
  })

  it("tolerates a scratch report that was never written", async () => {
    await expect(setup(projectWith(join(tmpdir(), `flows-flow-coverage-missing-${process.pid}`)))()).resolves
      .toBeUndefined()
  })
})
