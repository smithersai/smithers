import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { jj } from "./numbering.mjs"
import { run } from "./stranded.mjs"

/** A real jj repo with an origin: main, a landed-by-squash lane, a stranded lane and a superseded lane. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "stranded-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, "root")
  mkdirSync(root)
  jj(root, ["git", "init", "."])
  for (const [key, value] of [["user.name", "Devx"], ["user.email", "devx@example.invalid"]]) jj(root, ["config", "set", "--repo", key, value])
  const write = (path, text) => writeFileSync(join(root, path), text)
  write("app.ts", "export const base = 'the base line of the app'\n")
  jj(root, ["commit", "-m", "base"])
  const base = jj(root, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"])
  // Lane A: its content later landed on main under another subject.
  write("landed.ts", "export const landed = 'squashed onto main by a lander'\n")
  jj(root, ["commit", "-m", "lane a"])
  // Lane B, from base: never landed.
  jj(root, ["new", base])
  write("stranded.ts", "export const stranded = 'work nobody landed yet'\n")
  jj(root, ["commit", "-m", "lane b"])
  // Lane C, from base: main carried it, then replaced it.
  jj(root, ["new", base])
  write("app.ts", "export const base = 'the base line of the app'\nexport const replaced = 'first version of the feature'\n")
  jj(root, ["commit", "-m", "lane c"])
  // Main: lands A's content, carries C's line, then replaces it.
  jj(root, ["new", base])
  write("landed.ts", "export const landed = 'squashed onto main by a lander'\n")
  write("app.ts", "export const base = 'the base line of the app'\nexport const replaced = 'first version of the feature'\n")
  jj(root, ["commit", "-m", "main squash"])
  write("app.ts", "export const base = 'the base line of the app'\nexport const replaced = 'second version, deliberately'\n")
  jj(root, ["commit", "-m", "main rewrite"])
  jj(root, ["bookmark", "set", "main", "-r", "@-"])
  const remote = join(directory, "remote")
  jj(directory, ["git", "clone", root, remote])
  jj(root, ["git", "remote", "add", "origin", remote])
  jj(root, ["git", "fetch", "--remote", "origin"])
  jj(root, ["bookmark", "track", "main@origin"])
  jj(root, ["new", "main@origin"])
  return { root, directory }
}

test("classifies by content: landed under another subject, stranded, superseded by main", async (t) => {
  const { root, directory } = fixture(t)
  const report = await run({ repo: root, tree: root, exclude: [], jobs: "2", json: join(directory, "out.json"), md: join(directory, "out.md") })
  const bySubject = Object.fromEntries(report.results.map((r) => [r.subject, r]))
  assert.equal(bySubject["lane a"].class, "ON-MAIN")
  assert.equal(bySubject["lane b"].class, "STRANDED")
  assert.match(bySubject["lane b"].gaps.join(), /stranded\.ts/)
  assert.equal(bySubject["lane c"].class, "SUPERSEDED")
  assert.match(bySubject["lane c"].evidence.join(), /main rewrite/)
  const strandedHead = report.stacks.find((s) => s.memberIds === undefined && s.net.files.some((f) => f.startsWith("stranded.ts")))
  assert.ok(strandedHead, "the stranded head's net diff names its missing file")
})
