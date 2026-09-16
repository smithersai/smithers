import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

const script = resolve(import.meta.dirname, "coding-check.sh")
const fixture = (mode) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coding-bootstrap-")))
  writeFileSync(join(root, "bun"), `#!/bin/sh
echo "$*" >> "$FIXTURE/install.log"
echo "$BUN_INSTALL_CACHE_DIR" >> "$FIXTURE/cache.log"
case "$MODE" in
  fail) exit 23 ;;
  stall) exec sleep 30 ;;
  retry) if [ ! -f "$FIXTURE/retried" ]; then touch "$FIXTURE/retried"; exec sleep 30; fi ;;
esac
`, { mode: 0o755 })
  writeFileSync(join(root, "node"), '#!/bin/sh\necho "$*" > "$FIXTURE/check.log"\n', { mode: 0o755 })
  const result = spawnSync("sh", [script, "//flows:codingNative"], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, FIXTURE: root, MODE: mode,
      SMITHERS_CHECK_INSTALL_TIMEOUT: "1s", BUN_INSTALL_CACHE_DIR: join(tmpdir(), "persistent-bun-cache") }
  })
  const attempts = readFileSync(join(root, "install.log"), "utf8").trim().split("\n")
  const checked = existsSync(join(root, "check.log")) ? readFileSync(join(root, "check.log"), "utf8").trim() : null
  const caches = readFileSync(join(root, "cache.log"), "utf8").trim().split("\n")
  rmSync(root, { recursive: true, force: true })
  assert.equal(result.error, undefined)
  assert.ok(attempts.every(args => args === "install --frozen-lockfile"))
  assert.ok(caches.every(cache => cache === join(root, "node_modules/.cache/smithers-bun")),
    "every install, including retries, must use the disposable export instead of an inherited persistent cache")
  return { result, attempts, checked }
}

test("a stalled install is terminated and retried before the requested check", () => {
  const { result, attempts, checked } = fixture("retry")
  assert.equal(result.status, 0)
  assert.equal(attempts.length, 2)
  assert.match(result.stderr, /timed out; retrying once/)
  assert.equal(checked, "packages/smithers/build/build-cli/src/main.js test //flows:codingNative")
})

test("a second stalled install fails without running checks", () => {
  const { result, attempts, checked } = fixture("stall")
  assert.equal(result.status, 124)
  assert.equal(attempts.length, 2)
  assert.equal(checked, null)
})

test("ordinary install failures retain their status without retry or checks", () => {
  const { result, attempts, checked } = fixture("fail")
  assert.equal(result.status, 23)
  assert.equal(attempts.length, 1)
  assert.equal(checked, null)
})
