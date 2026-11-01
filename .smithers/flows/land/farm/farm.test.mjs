import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { install, files } from "./install.mjs"
const here = import.meta.dirname
const run = (command, args, extra = {}) => spawnSync(command, args, { cwd: here, encoding: "utf8", timeout: 10000, ...extra })

test("atomic installation preserves private config, live reservations and unrelated data", (t) => {
  const root = mkdtempSync(join(tmpdir(), "devx-farm-install-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, "farm-config.json"), '{"miniHost":"private-alias"}\n')
  mkdirSync(join(root, "mini-farm/slot1.lock"), { recursive: true })
  writeFileSync(join(root, "mini-farm/slot1.lock/owner"), "live\n")
  install(root); install(root)
  assert.equal(readFileSync(join(root, "farm-config.json"), "utf8"), '{"miniHost":"private-alias"}\n')
  assert.equal(readFileSync(join(root, "mini-farm/slot1.lock/owner"), "utf8"), "live\n")
  for (const path of files) {
    assert.deepEqual(readFileSync(join(root, path)), readFileSync(join(here, path)))
    if (!path.endsWith(".yml")) assert.ok(statSync(join(root, path)).mode & 0o100)
  }
  assert.equal(readdirSync(root).some((name) => name.endsWith(".new")), false)
})

test("disk admission reads the real filesystem and fails before mutation with a clear capacity reason", () => {
  const good = run("bash", ["health.sh", here], { env: { ...process.env, FARM_MIN_FREE_KB: "0", FARM_MAX_USED_PERCENT: "100" } })
  assert.equal(good.status, 0, good.stderr)
  assert.match(good.stderr, /FARM_HEALTH ready/)
  const full = run("bash", ["health.sh", here], { env: { ...process.env, FARM_MIN_FREE_KB: "999999999999999" } })
  assert.equal(full.status, 73)
  assert.match(full.stderr, /DISK_FULL/)
  assert.equal(run("bash", ["health.sh", "/nonexistent-devx-disk"]).status, 3)
  assert.equal(run("bash", ["health.sh", here], { env: { ...process.env, FARM_MIN_FREE_KB: "bad" } }).status, 2)
})

test("clients reject malformed input and credentials before any SSH or reservation", () => {
  const mini = run("bash", ["mini-run", "-e", "SECRET_VALUE=do-not-print", ".", "--", "true"])
  assert.equal(mini.status, 2)
  assert.match(mini.stderr, /refused/)
  assert.equal(mini.stderr.includes("do-not-print"), false)
  const lat = run("python3", ["lat-run", "-e", "BASH_ENV=do-not-print", ".", "--", "true"])
  assert.equal(lat.status, 2)
  assert.match(lat.stderr, /refused/)
  assert.equal(lat.stderr.includes("do-not-print"), false)
  assert.equal(run("bash", ["mini-run", "../outside", "--", "true"]).status, 2)
  assert.equal(run("python3", ["lat-run", "../outside", "--", "true"]).status, 2)
  assert.equal(run("bash", ["mini-run"], { env: { ...process.env, MINI_RUN_TIMEOUT_SECONDS: "invalid" } }).status, 2)
})

test("all shell scripts parse and pass the installed ShellCheck; Python compiles without cache files", () => {
  const shell = ["mini-run", "mini-remote.sh", "lat-remote.sh", "lat-services.sh", "health.sh"]
  for (const path of shell) assert.equal(run("bash", ["-n", path]).status, 0, path)
  const lint = run("shellcheck", ["-S", "warning", ...shell])
  assert.equal(lint.status, 0, lint.stdout + lint.stderr)
  assert.equal(run("python3", ["-c", 'import ast,pathlib; ast.parse(pathlib.Path("lat-run").read_text())']).status, 0)
})


test("Latitude rejects invalid configuration and unsafe detached launches before connecting", () => {
  const baseline = { ...process.env, LAT_RUN_SRC: here, LAT_RUN_ENDPOINTS: '{"fixture":"unreached-host"}', LAT_RUN_HOSTS: "fixture", LAT_RUN_DETACH: "0" }
  for (const patch of [{ LAT_RUN_WAIT_SECONDS: "bad" }, { LAT_RUN_SLOT_FIRST: "bad" }, { LAT_RUN_ENDPOINTS: "invalid" }, { LAT_RUN_DETACH: "1" }]) {
    const result = run("python3", ["lat-run", ".", "--", "true"], { env: { ...baseline, ...patch } })
    assert.equal(result.status, 2)
    assert.equal(result.stderr.includes("Traceback"), false)
  }
})
