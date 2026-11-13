import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

describe("built artifacts", () => {
  it(
    "loads every published wildcard module in ESM and CJS without splitting root identity",
    () => {
      execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: packageRoot })
      const artifactRoot = mkdtempSync(join(packageRoot, ".artifacts-"))
      try {
        const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
        writeFileSync(
          join(artifactRoot, "package.json"),
          JSON.stringify({ name: manifest.name, type: manifest.type, exports: manifest.publishConfig.exports })
        )
        cpSync(join(packageRoot, "dist"), join(artifactRoot, "dist"), { recursive: true })
        const rootModules = Object.keys(manifest.publishConfig.exports)
          .filter((name) => ![".", "./package.json", "./index", "./BrowserOtel", "./NodeOtel"].includes(name))
          .map((name) => name.slice(2))
        for (const fixture of ["artifact-esm.mjs", "artifact-cjs.cjs"]) {
          cpSync(join(packageRoot, "test/fixtures", fixture), join(artifactRoot, fixture))
          execFileSync(process.execPath, [fixture, ...rootModules], { cwd: artifactRoot })
        }
      } finally {
        rmSync(artifactRoot, { recursive: true, force: true })
      }
    },
    180_000
  )
})
