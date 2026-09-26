import assert from "node:assert/strict"
import { test } from "node:test"
import { parseScripts } from "../scripts/scripts.mjs"
test("Markdown grammar rejects unsupported instructions and escaping recording IDs", () => {
  const source = "```tui-script addition\nType \"fix\"\nPress Enter\nWait for \"Fixed\"\nCapture \"done\"\n```"
  assert.equal(parseScripts(source)[0].steps.length, 4)
  assert.throws(() => parseScripts(source.replace("Press Enter", "Run rm -rf /")), /Invalid recording instruction/)
  assert.throws(() => parseScripts(source.replace("addition", "../elsewhere")), /Invalid recording id/)
  assert.throws(() => parseScripts(source.replace("Capture \"done\"\n", "")), /needs Capture/)
})
