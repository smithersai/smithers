import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { readWorkspaceInventory } from "./readWorkspaceInventory.ts"

/**
 * Quickstarts with no VibeLang tab, each with its reason: the page shows only
 * commands or declaration data, the example cannot import what it shows, or
 * the tab waits on a named issue. A package leaves this list once its
 * quickstart can run in VibeLang.
 */
const exemptQuickstarts = new Map<string, string>([
  ["smithers", "a CLI walkthrough; the only code is the starter flow `smthrs init --vibe` writes"],
  ["smithers/build/build-cli", "its only code is WORKSPACE.ts and PACKAGE.ts declaration data"],
  ["smithers/gateway", "a CLI walkthrough: `smthrs serve`, curl and a WebSocket client"],
  ["smithers/migrate", "a CLI walkthrough: `smithers-migrate` and `smthrs` commands only"],
  [
    "smithers/flows/time-travel",
    "its quickstart runs through `@smthrs/flows`, which depends on this package, so a compiled example would be a cycle"
  ],
  ["testing", "blocked by #4968: the conformance suite its quickstart runs fails three race pins on main"]
])

const vibeExample = /example:\s*\w+\.file\("((?:[^"]+\/)?examples\/[^"]+\.vibe)"\)/

describe("quickstart VibeLang tabs", () => {
  const { packagesDir, packages } = readWorkspaceInventory()
  const withQuickstart = packages.filter((name) => existsSync(join(packagesDir, name, "docs/quickstart.md")))

  it("finds the package quickstarts", () => {
    assert.ok(withQuickstart.length >= 40, `found ${withQuickstart.length}`)
  })

  for (const name of withQuickstart) {
    it(`${name} shows its quickstart in VibeLang beside TypeScript, held by its docs target`, () => {
      const exempt = exemptQuickstarts.get(name)
      const declaration = readFileSync(join(packagesDir, name, "PACKAGE.ts"), "utf8")
      const match = vibeExample.exec(declaration)
      if (exempt !== undefined) {
        assert.equal(match, null, `${name} now declares a VibeLang example; remove it from the exemptions`)
        return
      }
      assert.ok(
        match !== null,
        `${name}/PACKAGE.ts declares no VibeLang page example: pass examples: [{ page, example, test }] ` +
          "to BuildAndCheckTypeScriptPackage with a .vibe example under examples/"
      )
      assert.ok(existsSync(join(packagesDir, name, match[1]!)), `${name}/${match[1]} does not exist`)
    })
  }
})
