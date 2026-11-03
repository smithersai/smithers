import { strict as assert } from "node:assert"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { jj } from "./numbering.mjs"
import { command, typecheckApp } from "./typecheck.mjs"
import { createWorkspace, landWorkspace } from "./workspace.mjs"

const names = ["SMITHERS_MINI_RUN", "SMITHERS_LAT_RUN", "PATH", "SMITHERS_REVIEWS_DIR"]

// A farm client: drops `<dir> --`, then runs the command in that directory, as the real clients do.
const client = (path, body = 'dir=$1; shift 2; cd "$MINI_RUN_SRC/$dir" && exec "$@"') => {
  writeFileSync(path, `#!/bin/sh\necho called >> "${path}.calls"\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "land-typecheck-"))
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const name of names) saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name]
    rmSync(directory, { recursive: true, force: true })
  })
  const root = join(directory, "root")
  mkdirSync(join(root, "apps/mvp/worker"), { recursive: true })
  jj(root, ["git", "init", "."])
  for (const [key, value] of [["user.name", "Devx"], ["user.email", "devx@example.invalid"]]) jj(root, ["config", "set", "--repo", key, value])
  writeFileSync(join(root, "apps/mvp/package.json"), "{}\n")
  writeFileSync(join(root, "base.txt"), "base\n")
  jj(root, ["commit", "-m", "base"])
  jj(root, ["bookmark", "set", "main", "-r", "@-"])
  const remote = join(directory, "remote")
  jj(directory, ["git", "clone", root, remote])
  jj(root, ["git", "remote", "add", "origin", remote])
  jj(root, ["git", "fetch", "--remote", "origin"])
  jj(root, ["bookmark", "track", "main@origin"])
  const lane = join(directory, "lane")
  createWorkspace(root, lane, "lane")
  // `pnpm typecheck` here: a worker test using Promise.withResolvers is the type error it finds.
  const bin = join(directory, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "pnpm"), '#!/bin/sh\necho "pnpm $*" >> "$PNPM_LOG"\nif grep -rq "Promise.withResolvers" worker 2>/dev/null; then echo "worker/runners/x.test.ts(96,1): error TS2550"; exit 2; fi\n')
  chmodSync(join(bin, "pnpm"), 0o755)
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.PNPM_LOG = join(directory, "pnpm.log")
  process.env.SMITHERS_REVIEWS_DIR = join(directory, "reviews")
  process.env.SMITHERS_MINI_RUN = client(join(directory, "mini"))
  process.env.SMITHERS_LAT_RUN = client(join(directory, "lat"))
  const change = (name, text) => { mkdirSync(dirname(join(lane, name)), { recursive: true }); writeFileSync(join(lane, name), text) }
  const onMain = () => { jj(remote, ["git", "import", "--ignore-working-copy"]); return jj(remote, ["log", "--ignore-working-copy", "-r", "main", "--no-graph", "-T", "description.first_line()"]) }
  const landing = (options = {}) => landWorkspace(lane, { message: "fix: a lane", validation: "existing receipt", lockPath: join(directory, "main-push.lock"), ...options })
  const calls = (path) => { try { return readFileSync(`${path}.calls`, "utf8").trim().split("\n").length } catch { return 0 } }
  return { directory, lane, change, onMain, landing, calls }
}

test("a worker-test type error blocks a land, even with --validated, and the land names it", async (t) => {
  const { change, onMain, landing } = fixture(t)
  change("apps/mvp/worker/runners/x.test.ts", "const { promise } = Promise.withResolvers()\n")
  await assert.rejects(landing(), (error) => {
    assert.match(error.message, /apps\/mvp does not typecheck; nothing pushed/)
    assert.match(error.message, /TS2550/)
    return true
  })
  assert.equal(onMain(), "base")
})

test("a clean apps/mvp land runs pnpm typecheck in apps/mvp and publishes", async (t) => {
  const { change, onMain, landing } = fixture(t)
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  await landing()
  assert.equal(onMain(), "fix: a lane")
  assert.equal(readFileSync(process.env.PNPM_LOG, "utf8").trim(), "pnpm typecheck")
})

test("a land outside apps/mvp asks the farm for nothing", async (t) => {
  const { change, onMain, landing, calls } = fixture(t)
  change("elsewhere.txt", "x\n")
  process.env.SMITHERS_MINI_RUN = client(process.env.SMITHERS_MINI_RUN, "exit 99")
  await landing()
  assert.equal(onMain(), "fix: a lane")
  assert.equal(calls(process.env.SMITHERS_MINI_RUN), 0)
})

test("an idle mini is used: admission can't be 0, which mini-run reads as already expired", async (t) => {
  const { lane, change, calls } = fixture(t)
  const mini = client(process.env.SMITHERS_MINI_RUN, '[ "$MINI_RUN_WAIT_SECONDS" -gt 0 ] || { echo CAPACITY_TIMEOUT; exit 75; }\ndir=$1; shift 2; cd "$MINI_RUN_SRC/$dir" && exec "$@"')
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  jj(lane, ["status"])
  assert.equal(await typecheckApp(lane), mini)
  assert.equal(calls(process.env.SMITHERS_LAT_RUN), 0)
})

test("no mini capacity moves to Latitude; a type error found there still blocks", async (t) => {
  const { lane, change, onMain, landing, calls } = fixture(t)
  process.env.SMITHERS_MINI_RUN = client(process.env.SMITHERS_MINI_RUN, "echo CAPACITY_TIMEOUT; exit 75")
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  jj(lane, ["status"])
  assert.equal(await typecheckApp(lane), process.env.SMITHERS_LAT_RUN)
  assert.equal(calls(process.env.SMITHERS_MINI_RUN), 1)
  change("apps/mvp/worker/x.test.ts", "Promise.withResolvers()\n")
  jj(lane, ["status"])
  await assert.rejects(landing(), /does not typecheck/)
  assert.equal(onMain(), "base")
})

test("a farm that can't answer refuses and says why; it never counts as a pass", async (t) => {
  const { directory, change, onMain, landing } = fixture(t)
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  for (const [mini, lat] of [["exit 75", "echo CAPACITY_TIMEOUT; exit 75"], ["exit 0", "exit 0"], ["echo ssh failed; exit 5", "exit 124"]]) {
    process.env.SMITHERS_MINI_RUN = client(join(directory, "mini"), mini)
    process.env.SMITHERS_LAT_RUN = client(join(directory, "lat"), lat)
    await assert.rejects(landing(), (error) => {
      assert.match(error.message, /Cannot typecheck apps\/mvp: no farm client answered, so the land refuses/)
      assert.match(error.message, /no typecheck receipt/)
      return true
    })
    assert.equal(onMain(), "base")
  }
  process.env.SMITHERS_MINI_RUN = join(directory, "no-such-client")
  process.env.SMITHERS_LAT_RUN = join(directory, "no-such-client")
  await assert.rejects(landing(), /no farm client answered/)
  assert.equal(onMain(), "base")
})

test("the land does not hold the push lock during the typecheck", async (t) => {
  const { directory, change, onMain, landing, calls } = fixture(t)
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  const lock = join(directory, "main-push.lock")
  // Both clients refuse while the lock is held, so neither can stand in for the other.
  const guarded = `test -d "${lock}" && exit 42\ndir=$1; shift 2; cd "$MINI_RUN_SRC/$dir" && exec "$@"`
  process.env.SMITHERS_MINI_RUN = client(join(directory, "mini"), guarded)
  process.env.SMITHERS_LAT_RUN = client(join(directory, "lat"), guarded)
  await landing()
  assert.equal(onMain(), "fix: a lane")
  assert.equal(calls(process.env.SMITHERS_MINI_RUN), 1)
  assert.equal(calls(process.env.SMITHERS_LAT_RUN), 0)
})

test("an edit that arrives after validation, under the lock, is not published", async (t) => {
  const { change, onMain, landing } = fixture(t)
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  await assert.rejects(landing({ afterValidation: () => change("apps/mvp/worker/late.ts", "export const late: number = 'never typechecked'\n") }), /Source changed after validation; nothing pushed/)
  assert.equal(onMain(), "base")
})

test("source edited during the typecheck refuses", async (t) => {
  const { lane, directory, change, landing, onMain } = fixture(t)
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  process.env.SMITHERS_MINI_RUN = client(join(directory, "mini"), `echo changed > "${lane}/edit.txt"; (cd "${lane}" && jj status >/dev/null); dir=$1; shift 2; cd "$MINI_RUN_SRC/$dir" && exec "$@"`)
  await assert.rejects(landing(), /Source changed during the farm typecheck/)
  assert.equal(onMain(), "base")
})

test("Latitude classifies the land's typecheck as light, so it needs no heavy-test permit", () => {
  const remote = readFileSync(join(import.meta.dirname, "farm/lat-remote.sh"), "utf8")
  const classifier = remote.split("\n").find((line) => line.startsWith('case " $* " in') && line.includes("LIGHT=1"))
  assert.ok(classifier, "lat-remote.sh's classifier line")
  const light = (...argv) => spawnSync("bash", ["-c", `LIGHT=0; ${classifier}\necho "$LIGHT"`, "classify", ...argv], { encoding: "utf8" }).stdout.trim()
  assert.equal(light("sh", "-c", command), "1")
  assert.equal(light("pnpm", "exec", "vitest", "run"), "0")
})

// The real compiler, not a stand-in: each of the four projects must fail on its own error.
const app = resolve(import.meta.dirname, "../../../apps/mvp")
const probes = [
  ["src/__land_probe.ts", 'export const landProbe: number = "not a number"\n'],
  ["worker/runners/__land_probe.test.ts", "export const landProbe = Promise.withResolvers<void>()\n"],
  ["infra/__land_probe.ts", 'export const landProbe: number = "not a number"\n'],
  ["evals/__land_probe.ts", 'export const landProbe: number = "not a number"\n']
]
test("pnpm typecheck fails on an error in each project, including Promise.withResolvers in a worker test", { timeout: 20 * 60 * 1000 }, (t) => {
  if (!existsSync(join(app, "node_modules"))) return t.skip("needs an installed apps/mvp: run on the farm")
  for (const [path, text] of probes) {
    writeFileSync(join(app, path), text)
    try {
      const result = spawnSync("sh", ["-c", command], { cwd: app, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 })
      const output = result.stdout + result.stderr
      assert.match(output, /SMITHERS_TYPECHECK_EXIT=[1-9]/, `${path} did not fail the typecheck`)
      assert.ok(output.includes(path.split("/").pop()), `${path} is not named in:\n${output.slice(-2000)}`)
    } finally { rmSync(join(app, path), { force: true }) }
  }
})
