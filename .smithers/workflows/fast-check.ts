// fast-check, tier 1 of the tiered backpressure protocol (plan tree M0, `plan/m0/tiered-backpressure-workflows`).
// Runs on every edit and should finish in 5 to 30 seconds: the tests next to the changed files, a typecheck of each
// apps/mvp project they belong to, and a copy scan of changed docs. It runs with plain Node, so it works before the
// Gate 2 reader of `.smithers/workflows/` exists:
//
//   node .smithers/workflows/fast-check.ts                 changed files from `jj diff`
//   node .smithers/workflows/fast-check.ts <file> ...      the files you name
//   node .smithers/workflows/fast-check.ts --dry-run       print the plan and exit 0
//
// It exits 0 when every step passes and 1 otherwise, and prints one line per step. medium-check.ts and full-check.ts
// beside it are tiers 2 and 3.
import { spawnSync } from "node:child_process"
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

// The real checkout: every file this tier reads must resolve under it, symlinks followed, even under `--dry-run`.
const root = realpathSync(spawnSync("jj", ["root"], { encoding: "utf8" }).stdout.trim() || process.cwd())
const mvp = join(root, "apps/mvp")
const bin = (name: string) => join(mvp, "node_modules/.bin", name)

const dryRun = process.argv.includes("--dry-run")
const named = process.argv.slice(2).filter((arg) => arg !== "--dry-run")

const changedFiles = (): Array<string> => {
  if (named.length > 0) return named.map((file) => relative(root, resolve(process.cwd(), file)))
  const diff = spawnSync("jj", ["diff", "--name-only"], { cwd: root, encoding: "utf8" })
  if (diff.status !== 0) throw new Error(`jj diff failed: ${diff.stderr}`)
  return diff.stdout.split("\n").filter((line) => line !== "")
}

/** The real path of `file` when it is a regular file under the real checkout. */
const confined = (file: string): string | undefined => {
  try {
    const real = realpathSync(join(root, file))
    return real.startsWith(`${root}/`) && statSync(real).isFile() ? real : undefined
  } catch {
    return undefined
  }
}

const present = (file: string) => {
  try {
    lstatSync(join(root, file))
    return true
  } catch {
    return false
  }
}

const climbs = (file: string) => file === ".." || file.startsWith("../") || isAbsolute(file)
const candidates = changedFiles()
/** Paths outside the checkout, or entries in it that resolve outside it or are not regular files: never read. */
const refused = candidates.filter((file) => climbs(file) || (present(file) && confined(file) === undefined))
const files = candidates.filter((file) => !climbs(file) && confined(file) !== undefined)

/** A changed test, or the test beside a changed source file. */
const tests = [...new Set(files.flatMap((file) => {
  if (!file.startsWith("apps/mvp/") || !/\.(ts|vibe)$/.test(file)) return []
  if (/\.test\.(ts|vibe)$/.test(file)) return [file]
  const beside = file.replace(/\.(ts|vibe)$/, ".test.ts")
  return confined(beside) !== undefined ? [beside] : []
// `./` keeps a file named `-x.test.ts` out of Vitest's option parser.
}))].map((file) => `./${relative(mvp, join(root, file))}`)

/** Each apps/mvp vibelang project that holds a changed file. */
const projects = [...new Set(files.flatMap((file) => {
  if (!/^apps\/mvp\/.*\.(ts|tsx|vibe)$/.test(file)) return []
  if (file.startsWith("apps/mvp/worker/") || file.startsWith("apps/mvp/db/")) return ["worker/tsconfig.json"]
  if (file.startsWith("apps/mvp/src/") || file.startsWith("apps/mvp/plugins/")) return ["tsconfig.json"]
  return []
}))]

