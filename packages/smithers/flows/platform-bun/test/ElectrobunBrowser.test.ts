/**
 * The native port under the `browser` condition: a browser bundle of this
 * package resolves `#electrobun` to a module that refuses, never to Electrobun.
 */
import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { DesktopUnavailable } from "../src/BunDesktop.vibe"

it("resolves #electrobun for a browser to a module that refuses with DesktopUnavailable", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  expect(manifest.imports["#electrobun"]).toEqual({
    types: "./src/Electrobun.d.ts",
    browser: "./src/internal/ElectrobunUnavailable.ts",
    default: "electrobun/bun"
  })
  await expect(import("../src/internal/ElectrobunUnavailable.ts")).rejects.toBeInstanceOf(DesktopUnavailable)
})
