/** The command inventory is derived from the source registration chain. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

test("every registered build command has a linked reference section", () => {
  const source = read("build-cli/src/Cli.ts").split("const makeCommands = ")[1]
  assert.ok(source, "the build CLI command registration exists")
  const commands = [...source.matchAll(/^    \.command\("([^"]+)"/gm)].map((match) => match[1])
  commands.push("cache", "show")
  const docs = read("docs/reference/cli.md")
  assert.deepEqual(commands.filter((name) => !docs.includes(`[\`${name}\`](#`)), [], "registered commands missing from the reference inventory")
  for (const [, anchor] of docs.matchAll(/\[\`[^`]+\`\]\(#([^)]+)\)/g)) {
    assert.ok(docs.includes(`\n## ${anchor}\n`), `missing command section: ${anchor}`)
  }
})
