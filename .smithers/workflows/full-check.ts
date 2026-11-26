// full-check, tier 3 of the tiered backpressure protocol (plan tree M0, `plan/m0/tiered-backpressure-workflows`).
// Runs before a release or a deploy: the Alchemy and deploy preflight, both apps/mvp vibelang projects, the whole
// apps/mvp suite, the Playwright E2E suite in shards, the README GIF check, a deep fuzz run, every Lean 4 spec in the
// repository when `lake` is on PATH, and the benchmarks. It runs with plain Node:
//
//   node .smithers/workflows/full-check.ts               run every step
//   node .smithers/workflows/full-check.ts --dry-run     print the plan and exit 0
//
// `FULL_CHECK_SHARDS` sets the E2E shard count (default 4). It exits 0 when every step passes and 1 otherwise. It
// stops after a failed preflight, since every later step needs the toolchain the preflight proves.
import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The real checkout: Lake runs only in a project directory that resolves under it, symlinks followed.
const root = realpathSync(spawnSync("jj", ["root"], { encoding: "utf8" }).stdout.trim() || process.cwd())
const mvp = join(root, "apps/mvp")
const bin = (name: string) => join(mvp, "node_modules/.bin", name)
const onPath = (command: string) => spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0

interface Step {
  readonly name: string
  readonly cmd: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly skip?: string
  /** Why the step fails without running: a directory outside the checkout. */
  readonly refuse?: string
  /** A failure here stops the run. */
  readonly gate?: boolean
}

/** A Lean 4 project: its repository path, and the real directory Lake runs in, or why it is refused. */
interface LakeProject {
  readonly path: string
  readonly dir: string
  readonly refused?: string
}

/** The real path of `path` when it resolves under the real checkout, symlinks followed. */
const within = (path: string): string | undefined => {
  try {
    const real = realpathSync(path)
    return real.startsWith(`${root}/`) ? real : undefined
  } catch {
    return undefined
  }
}

const present = (path: string) => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

const isDirectory = (real: string) => statSync(real).isDirectory()

/** A directory as a Lean project: confined with its lakefile, refused when either resolves outside the checkout. */
const lakeProject = (path: string): LakeProject | undefined => {
  const at = join(root, path)
  if (!present(at)) return undefined
  const dir = within(at)
  if (dir === undefined) return { path, dir: at, refused: "resolves outside the checkout" }
  if (!isDirectory(dir)) return undefined
  const lakefiles = ["lakefile.toml", "lakefile.lean"].map((name) => join(dir, name)).filter(present)
  if (lakefiles.length === 0) return undefined
  if (lakefiles.some((lakefile) => within(lakefile) === undefined)) return { path, dir, refused: "its lakefile resolves outside the checkout" }
  return { path, dir }
}

/** Each Lean 4 project directly under `parent`: a directory holding a lakefile, both inside the checkout. */
const lakeProjects = (parent: string): ReadonlyArray<LakeProject> => {
  const at = join(root, parent)
  if (!present(at)) return []
  const real = within(at)
  if (real === undefined) return [{ path: parent, dir: at, refused: "resolves outside the checkout" }]
  if (!isDirectory(real)) return []
  return readdirSync(real).sort().flatMap((entry) => lakeProject(`${parent}/${entry}`) ?? [])
}

const leanStep = (project: LakeProject, lake: boolean): Step => ({
  name: `lean ${project.path}`,
  cmd: "lake",
  args: ["build"],
  cwd: project.dir,
  ...(project.refused !== undefined ? { refuse: project.refused } : lake ? {} : { skip: "lake is not on PATH" }),
})

/** Every Lean 4 project the repository holds. */
const LEAN = [
  ...["apps/mvp/spec/lean", "apps/vibelang/spec/lean", "packages/ci/spec/lean"].flatMap(lakeProjects),
  ...["lean/smithers-state", "packages/smithers/flows/merge-queue/lean"].flatMap((path) => lakeProject(path) ?? []),
]

const shardsRaw = process.env["FULL_CHECK_SHARDS"] ?? "4"
const shards = /^[1-9][0-9]?$/.test(shardsRaw) ? Number(shardsRaw) : 4
const lake = onPath("lake")

