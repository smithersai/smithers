import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import type { Ci } from "../../src/contract/Inventory.ts"
import { Inventory } from "../../src/contract/Inventory.ts"
import { files } from "../../src/generate/index.ts"
import { workflowPath } from "../../src/generate/Render.ts"

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
const bin = fileURLToPath(new URL("../../bin/smithers-ci.mjs", import.meta.url))

const made: Array<string> = []
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true })
})

describe("the executable in an install", () => {
  it("runs the built program, even inside a stranger's pnpm workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-ci-install-"))
    made.push(root)
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n")
    const installed = join(root, "node_modules", "smithers-ci")
    const cli = join(installed, "dist", "esm", "cli")
    mkdirSync(join(installed, "bin"), { recursive: true })
    mkdirSync(cli, { recursive: true })
    cpSync(bin, join(installed, "bin", "smithers-ci.mjs"))
    writeFileSync(join(installed, "package.json"), "{\"type\":\"module\"}\n")
    writeFileSync(
      join(cli, "main.js"),
      "export const main = async (args) => { console.log('built', args[0]); return 7 }\n"
    )
    writeFileSync(join(cli, "Signals.js"), "export const listenTo = () => undefined\n")
    // The program asks this module for its environment before it runs anything.
    writeFileSync(join(cli, "Restart.js"), "export const own = async (program) => ({ ...program.env })\n")
    const result = spawnSync(process.execPath, [join(installed, "bin", "smithers-ci.mjs"), "inventory"], {
      cwd: root,
      encoding: "utf8"
    })
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("built inventory\n")
    expect(result.status).toBe(7)
  })
})

describe("the workflow apply writes", () => {
  it("installs this release of smithers-ci and the @smthrs/cli it was released with", () => {
    const document = JSON.parse(
      readFileSync(new URL("../fixtures/inventory.justfile-zig.json", import.meta.url), "utf8")
    )
    const generated = Effect.runSync(files(Schema.decodeUnknownSync(Inventory)(document) as Ci))
    const workflow = generated.find((file) => file.path === workflowPath)?.content
    expect(manifest.dependencies["@smthrs/cli"]).toBe(manifest.version)
    expect(workflow).toContain(`npx --yes --package=@smthrs/cli@${manifest.version} smthrs ci `)
    // Its first step checks the generated files with this same release.
    expect(workflow).toContain(`npx --yes --package=smithers-ci@${manifest.version} smithers-ci apply --check`)
  })
})
