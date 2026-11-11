import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
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
    if (!/\.(yml|filter)$/.test(path)) assert.ok(statSync(join(root, path)).mode & 0o100)
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

test("mini-run's admission starts after a slow health check and always sweeps the slots once", (t) => {
  const root = mkdtempSync(join(tmpdir(), "devx-farm-admission-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  install(root)
  mkdirSync(join(root, "bin")); mkdirSync(join(root, "src"))
  // The health check takes 2 s; reservations succeed; anything after that fails, which is fine here.
  writeFileSync(join(root, "bin/ssh"), `#!/bin/bash\ncat >/dev/null\ncase "\${@: -1}" in *'"$HOME"'*) sleep 2; exit 0;; "bash -s -- "*) exit 0;; esac\nexit 9\n`, { mode: 0o755 })
  const result = spawnSync("bash", [join(root, "mini-run"), ".", "--", "true"], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, MINI_RUN_HOST: "fake", MINI_RUN_SRC: join(root, "src"), MINI_RUN_WAIT_SECONDS: "0" }
  })
  assert.doesNotMatch(result.stderr, /CAPACITY_TIMEOUT/)
  assert.match(result.stderr, /\[mini-run\] slot 1;/)
})

test("mini cancellation during dependency installation stops the installer before the helper exits", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "devx-farm-install-cancel-"))
  const pidFile = join(home, "installer.pid")
  const installer = () => Number(readFileSync(pidFile, "utf8"))
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  t.after(() => {
    if (existsSync(pidFile) && alive(installer())) process.kill(installer(), "SIGKILL")
    rmSync(home, { recursive: true, force: true })
  })
  const bin = join(home, ".nvm/versions/node", process.version, "bin")
  mkdirSync(bin, { recursive: true }); mkdirSync(join(home, "smithers-mirror/slot1"), { recursive: true })
  writeFileSync(join(home, "smithers-mirror/slot1/package.json"), "{}\n")
  writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  // A cold slot's installer that outlives any cancellation unless its process group is stopped.
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho $$ > "$HOME/installer.pid"\nexec sleep 60\n`, { mode: 0o755 })
  const helper = spawn("bash", [join(here, "mini-remote.sh"), "1", process.version, ".", "0", "0", "--", "true"],
    { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "pipe"] })
  let stderr = ""
  helper.stderr.on("data", (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => helper.once("close", resolve))
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(existsSync(pidFile), stderr)
  assert.match(readFileSync(join(home, "smithers-mirror/.farm/slot1.groups"), "utf8"), /^\d+\n$/)
  helper.stdin.end()
  let timer
  const status = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve("still running"), 8000) })])
  clearTimeout(timer)
  assert.equal(status, 143, stderr)
  assert.equal(alive(installer()), false)
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

// Fake SSH: health, reservation and the job succeed; every other command (rsync's server, helper uploads,
// remote locks) runs locally in the fake host home, so each client performs its real transfer.
const fakeHost = (root) => {
  const home = join(root, "host")
  for (const dir of ["lat-mirror/.farm", "smithers-mirror/.farm"]) mkdirSync(join(home, dir), { recursive: true })
  mkdirSync(join(root, "bin"))
  writeFileSync(join(root, "bin/ssh"), `#!/bin/bash
while [ "$1" = -i ] || [ "$1" = -o ]; do shift 2; done
shift; command="$*"
case "$command" in
  *flock*) echo reserved; cat >/dev/null; exit 0;;
  'bash -s -- "$HOME"') cat >/dev/null; exit 0;;
  *'.farm/remote-'*) exit 0;;
esac
cd ${JSON.stringify(home)} && HOME=${JSON.stringify(home)} exec bash -c "$command"
`, { mode: 0o755 })
  return home
}

const privateFiles = [".npmrc", ".env", ".env.local", ".dev.vars", ".dev.vars.production", ".ssh/id_rsa", ".aws/credentials", "fixture.p12", "fixture.pem", "fixture.key", "fixture.tfstate", "fixture.tfstate.backup", "data/private.json", "apps/mvp/.env", "apps/mvp/.npmrc", "apps/mvp/.ssh/id_ed25519"]
const sourceFiles = ["package.json", "apps/mvp/index.ts", "apps/mvp/data/fixture.json", "apps/mvp/env.ts"]

test("both clients never upload credentials or private data and delete copies left in a reused slot", async (t) => {
  const { farmSkips } = await import("../affected.mjs")
  for (const [client, mirror, interpreter, env] of [
    ["lat-run", "lat-mirror", "python3", { LAT_RUN_ENDPOINTS: '{"fixture":"fake"}', LAT_RUN_HOSTS: "fixture", LAT_RUN_SLOT_LAST: "1" }],
    ["mini-run", "smithers-mirror", "bash", { MINI_RUN_HOST: "fake" }]
  ]) {
    const root = mkdtempSync(join(tmpdir(), `devx-farm-${client}-`))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    install(root)
    const home = fakeHost(root), source = join(root, "src"), slot = join(home, mirror, "slot1")
    for (const path of [...privateFiles, ...sourceFiles]) {
      mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), "canary\n")
      mkdirSync(dirname(join(slot, path)), { recursive: true }); writeFileSync(join(slot, path), "left by an older client\n")
    }
    const result = spawnSync(interpreter, [join(root, client), "apps/mvp", "--", "true"], {
      encoding: "utf8", timeout: 30000,
      env: { ...process.env, ...env, PATH: `${join(root, "bin")}:${process.env.PATH}`, LAT_RUN_SRC: source, MINI_RUN_SRC: source, LAT_RUN_WAIT_SECONDS: "5", MINI_RUN_WAIT_SECONDS: "5" }
    })
    assert.equal(result.status, 0, `${client}: ${result.stderr}`)
    for (const path of privateFiles) {
      assert.equal(existsSync(join(slot, path)), false, `${client} left ${path} in the slot`)
      assert.ok(farmSkips(path), `farmSkips must name ${path}`)
    }
    for (const path of sourceFiles) {
      assert.equal(readFileSync(join(slot, path), "utf8"), "canary\n", `${client} must send ${path}`)
      assert.equal(farmSkips(path), false, path)
    }
  }
})
