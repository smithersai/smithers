import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { projection } from "../sync-app-docs.mjs"

test("sd4-missing-2: every core slash door has a published command row", () => {
  const text = projection().get("apps/site/public/docs/commands.md")
  assert.ok(text, "command reference is published")
  const registry = readFileSync(new URL("../../../mvp/src/flows/registry.ts", import.meta.url), "utf8")
  for (const [, name, minimum] of registry.matchAll(/slash:\s*\{\s*command: "([^"]+)"[\s\S]*?minimum: "([^"]+)"/g)) {
    const row = text.split("\n").find(line => line.startsWith(`| \`/${name}\``))
    assert.ok(row, name)
    assert.ok(row.includes(minimum === "anyone" ? "Anyone" : minimum[0].toUpperCase()+minimum.slice(1)), name+" role")
  }
  for (const name of ["queue", "bug", "bugs"]) assert.ok(text.includes(`\`/${name}\``), name)
})