const steps: Array<Step> = [
  { name: "preflight alchemy --version", cmd: bin("alchemy"), args: ["--version"], cwd: mvp, gate: true },
  { name: "preflight deploy toolchain", cmd: "node", args: ["infra/deploy/run.mjs", "preflight"], cwd: mvp, gate: true },
  { name: "typecheck worker/tsconfig.json", cmd: bin("vibelang"), args: ["-p", "worker/tsconfig.json"], cwd: mvp },
  { name: "typecheck tsconfig.json", cmd: bin("vibelang"), args: ["-p", "tsconfig.json"], cwd: mvp },
  { name: "vitest apps/mvp", cmd: bin("vitest"), args: ["run"], cwd: mvp },
  ...Array.from({ length: shards }, (_, index) => ({
    name: `e2e shard ${index + 1}/${shards}`,
    cmd: bin("playwright"),
    args: ["test", `--shard=${index + 1}/${shards}`],
    cwd: mvp,
  })),
  { name: "e2e GIF check", cmd: "node", args: ["e2e/check-gifs.mjs"], cwd: mvp },
  {
    name: "deep fuzz (10000 executions)",
    cmd: bin("vitest"),
    args: ["run", "--config", "vitest.fuzz.config.ts"],
    cwd: mvp,
    env: { EFFECT_FUZZ_EXECUTIONS: "10000" },
  },
  ...LEAN.map((project) => leanStep(project, lake)),
  { name: "benchmarks", cmd: "node", args: ["bench/run.ts"], cwd: mvp },
]

const describe = (step: Step) =>
  `${Object.entries(step.env ?? {}).map(([key, value]) => `${key}=${value} `).join("")}${step.cmd.startsWith(mvp) ? step.cmd.slice(mvp.length + 1) : step.cmd} ${step.args.join(" ")}  (in ${step.cwd === root ? "." : step.cwd.slice(root.length + 1)})`

if (process.argv.includes("--dry-run")) {
  console.log(`full-check plan: ${steps.length} step(s)`)
  for (const step of steps) {
    const status = step.refuse !== undefined ? "refuse" : step.skip !== undefined ? "skip" : "plan"
    console.log(`${status}  ${step.name}  ${step.refuse ?? step.skip ?? describe(step)}`)
  }
  process.exit(0)
}

// Each step writes straight to its own log file, never through a pipe buffer: the apps/mvp suite prints more than
// 64 MiB of OTLP and TanStack logs, and spawnSync kills a child whose output outgrows `maxBuffer` (ENOBUFS).
const logs = mkdtempSync(join(tmpdir(), "full-check-"))

/** The last `lines` lines of a log, read from its final 256 KiB. */
const tail = (file: string, lines: number) => {
  const size = statSync(file).size
  const buffer = Buffer.alloc(Math.min(size, 256 * 1024))
  const fd = openSync(file, "r")
  try {
    readSync(fd, buffer, 0, buffer.length, size - buffer.length)
  } finally {
    closeSync(fd)
  }
  return buffer.toString("utf8").split("\n").slice(-lines).join("\n")
}

let failed = 0
for (const step of steps) {
  if (step.refuse !== undefined) {
    failed += 1
    console.log(`FAIL  ${step.name}  ${step.refuse}`)
    continue
  }
  if (step.skip !== undefined) {
    console.log(`skip  ${step.name}  ${step.skip}`)
    continue
  }
  const log = join(logs, `${step.name.replaceAll(/[^\w.-]+/g, "-")}.log`)
  const fd = openSync(log, "w")
  const started = performance.now()
  const result = (() => {
    try {
      return spawnSync(step.cmd, step.args, { cwd: step.cwd, env: { ...process.env, ...step.env }, stdio: ["ignore", fd, fd] })
    } finally {
      closeSync(fd)
    }
  })()
  // ENOENT or a signal leaves no exit status; the log says why.
  if (result.error !== undefined) appendFileSync(log, `\nspawn error: ${result.error.message}\n`)
  if (result.signal !== null) appendFileSync(log, `\nkilled by ${result.signal}\n`)
  const ok = result.status === 0
  console.log(`${ok ? "pass" : "FAIL"}  ${step.name}  ${((performance.now() - started) / 1000).toFixed(1)}s`)
  if (!ok) {
    failed += 1
    console.log(tail(log, 40))
    console.log(`full output: ${log}`)
    if (step.gate === true) break
  }
}
console.log(failed === 0 ? "full-check passed" : `full-check failed: ${failed} step(s)`)
process.exit(failed === 0 ? 0 : 1)
