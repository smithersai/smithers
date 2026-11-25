// fast-check, tier 1 of the tiered backpressure protocol (plan tree M0, `plan/m0/tiered-backpressure-workflows`).
// Runs on every edit and should finish in 5 to 30 seconds: the tests next to the changed files, a typecheck of each
// apps/mvp project they belong to, and a copy scan of changed docs. It runs with plain Node, so it works before the
// Gate 2 reader of `.smithers/workflows/` exists:
//
//   node .smithers/workflows/fast-check.ts                 changed files from `jj diff`
//   node .smithers/workflows/fast-check.ts <file> ...      the files you name
//
// It exits 0 when every step passes and 1 otherwise, and prints one line per step. medium-check and full-check
// follow as their own files once this tier has run on real edits.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

const root = spawnSync("jj", ["root"], { encoding: "utf8" }).stdout.trim() || process.cwd()
const mvp = join(root, "apps/mvp")
const bin = (name: string) => join(mvp, "node_modules/.bin", name)

const changedFiles = (): Array<string> => {
  if (process.argv.length > 2) return process.argv.slice(2).map((file) => relative(root, join(process.cwd(), file)))
  const diff = spawnSync("jj", ["diff", "--name-only"], { cwd: root, encoding: "utf8" })
  if (diff.status !== 0) throw new Error(`jj diff failed: ${diff.stderr}`)
  return diff.stdout.split("\n").filter((line) => line !== "")
}

const files = changedFiles().filter((file) => existsSync(join(root, file)))

/** A changed test, or the test beside a changed source file. */
const tests = [...new Set(files.flatMap((file) => {
  if (!file.startsWith("apps/mvp/") || !/\.(ts|vibe)$/.test(file)) return []
  if (/\.test\.(ts|vibe)$/.test(file)) return [file]
  const beside = file.replace(/\.(ts|vibe)$/, ".test.ts")
  return existsSync(join(root, beside)) ? [beside] : []
}))].map((file) => relative(mvp, join(root, file)))

/** Each apps/mvp vibelang project that holds a changed file. */
const projects = [...new Set(files.flatMap((file) => {
  if (!/^apps\/mvp\/.*\.(ts|tsx|vibe)$/.test(file)) return []
  if (file.startsWith("apps/mvp/worker/") || file.startsWith("apps/mvp/db/")) return ["worker/tsconfig.json"]
  if (file.startsWith("apps/mvp/src/") || file.startsWith("apps/mvp/plugins/")) return ["tsconfig.json"]
  return []
}))]

/** Changed docs: em dashes anywhere, semicolons in prose outside code fences and frontmatter. */
const copyFindings = files.filter((file) => file.endsWith(".md")).flatMap((file) => {
  let fenced = false
  let frontmatter = false
  return readFileSync(join(root, file), "utf8").split("\n").flatMap((line, index) => {
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
  readonly run: () => { readonly ok: boolean; readonly detail: string }
}

const command = (cmd: string, args: ReadonlyArray<string>) => () => {
  const result = spawnSync(cmd, args, { cwd: mvp, encoding: "utf8" })
  const output = `${result.stdout}${result.stderr}`
  return { ok: result.status === 0, detail: result.status === 0 ? "" : output.split("\n").slice(-40).join("\n") }
}

const steps: Array<Step> = [
  ...(tests.length === 0 ? [] : [{
    name: `vitest ${tests.length} file(s)`,
    run: command(bin("vitest"), ["run", "--coverage.enabled=false", ...tests]),
  }]),
  ...projects.map((project) => ({ name: `typecheck ${project}`, run: command(bin("vibelang"), ["-p", project]) })),
  {
    name: "copy scan",
    run: () => ({ ok: copyFindings.length === 0, detail: copyFindings.map((at) => `semicolon or em dash at ${at}`).join("\n") }),
  },
]

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
