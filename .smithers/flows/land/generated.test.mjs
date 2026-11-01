import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { jj, migrations } from "./numbering.mjs"
import { captureGenerated, repairGenerated, mergeHistory, databaseTemplate, migrationManifest, checkManifest, databasePath, schemaPath, manifestPath } from "./generated.mjs"

const db = (id) => `import x from "./migrations/${id}_test.ts"\nimport { Effect } from "effect"\n\n/** Every migration in \`db/migrations\`, by \`<id>_<name>\`. */\nexport const migrations = {\n  "${id}_test": x,\n}\n\nexport const migrate = Effect.succeed(migrations)\n`
const lock = (stores, epoch = 100) => JSON.stringify({ epoch, stores, payloads: {}, mutations: ["ask"] })
const entry = (value) => ({ kind: "synced", versions: { 1: value } })

test("three-way merges independent stores, upgrades and mutation removals without an epoch conflict", () => {
  assert.deepEqual(mergeHistory({ stores: { a: entry("a") } }, { stores: { a: entry("a"), b: entry("b") } }, { stores: { a: { kind: "synced", versions: { 1: "a", 2: "new" } } } }),
    { stores: { a: { kind: "synced", versions: { 1: "a", 2: "new" } }, b: entry("b") } })
  assert.deepEqual(mergeHistory({ mutations: ["ask", "save"] }, { mutations: ["ask"] }, { mutations: ["ask", "save", "steer"] }), { mutations: ["ask", "steer"] })
  assert.equal(mergeHistory("base", "local", "base"), "local")
  assert.equal(mergeHistory("base", "base", "remote"), "remote")
  assert.throws(() => mergeHistory({ a: "old" }, { a: "left" }, { a: "right" }), /lock.a/)
  assert.throws(() => mergeHistory({ a: "old" }, {}, { a: "right" }), /lock.a/)
})

test("rebasing two real lanes repairs only generated database/lock conflicts", (t) => {
  const root = mkdtempSync(join(tmpdir(), "devx-generated-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  jj(root, ["git", "init", "."])
  jj(root, ["config", "set", "--repo", "user.name", "Devx"])
  jj(root, ["config", "set", "--repo", "user.email", "devx@example.invalid"])
  mkdirSync(join(root, migrations), { recursive: true })
  mkdirSync(join(root, "apps/mvp/src/device"), { recursive: true })
  writeFileSync(join(root, migrations, "0001_test.ts"), "export default 1\n")
  writeFileSync(join(root, databasePath), db("0001"))
  writeFileSync(join(root, schemaPath), lock({ a: entry("a") }))
  jj(root, ["commit", "-m", "base"])
  const base = jj(root, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])
  writeFileSync(join(root, migrations, "0002_test.ts"), "export default 2\n")
  writeFileSync(join(root, databasePath), db("0002"))
  writeFileSync(join(root, schemaPath), lock({ a: entry("a"), remote: entry("r") }, 101))
  jj(root, ["commit", "-m", "remote"])
  jj(root, ["bookmark", "set", "published", "-r", "@-"])
  jj(root, ["new", base])
  writeFileSync(join(root, migrations, "0003_test.ts"), "export default 3\n")
  writeFileSync(join(root, databasePath), db("0003"))
  writeFileSync(join(root, schemaPath), lock({ a: entry("a"), lane: entry("l") }, 101))
  const context = captureGenerated(root, "published")
  jj(root, ["rebase", "-r", "@", "-d", "published"])
  assert.ok(jj(root, ["log", "-r", "@ & conflicts()", "--no-graph", "-T", "commit_id"]))
  repairGenerated(root, context)
  assert.equal(jj(root, ["log", "-r", "@ & conflicts()", "--no-graph", "-T", "commit_id"]), "")
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, schemaPath), "utf8")).stores), ["a", "lane", "remote"])
  assert.equal("epoch" in JSON.parse(readFileSync(join(root, schemaPath), "utf8")), false)
  const source = readFileSync(join(root, manifestPath), "utf8")
  assert.ok(source.indexOf('"0001_test":') < source.indexOf('"0002_test":'))
  assert.ok(source.indexOf('"0002_test":') < source.indexOf('"0003_test":'))
  assert.match(readFileSync(join(root, databasePath), "utf8"), /MigrationManifest/)
  checkManifest(root)
  writeFileSync(join(root, migrations, "0004_new.ts"), "new\n")
  assert.throws(() => checkManifest(root), /drift/)
  const bad = structuredClone(context)
  bad.files[databasePath].local += "export const local = 1\n"
  bad.files[databasePath].remote += "export const remote = 1\n"
  const before = readFileSync(join(root, databasePath), "utf8")
  assert.throws(() => repairGenerated(root, bad), /services changed on both sides/)
  assert.equal(readFileSync(join(root, databasePath), "utf8"), before)
})

test("canonical registration is independent of directory order, ignores tests, and rejects collisions", () => {
  assert.equal(migrationManifest(["0002_b.ts", "0001_a.ts", "0001_a.test.ts"]), migrationManifest(["0001_a.ts", "0002_b.ts"]))
  assert.throws(() => migrationManifest(["0001_a.ts", "0001_b.ts"]), /Duplicate/)
  assert.equal(databaseTemplate(db("0001")), databaseTemplate(db("0002")))
  checkManifest(resolve(import.meta.dirname, "../../.."))
})
