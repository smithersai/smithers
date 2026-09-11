#!/usr/bin/env node
// Guard: this repo's own scripts must execute the Smithers *working tree*,
// never an installed copy.
//
// `bunx smthrs` downloads and runs a published npm tarball. Inside this
// checkout it may re-exec back into the working tree through the published
// bin's delegation, but that is a fallback, not a guarantee: it needs an
// installed `node_modules`, so a fresh worktree or a slimmed checkout silently
// runs a release build instead of the code under edit. Internal scripts
// therefore name the source entry (SOURCE_ENTRY below) directly.
//
// User-facing prose still says `bunx smthrs`: that is the right command for
// someone who has no checkout, and this repo's text is full of it legitimately
// in agent prompts, docs assertions, and fixtures. So the scan only looks at
// positions that actually spawn a process: `package.json` scripts, shell
// scripts, agent-harness server and monitor configs, and JS/TS lines carrying a
// shell-execution call. The few execution sites that must keep the published
// fallback are allowlisted below with a reason.
//
// Run: node scripts/check-local-smithers.mjs

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

import { isMain, repoRoot } from "./workspace-packages.mjs"

export const REPO_ROOT = repoRoot

/**
 * The working-tree entry an internal script must name.
 *
 * The user-facing binary is `packages/smithers/bin/smithers.mjs`. The shim runs
 * `dist/esm/bin.js` when a published install has one and `src/bin.ts`
 * otherwise, so naming it here covers both.
 */
export const SOURCE_ENTRY = "packages/smithers/bin/smithers.mjs"

/**
 * Directories (and single files) whose code executes the Smithers CLI.
 *
 * `flows/` holds this repository's own 1.0 flows; the 0.x `.smithers/*`
 * directories it replaces are gone. A path that does not exist yet is skipped,
 * so the roster can name an optional directory.
 */
export const SCANNED_PATHS = [
  "package.json",
  "scripts",
  "flows",
  "evals",
  "examples",
]

/** Extensions worth scanning; everything else in those trees is prose or data. */
export const SCANNED_EXTENSIONS = [".mjs", ".js", ".cjs", ".ts", ".tsx", ".json", ".sh", ".toml"]

/** Never descend into these directory names. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  "target",
  ".git",
  ".jj",
])

/**
 * Files that may keep a published-CLI invocation, each with the reason it is
 * not a defect. Keys are repo-relative POSIX paths.
 */
export const ALLOWLIST = {
  "scripts/check-local-smithers.mjs": "this guard names the patterns it forbids",
  "scripts/check-local-smithers.test.mjs": "exercises the guard with sample violations",
}

/** Package managers that fetch and run the published CLI. */
const RUNNERS = ["bunx", "npx", "pnpm dlx", "yarn dlx", "deno run -A npm:"]

/** Config files whose every line is a command the harness will execute. */
const EXECUTED_CONFIG_FILES = new Set([".mcp.json", "monitors.json"])

/** Calls that hand a string to a shell. A match on such a line is an invocation. */
const EXECUTION_CALLS = [
  "$`",
  "$(",
  "spawn(",
  "spawnSync(",
  "exec(",
  "execSync(",
  "execFile(",
  "execFileSync(",
  "execa(",
  "Bun.spawn",
  "Bun.$",
]

/**
 * True when a source line is entirely a comment, so an explanatory mention of
 * the published command is not an invocation.
 *
 * @param {string} line
 */
export function isCommentLine(line) {
  const trimmed = line.trim()
  return trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*")
}

/**
 * @param {string} line
 */
function mentionsPublishedCli(line) {
  return RUNNERS.some((runner) => line.includes(`${runner} smthrs`))
}

/**
 * Find published-CLI *invocations* in one file. Mentions in prose — agent
 * prompts, docs assertions, rendered marketing copy — are not invocations and
 * are deliberately left alone; see the header for why.
 *
 * @param {string} path Repo-relative POSIX path, used for reporting.
 * @param {string} contents
 * @returns {{ path: string, line: number, text: string }[]}
 */
export function findViolationsInFile(path, contents) {
  if (Object.hasOwn(ALLOWLIST, path)) return []
  const fileName = path.split("/").pop() ?? path

  // `package.json`: only the scripts the package manager runs.
  if (fileName === "package.json") {
    let scripts
    try {
      scripts = JSON.parse(contents)?.scripts
    } catch {
      return []
    }
    if (!scripts || typeof scripts !== "object") return []
    const lines = contents.split("\n")
    return Object.entries(scripts)
      .filter(([, command]) => typeof command === "string" && mentionsPublishedCli(command))
      .map(([name, command]) => ({
        path,
        line: lines.findIndex((line) => line.includes(`"${name}":`)) + 1,
        text: `${name}: ${command}`,
      }))
  }

  const everyLineExecutes = fileName.endsWith(".sh") || EXECUTED_CONFIG_FILES.has(fileName)
  const violations = []
  const lines = contents.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (isCommentLine(line) || !mentionsPublishedCli(line)) continue
    if (!everyLineExecutes && !EXECUTION_CALLS.some((call) => line.includes(call))) continue
    violations.push({ path, line: index + 1, text: line.trim() })
  }
  return violations
}

/**
 * @param {string} directory Absolute path.
 * @returns {string[]} Absolute paths of scannable files.
 */
function collectFiles(directory) {
  const found = []
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".mcp.json" && entry.name !== ".smithers") {
      continue
    }
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      found.push(...collectFiles(full))
    } else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(full)
    }
  }
  return found
}

/**
 * @param {string} [root]
 * @returns {string[]} Repo-relative POSIX paths to scan.
 */
export function listScannedFiles(root = REPO_ROOT) {
  const files = []
  for (const entry of SCANNED_PATHS) {
    const absolute = join(root, entry)
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      continue
    }
    if (stats.isDirectory()) files.push(...collectFiles(absolute))
    else files.push(absolute)
  }
  return files.map((file) => relative(root, file).split(sep).join("/")).sort()
}

/**
 * @param {string} [root]
 * @returns {{ violations: { path: string, line: number, text: string }[] }}
 */
export function check(root = REPO_ROOT) {
  const violations = []
  for (const path of listScannedFiles(root)) {
    let contents
    try {
      contents = readFileSync(join(root, path), "utf8")
    } catch {
      continue
    }
    violations.push(...findViolationsInFile(path, contents))
  }
  return { violations }
}

const invokedDirectly = isMain(import.meta)
if (invokedDirectly) {
  const { violations } = check()
  for (const violation of violations) {
    console.error(`check-local-smithers: ${violation.path}:${violation.line}: ${violation.text}`)
  }
  if (violations.length) {
    console.error(
      "\nInternal scripts must execute the working tree, not the published package.\n" +
        `  - shell and npm scripts: run ${SOURCE_ENTRY}\n` +
        "If a file genuinely needs the published fallback, add it to ALLOWLIST in " +
        "scripts/check-local-smithers.mjs with the reason.",
    )
    process.exit(1)
  }
  console.log("check-local-smithers: internal scripts run the Smithers working tree")
}