/** Read a confined regular file via O_NOFOLLOW fd so copy scan never follows a swapped symlink or runs during --dry-run. */
const readConfinedUtf8 = (file: string): string | undefined => {
  const real = confined(file)
  if (real === undefined) return undefined
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  let fd: number | undefined
  try {
    fd = openSync(real, flags)
    if (!fstatSync(fd).isFile()) return undefined
    return readFileSync(fd, "utf8")
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Changed docs: em dashes anywhere, semicolons in prose outside code fences and frontmatter. */
const scanCopy = () =>
  files.filter((file) => file.endsWith(".md")).flatMap((file) => {
    const content = readConfinedUtf8(file)
    if (content === undefined) return [`${file}:unreadable-or-escaped`]
    let fenced = false
    let frontmatter = false
    return content.split("\n").flatMap((line, index) => {
      if (index === 0 && line === "---") frontmatter = true
      else if (frontmatter && line === "---") frontmatter = false
      if (line.startsWith("```")) fenced = !fenced
      const prose = !fenced && !frontmatter && !line.startsWith("```")
      const text = line.replace(/`[^`]*`/g, "")
      const found = line.includes("—") || (prose && text.includes(";"))
      return found ? [`${file}:${index + 1}`] : []
    })
  })

interface Step {
  readonly name: string
  /** The command it runs, for `--dry-run`. */
  readonly plan: string
  /** A step that fails without running: a path this tier will not read. */
  readonly refuse?: boolean
  readonly run: () => { readonly ok: boolean; readonly detail: string }
}

// Stream subprocess output to a temp log file so wide fan-out Vitest runs (>64 MiB stdout) never hit ENOBUFS.
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

const command = (cmd: string, args: ReadonlyArray<string>) => () => {
  const dir = mkdtempSync(join(tmpdir(), "fast-check-"))
  const log = join(dir, "step.log")
  const out = openSync(log, "w")
  let closed = false
  try {
    const result = spawnSync(cmd, args, { cwd: mvp, stdio: ["ignore", out, out] })
    closeSync(out)
    closed = true
    if (result.error) return { ok: false, detail: String(result.error) }
    return { ok: result.status === 0, detail: result.status === 0 ? "" : tail(log, 40) }
  } finally {
    if (!closed) closeSync(out)
    rmSync(dir, { recursive: true, force: true })
  }
}

const steps: Array<Step> = [
  ...(refused.length === 0 ? [] : [{
    name: "confine",
    plan: `${refused.length} path(s) outside the checkout: ${refused.join(" ")}`,
    refuse: true,
    run: () => ({ ok: false, detail: refused.map((file) => `outside the checkout: ${file}`).join("\n") }),
  }]),
  ...(tests.length === 0 ? [] : [{
    name: `vitest ${tests.length} file(s)`,
    plan: `vitest run --coverage.enabled=false ${tests.join(" ")}`,
    run: command(bin("vitest"), ["run", "--coverage.enabled=false", ...tests]),
  }]),
  ...projects.map((project) => ({
    name: `typecheck ${project}`,
    plan: `vibelang -p ${project}`,
    run: command(bin("vibelang"), ["-p", project]) })),
  {
    name: "copy scan",
    plan: `${files.filter((file) => file.endsWith(".md")).length} changed doc(s)`,
    run: () => { const copyFindings = scanCopy(); return { ok: copyFindings.length === 0, detail: copyFindings.map((at) => `semicolon or em dash at ${at}`).join("\n") } },
  },
]

if (dryRun) {
  console.log(`fast-check plan: ${steps.length} step(s) for ${files.length} changed file(s)`)
  for (const step of steps) console.log(`${step.refuse === true ? "refuse" : "plan"}  ${step.name}  ${step.plan}`)
  process.exit(0)
}

console.log(`fast-check: ${files.length} changed file(s)`)
let failed = 0
for (const step of steps) {
  const started = performance.now()
  const { ok, detail } = step.run()
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  console.log(`${ok ? "pass" : "FAIL"}  ${step.name}  ${seconds}s`)
  if (!ok) {
    failed += 1
    console.log(detail)
  }
}
console.log(failed === 0 ? "fast-check passed" : `fast-check failed: ${failed} step(s)`)
process.exit(failed === 0 ? 0 : 1)
