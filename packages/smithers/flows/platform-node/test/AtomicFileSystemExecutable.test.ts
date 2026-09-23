import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveDefaultExecutable } from "../src/internal/AtomicFileSystemExecutable.ts"

const roots: Array<string> = []
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atomic-executable-")))
  roots.push(root)
  const packageRoot = join(root, "packages/smithers/flows/platform-node")
  await mkdir(packageRoot, { recursive: true })
  return { root, packageRoot }
}
const helper = async (path: string) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, "#!/bin/sh\nexit 0\n")
  await chmod(path, 0o755)
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe("default atomic helper resolution", () => {
  it("uses the helper shipped in the installed platform package", async () => {
    const { packageRoot, root } = await fixture()
    const binary = join(packageRoot, "bin", `${process.platform}-${process.arch}`, "smithers-jj-export")
    await mkdir(dirname(binary), { recursive: true })
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o644 })
    const selected = resolveDefaultExecutable(packageRoot, join(root, "workspace"), join(root, "absent"))
    expect(selected).not.toBe(binary)
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  it("pins an installed helper outside a confined project", async () => {
    const { packageRoot, root } = await fixture()
    const binary = join(packageRoot, "bin", `${process.platform}-${process.arch}`, "smithers-jj-export")
    await helper(binary)
    const selected = resolveDefaultExecutable(packageRoot, root, join(root, "absent"))
    expect(selected.startsWith(`${root}/`)).toBe(false)
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  it("uses a release build from a source checkout", async () => {
    const { packageRoot, root } = await fixture()
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n")
    const binary = join(root, "target/release/smithers-jj-export")
    await helper(binary)
    expect(resolveDefaultExecutable(packageRoot, join(root, "flows"), join(root, "absent"))).toBe(binary)
  })

  it("pins a checkout helper outside a confined project", async () => {
    const { packageRoot, root } = await fixture()
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n")
    const binary = join(root, "target/release/smithers-jj-export")
    await helper(binary)
    const selected = resolveDefaultExecutable(packageRoot, root, join(root, "absent"))
    expect(selected.startsWith(`${root}/`)).toBe(false)
    expect(await readFile(selected, "utf8")).toBe("#!/bin/sh\nexit 0\n")
  })

  it("names the build and configuration fix when no helper exists", async () => {
    const { packageRoot, root } = await fixture()
    expect(() => resolveDefaultExecutable(packageRoot, join(root, "workspace"), join(root, "absent")))
      .toThrow(/cargo build.*SMITHERS_WORKSPACE_JJ_EXPORT_BINARY/)
  })
})
