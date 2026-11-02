import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { declaredRanges } from "./check-lockfile-parity.mjs"
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
