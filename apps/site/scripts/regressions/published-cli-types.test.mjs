import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

test("se4-npm-4: an installed CLI import passes strict declaration checking", {
  timeout: 180_000,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-cli-types-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }))
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "@smthrs/cli@1.0.0-rc.16", "typescript@5.9.3", "@types/node@22"], { cwd: dir, stdio: "pipe", timeout: 120_000 })
  writeFileSync(join(dir, "consumer.ts"), 'import { Command } from "@smthrs/cli";\nexport const command = Command;\n')
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: ["node"],
  }, files: ["consumer.ts"] }))
  const result = spawnSync(process.execPath, [join(dir, "node_modules/typescript/bin/tsc"), "-p", dir], { cwd: dir, encoding: "utf8", timeout: 45_000 })
  assert.equal(result.error, undefined)
  if (result.status !== 0) {
    assert.match(result.stdout, /Cannot find name '_args'/, "an installation or unrelated compiler failure is not the known declaration defect")
    assert.match(result.stdout, /Cannot find name '_options'/)
  }
  await t.test("all shipped declarations pass strict checking", {
    todo: "NEEDS-DECISION: incur through 0.7.1 retains unbound generics; a local pnpm patch does not fix npm consumers.",
  }, () => assert.equal(result.status, 0, result.stdout))
})
