import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { jj, planNumbers, applyNumbers, checkNumbers, unique, decisions, migrations } from "./numbering.mjs"

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "devx-numbers-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  jj(root, ["git", "init", "."])
  jj(root, ["config", "set", "--repo", "user.name", "Devx Test"])
  jj(root, ["config", "set", "--repo", "user.email", "devx@example.invalid"])
  for (const path of [decisions, migrations]) mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(root, decisions, "0130-base.md"), "base\n")
  writeFileSync(join(root, migrations, "0075_base.ts"), "export default 75\n")
  writeFileSync(join(root, "apps/mvp/db/Database.ts"), 'import base from "./migrations/0075_base.ts"\nexport const migrations = { "0075_base": base }\n')
  writeFileSync(join(root, "apps/mvp/db/Database.test.ts"), 'test("existing", () => through("0076"))\n')
  jj(root, ["commit", "-m", "base"])
  jj(root, ["bookmark", "set", "published", "-r", "@-"])
  return root
}
function parallel(t) {
  const root = fixture(t)
  const base = jj(root, ["log", "-r", "published", "--no-graph", "-T", "commit_id"])
  writeFileSync(join(root, decisions, "0131-remote.md"), "remote\n")
  writeFileSync(join(root, migrations, "0076_remote.ts"), "export default 76\n")
  jj(root, ["commit", "-m", "remote"])
  jj(root, ["bookmark", "set", "published", "-r", "@-"])
  jj(root, ["new", base])
  writeFileSync(join(root, decisions, "0131-lane.md"), "# 0131: Lane\nSee 0131-lane.md and decision 0131 [0131].\n")
  writeFileSync(join(root, migrations, "0076_lane.ts"), "export default 76\n")
  writeFileSync(join(root, "apps/mvp/db/Database.ts"), 'import base from "./migrations/0075_base.ts"\nimport lane from "./migrations/0076_lane.ts"\nexport const migrations = { "0075_base": base, "0076_lane": lane }\n')
  writeFileSync(join(root, "apps/mvp/db/Database.test.ts"), 'test("existing", () => through("0076"))\ntest("0076_lane", () => { through("0075"); through("0076"); expect("76_lane") })\n')
  return root
}

test("repairs two parallel claims and only lane-added references; repeat is idempotent", (t) => {
  const root = parallel(t)
  const plan = planNumbers(root, "published")
  assert.deepEqual(plan.renames.map((entry) => entry.to), [`${decisions}/0132-lane.md`, `${migrations}/0077_lane.ts`])
  applyNumbers(root, plan)
  assert.equal(readFileSync(join(root, decisions, "0132-lane.md"), "utf8"), "# 0132: Lane\nSee 0132-lane.md and decision 0132 [0132].\n")
  assert.match(readFileSync(join(root, "apps/mvp/db/Database.ts"), "utf8"), /0077_lane/)
  assert.equal(readFileSync(join(root, "apps/mvp/db/Database.test.ts"), "utf8"), 'test("existing", () => through("0076"))\ntest("0077_lane", () => { through("0076"); through("0077"); expect("77_lane") })\n')
  assert.equal(existsSync(join(root, migrations, "0076_lane.ts")), false)
  assert.deepEqual(planNumbers(root, "published").renames, [])
  checkNumbers(root)
})

test("older noncolliding migration moves after published head; preserves relative order", (t) => {
  const root = fixture(t)
  const base = jj(root, ["log", "-r", "published", "--no-graph", "-T", "commit_id"])
  writeFileSync(join(root, migrations, "0079_remote.ts"), "remote\n")
  jj(root, ["commit", "-m", "remote"])
  jj(root, ["bookmark", "set", "published", "-r", "@-"])
  jj(root, ["new", base])
  for (const id of ["0076", "0077"]) writeFileSync(join(root, migrations, `${id}_lane.ts`), `// ${id}_lane\n`)
  const plan = planNumbers(root, "published")
  assert.deepEqual(plan.renames.map((entry) => entry.next), [80, 81])
  applyNumbers(root, plan)
  assert.equal(readFileSync(join(root, migrations, "0080_lane.ts"), "utf8"), "// 0080_lane\n")
  assert.equal(readFileSync(join(root, migrations, "0081_lane.ts"), "utf8"), "// 0081_lane\n")
})

test("refuses editing or deleting any published migration before writes", (t) => {
  const root = parallel(t)
  writeFileSync(join(root, migrations, "0075_base.ts"), "changed\n")
  assert.throws(() => planNumbers(root, "published"), /Published migration is immutable/)
  assert.equal(existsSync(join(root, decisions, "0132-lane.md")), false)
  rmSync(join(root, migrations, "0075_base.ts"))
  assert.throws(() => planNumbers(root, "published"), /Published migration is immutable/)
})

test("same-slug collision is still allocated without overwriting main", (t) => {
  const root = parallel(t)
  writeFileSync(join(root, migrations, "0076_remote.ts"), "incoming different body\n")
  rmSync(join(root, migrations, "0076_lane.ts"))
  const plan = planNumbers(root, "published")
  assert.equal(plan.renames.find((entry) => entry.directory === migrations).to, `${migrations}/0077_remote.ts`)
})

test("checks duplicates and missing registration, ignores migration test files", (t) => {
  assert.throws(() => unique([`${decisions}/0131-a.md`, `${decisions}/0131-b.md`], decisions), /Duplicate/)
  unique([`${migrations}/0075_a.ts`, `${migrations}/0075_a.test.ts`], migrations)
  const root = fixture(t)
  writeFileSync(join(root, migrations, "0076_missing.ts"), "unregistered\n")
  assert.throws(() => checkNumbers(root), /Unregistered migration/)
})

test("allocation refuses an already duplicated target", (t) => {
  const root = fixture(t)
  writeFileSync(join(root, decisions, "0130-duplicate.md"), "duplicate\n")
  jj(root, ["bookmark", "set", "published", "-r", "@"])
  assert.throws(() => planNumbers(root, "published"), /Duplicate/)
})

test("historical comparison appendices and the two published 0038 records stay readable", () => {
  unique([`${decisions}/0002-local-first.md`, `${decisions}/0002-local-first-comparison.md`], decisions)
  unique([`${decisions}/0038-todo-retry.md`, `${decisions}/0038-offline-branch-conversations.md`], decisions)
  assert.throws(() => unique([`${decisions}/0038-todo-retry.md`, `${decisions}/0038-new.md`], decisions), /Duplicate/)
})

test("the repository has no new duplicate numbers or unregistered migrations", () => {
  checkNumbers(resolve(import.meta.dirname, "../../.."))
})


test("renumbering never follows a changed symlink outside its workspace", (t) => {
  const root = parallel(t)
  const outside = join(root, ".jj", "other-source.txt")
  writeFileSync(outside, "See 0076_lane\n")
  symlinkSync(outside, join(root, "linked-reference.txt"))
  const plan = planNumbers(root, "published")
  assert.throws(() => applyNumbers(root, plan), /symlink/)
  assert.equal(readFileSync(outside, "utf8"), "See 0076_lane\n")
  assert.equal(existsSync(join(root, migrations, "0076_lane.ts")), true)
})
