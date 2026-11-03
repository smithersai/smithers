import { strict as assert } from "node:assert"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { jj } from "./numbering.mjs"
import { command, typecheckApp } from "./typecheck.mjs"
import { createWorkspace, landWorkspace } from "./workspace.mjs"
import { overrideInbox } from "./review.mjs"

const names = ["SMITHERS_MINI_RUN", "SMITHERS_LAT_RUN", "SMITHERS_CFBOX", "SMITHERS_CFBOX_VIA", "SMITHERS_CFBOX_RELAY", "PNPM_LOG", "PATH", "SMITHERS_REVIEWS_DIR"]

// A farm client: drops `<dir> --`, then runs the command in that directory, as the real clients do.
const client = (path, body = 'dir=$1; shift 2; cd "$MINI_RUN_SRC/$dir" && exec "$@"') => {
  writeFileSync(path, `#!/bin/sh\necho called >> "${path}.calls"\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "land-typecheck-"))
  const previousInbox = overrideInbox.path
  overrideInbox.path = join(directory, "inbox.md")
  writeFileSync(overrideInbox.path, "")
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  t.after(() => {
    overrideInbox.path = previousInbox
    for (const name of names) saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name]
    rmSync(directory, { recursive: true, force: true })
  })
  const root = join(directory, "root")
  mkdirSync(join(root, "apps/mvp/worker"), { recursive: true })
  jj(root, ["git", "init", "."])
  for (const [key, value] of [["user.name", "Devx"], ["user.email", "devx@example.invalid"]]) jj(root, ["config", "set", "--repo", key, value])
  writeFileSync(join(root, "apps/mvp/package.json"), "{}\n")
  writeFileSync(join(root, "base.txt"), "base\n")
  writeFileSync(join(root, ".node-version"), "26.5.0\n")
  writeFileSync(join(root, ".gitignore"), ".env\nnode_modules/\n")
  mkdirSync(join(root, ".github/scripts/ci"), { recursive: true })
  // Inject the bootstrap runner; the separate older-runtime case below runs the real helpers.
  writeFileSync(join(root, ".github/scripts/ci/cloud.sh"), "set -e\nensure_js() { :; }\n")
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
  process.env.SMITHERS_CFBOX = client(join(directory, "cfbox"), "echo cfbox unavailable; exit 125")
  delete process.env.SMITHERS_CFBOX_VIA
  delete process.env.SMITHERS_CFBOX_RELAY
  // Caller edits are explicitly stored before any land/typecheck invocation.
  const change = (name, text) => { mkdirSync(dirname(join(lane, name)), { recursive: true }); writeFileSync(join(lane, name), text); jj(lane, ["status"]) }
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

test("the land holds the FIFO lease during the typecheck", async (t) => {
  const { directory, change, onMain, landing, calls } = fixture(t)
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  const lock = join(directory, "main-push.lock")
  // Both clients require the lock, so neither can stand in for the other.
  const guarded = `test -d "${lock}" || exit 42\ndir=$1; shift 2; cd "$MINI_RUN_SRC/$dir" && exec "$@"`
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

test("typecheck reaches cfbox through the relay after mini disk-full and a failed Latitude", async (t) => {
  const { directory, lane, change, calls } = fixture(t)
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  change(".env", "ignored sentinel\n")
  mkdirSync(join(lane, "node_modules"))
  writeFileSync(join(lane, "node_modules/ignored"), "ignored\n")
  process.env.SMITHERS_MINI_RUN = client(join(directory, "mini"), "echo FARM_HEALTH DISK_FULL; exit 73")
  process.env.SMITHERS_LAT_RUN = client(join(directory, "lat"), "echo checking farm integration services; exit 124")
  process.env.SMITHERS_CFBOX_RELAY = "relay.example.invalid"
  const box = join(directory, "cfbox")
  writeFileSync(box, `#!${process.execPath}
    const fs = require("node:fs"), cp = require("node:child_process"), assert = require("node:assert/strict")
    const args = process.argv.slice(2), split = args.indexOf("--"), tree = args[split - 1]
    assert.equal(fs.existsSync(tree + "/.jj"), false)
    assert.equal(fs.existsSync(tree + "/.git"), false)
    assert.equal(fs.existsSync(tree + "/.env"), false)
    assert.equal(fs.existsSync(tree + "/node_modules"), false)
    assert.equal(fs.readFileSync(tree + "/apps/mvp/worker/ok.ts", "utf8"), "export const ok = 1\\n")
    const attempts = fs.existsSync(".jj/box-attempts") ? JSON.parse(fs.readFileSync(".jj/box-attempts")) : []
    attempts.push(args); fs.writeFileSync(".jj/box-attempts", JSON.stringify(attempts))
    if (attempts.length === 1) {
      assert.ok(args.includes("--cache"))
      console.error("cfbox: R2 upload failed: 503"); process.exit(125)
    }
    assert.equal(attempts.length, 2)
    assert.equal(args[args.indexOf("--via") + 1], "relay.example.invalid")
    assert.equal(args.includes("--cache"), false)
    assert.equal(args.includes("--cache-key"), false)
    const run = cp.spawnSync(args[split + 1], args.slice(split + 2), { cwd: tree, stdio: "inherit" })
    process.exit(run.status ?? 1)
  `)
  chmodSync(box, 0o755)
  process.env.SMITHERS_CFBOX = box
  // An injected pnpm runner records the working directory as well as install/typecheck ordering.
  writeFileSync(join(directory, "bin/pnpm"), '#!/bin/sh\nprintf "%s: pnpm %s\\n" "$PWD" "$*" >> "$PNPM_LOG"\n')
  jj(lane, ["status"])
  assert.equal(await typecheckApp(lane), box)
  assert.equal(calls(process.env.SMITHERS_MINI_RUN), 1)
  assert.equal(calls(process.env.SMITHERS_LAT_RUN), 1)
  const attempts = JSON.parse(readFileSync(join(lane, ".jj/box-attempts"), "utf8"))
  const tree = attempts[1][attempts[1].indexOf("--") - 1]
  assert.equal(readFileSync(process.env.PNPM_LOG, "utf8"), `${tree}: pnpm install --frozen-lockfile\n${tree}/apps/mvp: pnpm typecheck\n`)
  assert.equal(existsSync(tree), false)
  assert.equal(existsSync(attempts[0][attempts[0].indexOf("--") - 1]), false)
})

test("all three clients failing refuses the land, names cfbox and releases the lock", async (t) => {
  const { directory, change, landing, onMain, calls } = fixture(t)
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  process.env.SMITHERS_MINI_RUN = client(join(directory, "mini"), "exit 73")
  process.env.SMITHERS_LAT_RUN = client(join(directory, "lat"), "echo checking farm integration services; exit 124")
  await assert.rejects(landing(), (error) => {
    assert.match(error.message, /no farm client answered/)
    assert.match(error.message, /cfbox unavailable/)
    return true
  })
  assert.equal(calls(process.env.SMITHERS_CFBOX), 1)
  assert.equal(onMain(), "base")
  assert.equal(existsSync(join(directory, "main-push.lock")), false)
})

test("cfbox bootstraps a verified supported Node before installing and typechecking", async (t) => {
  const { directory, lane, change } = fixture(t)
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  change("package.json", JSON.stringify({ engines: { node: ">=26.4.0" }, packageManager: "pnpm@10.30.3" }, null, 2) + "\n")
  change(".github/scripts/ci/cloud.sh", readFileSync(new URL("../../../.github/scripts/ci/cloud.sh", import.meta.url), "utf8"))
  const bin = join(directory, "bin")
  client(join(bin, "uname"), '[ "$1" = -s ] && echo Linux || echo x86_64')
  client(join(bin, "node"), 'echo v24.0.0')
  client(join(bin, "npm"), '[ "$(node --version)" = v26.5.0 ] || exit 91')
  client(join(bin, "curl"), 'while [ "$1" != -o ]; do shift; done; : > "$2"')
  client(join(bin, "sha256sum"), 'cat >/dev/null')
  const installedNode = '#!/bin/sh\ncase "$1" in --version) echo v26.5.0;; -p) echo pnpm@10.30.3;; *) exit 92;; esac\n'
  client(join(bin, "tar"), `mkdir -p .flows/cloud-tools/node/bin\ncat > .flows/cloud-tools/node/bin/node <<'NODE'\n${installedNode}NODE\nchmod +x .flows/cloud-tools/node/bin/node`)
  client(join(bin, "pnpm"), '[ "$(node --version)" = v26.5.0 ] || { echo "unsupported Node" >&2; exit 93; }\nprintf "%s: pnpm %s\\n" "$PWD" "$*" >> "$PNPM_LOG"')
  process.env.SMITHERS_MINI_RUN = client(join(directory, "mini"), "exit 73")
  process.env.SMITHERS_LAT_RUN = client(join(directory, "lat"), "exit 124")
  const box = join(directory, "cfbox")
  writeFileSync(box, `#!${process.execPath}
    const fs = require("node:fs"), cp = require("node:child_process"), args = process.argv.slice(2), split = args.indexOf("--"), tree = args[split - 1]
    fs.writeFileSync(".jj/box-tree", tree)
    const run = cp.spawnSync(args[split + 1], args.slice(split + 2), { cwd: tree, stdio: "inherit" })
    process.exit(run.status ?? 1)
  `, { mode: 0o755 })
  process.env.SMITHERS_CFBOX = box
  jj(lane, ["status"])
  assert.equal(await typecheckApp(lane), box)
  const tree = readFileSync(join(lane, ".jj/box-tree"), "utf8")
  const log = readFileSync(process.env.PNPM_LOG, "utf8")
  assert.match(log, /pnpm install --frozen-lockfile\n/)
  assert.ok(log.endsWith(`${tree}/apps/mvp: pnpm typecheck\n`))
  assert.equal(existsSync(tree), false)
})


for (const [name, pnpmBody, boxBody, message] of [
  ["install fails", 'exit 9', 'const run = cp.spawnSync(args[split + 1], args.slice(split + 2), { cwd: tree, stdio: "inherit" }); process.exit(run.status ?? 1)', /no farm client answered/],
  ["typecheck fails", '[ "$1" = install ] && exit 0; echo TS2550; exit 2', 'const run = cp.spawnSync(args[split + 1], args.slice(split + 2), { cwd: tree, stdio: "inherit" }); process.exit(run.status ?? 1)', /does not typecheck[\s\S]*TS2550/],
  ["receipt missing", 'exit 0', 'process.exit(0)', /no farm client answered/],
  ["stream breaks after receipt", 'exit 0', 'console.log("SMITHERS_TYPECHECK_EXIT=0"); process.exit(255)', /no farm client answered/],
  ["source changes", 'exit 0', 'fs.writeFileSync("edit.txt", "changed"); cp.spawnSync("jj", ["status"]); console.log("SMITHERS_TYPECHECK_EXIT=0")', /Source changed during the farm typecheck/]
]) test(`cfbox ${name} refuses and removes its source tree`, async (t) => {
  const { directory, lane, change } = fixture(t)
  change("apps/mvp/worker/ok.ts", "export const ok = 1\n")
  process.env.SMITHERS_MINI_RUN = client(join(directory, "mini"), "exit 73")
  process.env.SMITHERS_LAT_RUN = client(join(directory, "lat"), "exit 124")
  writeFileSync(join(directory, "bin/pnpm"), `#!/bin/sh\n${pnpmBody}\n`)
  const box = join(directory, "cfbox")
  writeFileSync(box, `#!${process.execPath}
    const fs = require("node:fs"), cp = require("node:child_process")
    const args = process.argv.slice(2), split = args.indexOf("--"), tree = args[split - 1]
    fs.writeFileSync(".jj/box-tree", tree)
    ${boxBody}
  `)
  chmodSync(box, 0o755)
  process.env.SMITHERS_CFBOX = box
  jj(lane, ["status"])
  await assert.rejects(typecheckApp(lane), message)
  assert.equal(existsSync(readFileSync(join(lane, ".jj/box-tree"), "utf8")), false)
})
