import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { spawnNodeSync } from "./support/node-child.ts"

it("keeps discovering when a new build changes the poll callback source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-health-build-"))
  try {
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir")
    const source = await readFile(new URL("../src/internal/HealthHost.ts", import.meta.url), "utf8")
    const changed = source.replace(
      "({ attempt }) => Discover.call({ attempt })",
      "({ attempt }) => Discover.call({ attempt: attempt + 0 })"
    )
    expect(changed).not.toBe(source)
    const firstModule = join(directory, "first.ts")
    const secondModule = join(directory, "second.ts")
    const relocatedModule = join(directory, "relocated.ts")
    await writeFile(firstModule, source)
    await writeFile(secondModule, changed)
    await writeFile(relocatedModule, source)
    const host = (modulePath: string, advanceMs = 0): { outcome: string; roots: string[] } => {
      const child = spawnNodeSync([
        "--no-warnings",
        "--import",
        "vibelang/register",
        fileURLToPath(new URL("./fixtures/health-discovery-build.ts", import.meta.url)),
        join(directory, "engine.db"),
        modulePath,
        String(advanceMs)
      ], { encoding: "utf8", timeout: 180_000 })
      expect(child.error).toBeUndefined()
      expect(child.status, child.stderr).toBe(0)
      return JSON.parse(child.stdout)
    }
    const first = host(firstModule)
    expect(first.outcome).toBe("scanned")
    expect(first.roots).toHaveLength(1)
    const relocated = host(relocatedModule)
    expect(relocated.outcome).toBe("scanned")
    expect(relocated.roots).toEqual(first.roots)
    const second = host(secondModule, 60_000)
    expect(second.outcome).toBe("scanned")
    expect(second.roots).toHaveLength(2)
    expect(second.roots).toContain(first.roots[0])
    const restarted = host(secondModule, 60_000)
    expect(restarted.outcome).toBe("scanned")
    expect(restarted.roots).toEqual(second.roots)
    const rolledBack = host(firstModule)
    expect(rolledBack.outcome).toBe("scanned")
    expect(rolledBack.roots).toEqual(second.roots)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 240_000)
