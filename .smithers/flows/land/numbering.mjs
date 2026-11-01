#!/usr/bin/env node
/** Allocate only incoming identities against main; published migration IDs never change. */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { join, basename } from "node:path"
import { pathToFileURL } from "node:url"

export const decisions = "apps/mvp/docs/decisions"
export const migrations = "apps/mvp/db/migrations"

export function jj(root, args) {
  const result = spawnSync("jj", ["--color=never", "--no-pager", "--config", "snapshot.auto-update-stale=false", ...args], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60000 })
  if (result.error || result.status !== 0) throw new Error(`jj ${args[0]}: ${result.error?.message ?? result.stderr}`)
  return result.stdout.trimEnd()
}
const lines = (text) => text ? text.split("\n") : []
const files = (root, rev, directory) => lines(jj(root, ["file", "list", "--ignore-working-copy", "-r", rev, directory]))
const identity = (path, directory) => {
  const match = basename(path).match(directory === decisions ? /^(\d{4,})-(.+)\.md$/ : /^(\d{4,})_(.+)\.ts$/)
  if (!match || match[2].endsWith(".test") || (directory === decisions && match[2].endsWith("-comparison"))) return undefined
  return { path, id: Number(match[1]), digits: match[1], slug: match[2], stem: basename(path).replace(/\.(md|ts)$/, "") }
}

/** Fail on duplicate numeric identities, including names differing only by slug. */
export function unique(paths, directory) {
  const seen = new Map()
  for (const path of paths) {
    const entry = identity(path, directory)
    if (!entry) continue
    if (seen.has(entry.id) && !(directory === decisions && entry.id === 38 &&
      new Set([seen.get(entry.id), path]).size === 2 &&
      [seen.get(entry.id), path].every((item) => ["apps/mvp/docs/decisions/0038-todo-retry.md", "apps/mvp/docs/decisions/0038-offline-branch-conversations.md"].includes(item)))) throw new Error(`Duplicate ${directory} number ${entry.digits}: ${seen.get(entry.id)}, ${path}`)
    seen.set(entry.id, path)
  }
}

