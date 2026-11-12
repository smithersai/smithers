import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// An installed consumer, outside the workspace: root exports from main cannot
// conceal a missing export in the release the quickstart tells people to use.
test("se4-npm-2: the published rc.16 quickstart runs and replays from SQLite", { timeout: 180_000 }, t => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-quickstart-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }))
  const guide = readFileSync(new URL("../../../../packages/smithers/flows/docs/quickstart.md", import.meta.url), "utf8")
  const install = guide.match(/^npm install ([^\n]+)/m)[1].split(/\s+/)
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...install], { cwd: dir, stdio: "pipe", timeout: 120_000 })
  const blocks = [...guide.matchAll(/^```ts\n([\s\S]*?)^```/gm)].map(match => match[1])
  assert.equal(blocks.length, 4)
  mkdirSync(join(dir, "workspace"))
  writeFileSync(join(dir, "workspace/note.txt"), "the note\n")
  const program = join(dir, "main.mjs")
  writeFileSync(program, blocks.join("\n"))
  const run = () => execFileSync(process.execPath, [program], { cwd: dir, encoding: "utf8", timeout: 45_000 })
  const first = run()
  assert.match(first, /the note/)
  writeFileSync(join(dir, "workspace/note.txt"), "changed note\n")
  assert.equal(run(), first)
})
