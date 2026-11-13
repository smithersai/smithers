import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { declaredRanges, lockfileProblems } from "./check-lockfile-parity.mjs"
import { repoRoot } from "../scripts/workspace-packages.mjs"

test("an optional peer named only in peerDependenciesMeta is a peer of any version, as Bun records it", () => {
  const pkg = {
    peerDependencies: { effect: "4.0.5", "@effect/sql-pg": "4.0.5" },
    peerDependenciesMeta: {
      "@effect/sql-pg": { optional: true },
      "@effect/sql-sqlite-node": { optional: true },
      "@effect/vitest": { optional: false }
    },
    dependencies: { undici: "8.11.2" }
  }
  assert.deepEqual(declaredRanges(pkg, "peerDependencies"), {
    effect: "4.0.5",
    "@effect/sql-pg": "4.0.5",
    "@effect/sql-sqlite-node": "*"
  })
  assert.deepEqual(declaredRanges(pkg, "dependencies"), { undici: "8.11.2" })
  assert.deepEqual(declaredRanges({}, "peerDependencies"), {})
  assert.deepEqual(declaredRanges({ peerDependenciesMeta: { a: { optional: true } } }, "devDependencies"), {})
})

// alchemy's declarations import @cloudflare/workers-types without depending on it, so they resolve pnpm's hoisted copy.
// Two locked versions let the install's order pick that copy: a clean install took the older one, whose Container has
// no "basic" instance, and apps/mvp's typecheck failed only there.
test("pnpm locks one @cloudflare/workers-types, the copy alchemy's declarations resolve", () => {
  const lock = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8")
  const versions = [...lock.matchAll(/^ {2}'@cloudflare\/workers-types@([^']+)':$/gm)].map((match) => match[1])
  assert.equal(new Set(versions).size, 1, `locked versions: ${[...new Set(versions)].join(", ")}`)
})

test("lockfile parity includes the root manifest, overrides, patches and retired members", () => {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
  const lock = {
    workspaces: { "": { devDependencies: root.devDependencies } },
    overrides: structuredClone(root.overrides),
    patchedDependencies: structuredClone(root.patchedDependencies)
  }
  assert.deepEqual(lockfileProblems(lock, []), [])
  for (const mutate of [
    (copy) => { delete copy.workspaces[""] },
    (copy) => { copy.workspaces[""].devDependencies.effect = "0.0.0" },
    (copy) => { copy.workspaces[""].devDependencies.retired = "1" },
    (copy) => { copy.overrides.effect = "0.0.0" },
    (copy) => { delete copy.overrides.effect },
    (copy) => { copy.overrides.retired = "1" },
    (copy) => { copy.overrides["vitest@5.0.0"]["happy-dom"] = "0.0.0" },
    (copy) => { delete copy.patchedDependencies[Object.keys(root.patchedDependencies)[0]] },
    (copy) => { copy.patchedDependencies[Object.keys(root.patchedDependencies)[0]] = "patches/wrong.patch" },
    (copy) => { copy.patchedDependencies.retired = "patches/retired.patch" },
    (copy) => { copy.workspaces["packages/retired"] = {} }
  ]) {
    const copy = structuredClone(lock)
    mutate(copy)
    assert.ok(lockfileProblems(copy, []).length > 0, String(mutate))
  }
  const reordered = structuredClone(lock)
  reordered.overrides = Object.fromEntries(Object.entries(reordered.overrides).reverse())
  assert.deepEqual(lockfileProblems(reordered, []), [])
})