/** Plan renames before rebasing, when each lane's additions are still unambiguous. */
export function planNumbers(root, target = "main@origin") {
  jj(root, ["status"])
  const base = jj(root, ["log", "--ignore-working-copy", "-r", `heads(::@ & ::${target})`, "--no-graph", "-T", 'commit_id ++ "\\n"'])
  if (!base || base.includes("\n")) throw new Error("Number allocation requires one common ancestor")
  const renames = []
  for (const directory of [decisions, migrations]) {
    const prior = new Set(files(root, base, directory))
    const current = files(root, "@", directory)
    const published = files(root, target, directory)
    unique(published, directory)
    if (directory === migrations) {
      const changed = lines(jj(root, ["diff", "--from", base, "--to", "@", "--name-only", directory]))
      for (const path of changed) if (prior.has(path) && identity(path, directory)) {
        throw new Error(`Published migration is immutable: ${path}; add a new migration instead`)
      }
    }
    unique(current, directory)
    const incoming = current.filter((path) => !prior.has(path)).map((path) => identity(path, directory)).filter(Boolean)
      .sort((a, b) => a.id - b.id || a.path.localeCompare(b.path))
    const used = new Set(published.map((path) => identity(path, directory)?.id).filter((id) => id !== undefined))
    let last = Math.max(0, ...used)
    for (const entry of incoming) {
      // Every incoming migration must follow every published one, even without a duplicate.
      const next = used.has(entry.id) || (directory === migrations && entry.id <= last) ? last + 1 : entry.id
      used.add(next)
      last = Math.max(last, next)
      if (next !== entry.id) {
        const digits = String(next).padStart(4, "0")
        const stem = `${digits}${directory === decisions ? "-" : "_"}${entry.slug}`
        renames.push({ ...entry, directory, next, to: join(directory, `${stem}${directory === decisions ? ".md" : ".ts"}`), newStem: stem })
      }
    }
  }
  return { base, target, renames }
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Only rewrite lane-added lines; existing historical test boundaries stay byte-identical. */
export function applyNumbers(root, plan) {
  const changed = lines(jj(root, ["diff", "--from", plan.base, "--to", "@", "--name-only"]))
  const writes = []
  for (const path of changed) {
    const absolute = join(root, path)
    if (!existsSync(absolute)) continue
    const original = readFileSync(absolute)
    if (original.includes(0)) continue
    const source = original.toString("utf8").split("\n")
    const added = new Set()
    const patch = jj(root, ["diff", "--from", plan.base, "--to", "@", "--git", "--context", "0", path])
    let line = 0
    for (const row of patch.split("\n")) {
      const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (hunk) line = Number(hunk[1]) - 1
      else if (row.startsWith("+") && !row.startsWith("+++")) added.add(line++)
      else if (row.startsWith(" ")) line++
    }
    const migrationRenames = plan.renames.filter((entry) => entry.directory === migrations)
    const numberMap = new Map(migrationRenames.map((entry) => [entry.digits, String(entry.next).padStart(4, "0")]))
    if (migrationRenames.length) {
      const first = migrationRenames[0]
      numberMap.set(String(first.id - 1).padStart(4, "0"), String(first.next - 1).padStart(4, "0"))
    }
    for (const index of added) {
      let text = source[index]
      // One pass prevents cascading 0080 -> 0081 -> 0082 rewrites.
      const replacements = new Map()
      for (const entry of plan.renames) {
        replacements.set(entry.stem, entry.newStem)
        if (entry.directory === migrations) replacements.set(`${entry.id}_${entry.slug}`, `${entry.next}_${entry.slug}`)
      }
      if (replacements.size) text = text.replace(new RegExp([...replacements.keys()].sort((a, b) => b.length - a.length).map(escape).join("|"), "g"), (value) => replacements.get(value))
      // through("NNNN") and exact quoted boundaries occur only in added migration tests.
      if (path.startsWith("apps/mvp/db/") && /\.test\.[cm]?ts$/.test(path)) {
        text = text.replace(/(["'])(\d{4})\1/g, (match, quote, id) => numberMap.has(id) ? `${quote}${numberMap.get(id)}${quote}` : match)
      }
      source[index] = text
    }
    const next = source.join("\n")
    if (next !== original.toString("utf8")) writes.push([absolute, next])
  }
  // Validate all destinations before touching any files.
  for (const entry of plan.renames) if (existsSync(join(root, entry.to))) throw new Error(`Rename destination exists: ${entry.to}`)
  for (const [path, text] of writes) writeFileSync(path, text)
  for (const entry of plan.renames) renameSync(join(root, entry.path), join(root, entry.to))
  return plan.renames
}

/** Checks numeric uniqueness and exact registration without requiring an install. */
export function checkNumbers(root) {
  const treeFiles = (directory) => existsSync(join(root, directory)) ? readdirSync(join(root, directory)).map((name) => `${directory}/${name}`) : []
  for (const directory of [decisions, migrations]) unique(treeFiles(directory), directory)
  const manifest = join(root, "apps/mvp/db/MigrationManifest.ts")
  const database = existsSync(manifest) ? manifest : join(root, "apps/mvp/db/Database.ts")
  if (existsSync(database)) {
    const source = readFileSync(database, "utf8")
    for (const path of treeFiles(migrations)) {
      const entry = identity(path, migrations)
      if (!entry) continue
      if (!source.includes(`./migrations/${basename(path)}`) || !source.includes(`"${entry.stem}":`)) throw new Error(`Unregistered migration: ${path}`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = jj(process.cwd(), ["workspace", "root"])
    const args = process.argv.slice(2)
    if (args[0] === "check") checkNumbers(root)
    else if (args[0] === "prepare" && args.length <= 2) {
      const plan = planNumbers(root, args[1] ?? "main@origin")
      for (const entry of applyNumbers(root, plan)) console.log(`RENUMBER ${entry.path} -> ${entry.to}`)
      checkNumbers(root)
    } else throw new Error("Usage: node .smithers/flows/land/numbering.mjs check|prepare [main@origin]\nprepare before rebase, under main-push.lock after fetch")
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
