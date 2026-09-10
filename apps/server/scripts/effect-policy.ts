/**
 * The Effect policy check: `pnpm run check:effect`.
 *
 * Production modules under src/ are Effects end to end. Promise interop
 * lives only at the platform boundaries CONTRACTS.md names, so this script
 * scans every src/**\/*.ts that is not a test and fails on:
 *
 *   `async `, `await `, `.then(`, `Effect.runPromise`, `Effect.runFork`,
 *   `runWeb`, `EffectPlatform`
 *
 * outside the allowlist below. A native Durable Object class's `fetch` line
 * is the one in-module boundary the contract allows; it carries the trailing
 * marker `// effect-policy: boundary`, and only a line carrying that marker
 * is exempt inside a non-allowlisted file. Comments are stripped before
 * matching so prose can name the words.
 *
 * The scanner is exported and pure (`scanSource`) so scripts/effect-policy.test.ts
 * can hold it to fixtures; `main` walks the tree.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

export const BOUNDARY_MARKER = "// effect-policy: boundary"

/** Files whose whole body is a platform boundary (CONTRACTS.md "Non-negotiables"). */
export const ALLOWED_FILES: ReadonlyArray<string> = ["src/Http.ts", "src/DurableStorage.ts", "src/Boundary.ts", "src/Worker.ts"]

export interface PolicyRule {
  readonly name: string
  readonly pattern: RegExp
}

export const RULES: ReadonlyArray<PolicyRule> = [
  { name: "async", pattern: /\basync\s/ },
  { name: "await", pattern: /\bawait\s/ },
  { name: ".then(", pattern: /\.then\(/ },
  { name: "Effect.runPromise", pattern: /Effect\.runPromise/ },
  { name: "Effect.runFork", pattern: /Effect\.runFork/ },
  { name: "runWeb", pattern: /\brunWeb\b/ },
  { name: "EffectPlatform", pattern: /EffectPlatform/ }
]

export interface Violation {
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly text: string
}

/** Strip `//` and `/* *\/` comments so prose cannot trip a rule; string contents stay (a rule in a string is still worth a look). */
export const stripComments = (source: string): string => {
  let out = ""
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2)
      const stop = end === -1 ? source.length : end + 2
      // keep the newlines so line numbers survive
      out += source.slice(i, stop).replace(/[^\n]/g, "")
      i = stop
    } else if (two === "//") {
      const end = source.indexOf("\n", i)
      i = end === -1 ? source.length : end
    } else {
      out += source[i]
      i += 1
    }
  }
  return out
}

/** Is this path (repo-relative, posix) a production module the policy covers? */
export const isProductionModule = (file: string): boolean =>
  file.startsWith("src/") && file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts")

export const scanSource = (file: string, source: string): ReadonlyArray<Violation> => {
  if (!isProductionModule(file) || ALLOWED_FILES.includes(file)) return []
  const rawLines = source.split("\n")
  const lines = stripComments(source).split("\n")
  const violations: Violation[] = []
  lines.forEach((line, index) => {
    if (rawLines[index]?.includes(BOUNDARY_MARKER)) return
    for (const rule of RULES) {
      if (rule.pattern.test(line)) violations.push({ file, line: index + 1, rule: rule.name, text: rawLines[index]?.trim() ?? "" })
    }
  })
  return violations
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

export const scanTree = (packageDir: string): ReadonlyArray<Violation> =>
  walk(join(packageDir, "src"))
    .map((full) => relative(packageDir, full).split("\\").join("/"))
    .filter(isProductionModule)
    .sort()
    .flatMap((file) => scanSource(file, readFileSync(join(packageDir, file), "utf8")))

const main = (): number => {
  const packageDir = fileURLToPath(new URL("..", import.meta.url))
  const violations = scanTree(packageDir)
  if (violations.length === 0) {
    console.log("[effect-policy] ok: no promise interop outside the boundary allowlist")
    return 0
  }
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.text}`)
  }
  console.error(
    `[effect-policy] ${violations.length} violation(s). Production modules are Effects; promise interop belongs in ` +
      `${ALLOWED_FILES.join(", ")} or on a native Durable Object fetch line marked \`${BOUNDARY_MARKER}\`.`
  )
  return 1
}

if (import.meta.main) process.exit(main())
