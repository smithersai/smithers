import { spawnShape } from "@smthrs/targets/Exec"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

it("ships every default template file in the npm tarball", () => {
  const templateFiles = readdirSync(join(packageRoot, "template/default"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(packageRoot, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort()
  const reference = readFileSync(join(packageRoot, "docs/reference/templates.md"), "utf8")
  const documentedCount = Number(reference.match(/\| Files copied\s*\| (\d+)/)?.[1])

  const destination = mkdtempSync(join(tmpdir(), "smithers-create-app-pack-"))
  try {
    const tarball = join(destination, "create-app.tgz")
    const command = spawnShape(["pnpm", "pack", "--out", tarball])
    const packed = spawnSync(command.file, [...command.args], {
      cwd: packageRoot,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      encoding: "utf8",
      timeout: 60_000,
      stdio: "pipe"
    })
    expect(packed.error).toBeUndefined()
    expect(packed.status, packed.stderr).toBe(0)
    const packedFiles = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", timeout: 10_000 })
      .trim().split("\n")
      .filter((path) => path.startsWith("package/template/default/") && !path.endsWith("/"))
      .map((path) => path.slice("package/".length))
      .sort()
    expect(packedFiles).toEqual(templateFiles)
    expect(packedFiles).toHaveLength(documentedCount)
  } finally {
    rmSync(destination, { recursive: true, force: true })
  }
}, 90_000)
