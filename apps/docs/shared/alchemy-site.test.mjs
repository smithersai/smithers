import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { findLegacyEnvState, makeDocsSiteStack } from "./alchemy-site.mjs"

const secret = "sk-fixture-secret-value-0123456789"

/** A site directory under a temp dir, with state files written relative to it. */
const site = (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "smithers-alchemy-site-")))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const write = (rel, value) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), JSON.stringify(value))
  }
  return { dir, write }
}

const legacyBuild = {
  kind: "os::Exec",
  props: { command: "pnpm run build", env: { OPENAI_API_KEY: secret, PATH: "/usr/bin" } },
  output: { command: "pnpm run build", env: { OPENAI_API_KEY: secret, PATH: "/usr/bin", HOME: "/home/x" } }
}

test("Alchemy 1 os::Exec state with an embedded environment is reported by path and count", (t) => {
  const { dir, write } = site(t)
  write(".alchemy/smithers-docs-x/user/smithers-docs-x-build.json", legacyBuild)
  assert.deepEqual(findLegacyEnvState(dir), [
    { file: join(".alchemy", "smithers-docs-x", "user", "smithers-docs-x-build.json"), variables: 3 }
  ])
})

test("the stack factory refuses legacy env state without echoing a value", (t) => {
  const { dir, write } = site(t)
  write(".alchemy/smithers-docs-x/user/smithers-docs-x-build.json", legacyBuild)
  process.env.X_WORKER_NAME = "x-worker"
  t.after(() => delete process.env.X_WORKER_NAME)
  assert.throws(
    () => makeDocsSiteStack({ slug: "x", dir }),
    (error) => {
      assert.match(error.message, /smithers-docs-x-build\.json \(3 variables\)/)
      assert.match(error.message, /rotate/)
      assert.ok(!error.message.includes(secret))
      assert.ok(!error.message.includes("OPENAI_API_KEY"))
      return true
    }
  )
})

test("Alchemy 2 build state holding only command and outdir passes", (t) => {
  const { dir, write } = site(t)
  write(".alchemy/state/smithers-docs-x/dev/build.json", { props: { command: "pnpm run build", outdir: "dist" }, output: { outdir: "dist" } })
  write(".alchemy/state/broken.json", "not json")
  assert.deepEqual(findLegacyEnvState(dir), [])
})

test("a site without .alchemy passes", (t) => {
  const { dir } = site(t)
  assert.deepEqual(findLegacyEnvState(dir), [])
})
