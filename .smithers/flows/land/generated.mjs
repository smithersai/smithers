/** Rebuild generated migration registration and merge append-only schema history at landing. */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { sourcePath, writeSource } from "./files.mjs"
import { eachLaneCommit, jj, laneCommits, migrations } from "./numbering.mjs"

export const databasePath = "apps/mvp/db/Database.ts"
export const manifestPath = "apps/mvp/db/MigrationManifest.ts"
export const schemaPath = "apps/mvp/src/device/schemas.lock.json"
export const indexPath = ".smithers/target-index.json"
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Three-way structural merge; a different fingerprint for the same version always stops landing. */
export function mergeHistory(base, local, remote, path = "lock") {
  if (same(local, remote)) return local
  if (same(local, base)) return remote
  if (same(remote, base)) return local
  if ([base, local, remote].every((value) => value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value)))) {
    const result = {}
    for (const key of [...new Set([base, local, remote].flatMap((value) => Object.keys(value ?? {})))].sort()) {
      const value = mergeHistory(base?.[key], local?.[key], remote?.[key], `${path}.${key}`)
      if (value !== undefined) result[key] = value
    }
    return result
  }
  if (path === "lock.mutations" && [base, local, remote].every((value) => value === undefined || (Array.isArray(value) && value.every((name) => typeof name === "string")))) {
    return [...new Set([...(base ?? []), ...(local ?? []), ...(remote ?? [])])].sort().filter((name) =>
      mergeHistory((base ?? []).includes(name), (local ?? []).includes(name), (remote ?? []).includes(name), `${path}.${name}`))
  }
  throw new Error(`Generated history conflict at ${path}; preserve both versions and add a migration`)
}

const at = (root, rev, path) => {
  const listed = jj(root, ["file", "list", "--ignore-working-copy", "-r", rev, path])
  if (!listed) return undefined
  // file show is text, but unlike the jj helper it must retain the final newline.
  return `${jj(root, ["file", "show", "--ignore-working-copy", "-r", rev, path])}\n`
}

/** Separate generated import/registration lines from the hand-authored database services. */
export function databaseTemplate(source) {
  if (source === undefined) return undefined
  return source
    .replace(/^import .* from ["']\.\/migrations\/[^"']+["'];?\r?\n/gm, "")
    .replace(/^import \{ migrations \} from "\.\/MigrationManifest\.ts"\r?\n/gm, "")
    .replace(/^export \{ migrations \}\r?\n/gm, "")
    .replace(/^\/\*\* Every migration in `db\/migrations`, by `<id>_<name>`\. \*\/\r?\n/m, "")
    .replace(/^export const migrations = \{[\s\S]*?^\}\s*\n/m, "")
    .replace(/^\s*\n/, "")
}

/** Existing schema versions are immutable even when only one side edited its lock. */
export function checkHistory(base, next) {
  if (!base) return
  for (const family of ["stores", "payloads"]) for (const [id, entry] of Object.entries(base[family] ?? {})) {
    if (!next?.[family]?.[id] || next[family][id].kind !== entry.kind) throw new Error(`Schema history is immutable at ${family}.${id}`)
    for (const [version, fingerprint] of Object.entries(entry.versions)) {
      if (next[family][id].versions?.[version] !== fingerprint) throw new Error(`Schema history is immutable at ${family}.${id}.versions.${version}`)
    }
  }
}

/** Normalize old in-flight lock writers without importing the installed SDK into bootstrap tooling. */
export function canonicalHistory(history) {
  const ordered = (entries) => Object.fromEntries(Object.keys(entries ?? {}).sort().map((id) => [id, {
    ...entries[id],
    versions: Object.fromEntries(Object.entries(entries[id].versions).sort(([a], [b]) => Number(a) - Number(b)))
  }]))
  // The SDK's snapshot order (stores, payloads, mutations), whatever order a merge built the keys in.
  const { stores, payloads, mutations, ...rest } = history
  return { stores: ordered(stores), payloads: ordered(payloads), mutations: [...new Set(mutations ?? [])].sort(), ...rest }
}

/** Capture each side before rebase so conflict markers are never parsed as source or JSON. */
export function captureGenerated(root, target, revision = "@") {
  jj(root, ["status"])
  const base = jj(root, ["log", "--ignore-working-copy", "-r", `heads(::@ & ::${target})`, "--no-graph", "-T", "commit_id"])
  if (!base || /\n/.test(base)) throw new Error("Generated preparation needs one common ancestor")
  const result = { target, base, files: {} }
  for (const path of [databasePath, schemaPath]) {
    result.files[path] = { base: at(root, base, path), local: at(root, revision, path), remote: at(root, target, path) }
  }
  // A lane already on the manifest registers migrations there and leaves Database.ts alone.
  result.registers = at(root, base, manifestPath) !== at(root, revision, manifestPath)
  return result
}

/** `captureGenerated` for every commit of the lane, oldest first, before the rebase. */
export function captureLane(root, target) {
  const { base } = captureGenerated(root, target)
  return laneCommits(root, base).map((change) => ({ change, context: captureGenerated(root, target, change) }))
}

/**
 * After the rebase, `repairGenerated` in each lane commit, for the generated files that commit's lane had changed by
 * then: every commit of a stacked lane registers its own migrations and merges its own schema history.
 */
export function repairLane(root, captured) {
  const contexts = new Map(captured.map((entry) => [entry.change, entry.context]))
  const written = []
  eachLaneCommit(root, captured.map((entry) => entry.change), (change) => {
    const context = contexts.get(change)
    const files = Object.fromEntries(Object.entries(context.files).filter(([path, sides]) =>
      sides.local !== sides.base || (path === databasePath && context.registers)))
    const paths = repairGenerated(root, { ...context, files })
    written.push(...paths.map((path) => `${change} ${path}`))
    // Restore only what was repaired; a commit that changed no generated file is left as it is.
    return paths
  })
  return written
}

/** Static imports work in Workers and preserve Effect SQL's existing numeric ledger keys. */
export function migrationManifest(names) {
  const sorted = names.filter((name) => /^\d{4}_[a-zA-Z0-9_]+\.ts$/.test(name)).sort()
  const seen = new Set()
  for (const name of sorted) {
    const id = Number(name.slice(0, 4))
    if (seen.has(id)) throw new Error(`Duplicate migration number: ${id}`)
    seen.add(id)
  }
  return '/** Generated from db/migrations by the parallel workspace landing tool. */\n' +
    sorted.map((name) => `import m${name.slice(0, 4)} from "./migrations/${name}"\n`).join("") +
    '\n/** Every published migration identity, in ascending apply order. */\nexport const migrations = {\n' +
    sorted.map((name) => `  "${name.slice(0, -3)}": m${name.slice(0, 4)},\n`).join("") + '}\n'
}

/** Repair only known generated data. Hand-authored service changes remain real conflicts. */
export function repairGenerated(root, context) {
  const writes = []
  const db = context.files[databasePath]
  if (db !== undefined && (db.local !== undefined || db.remote !== undefined)) {
    const a = databaseTemplate(db.base), b = databaseTemplate(db.local), c = databaseTemplate(db.remote)
    let template
    if (b === c || c === a) template = b
    else if (b === a) template = c
    else throw new Error("Database services changed on both sides; resolve Database.ts before landing")
    if (template === undefined) throw new Error("Refusing to remove database services")
    const registered = migrationManifest(readdirSync(join(root, migrations)))
    writes.push([manifestPath, registered], [databasePath, `import { migrations } from "./MigrationManifest.ts"\nexport { migrations }\n${template}`])
  }
  const history = context.files[schemaPath]
  if (history !== undefined && (history.local !== undefined || history.remote !== undefined)) {
    const parse = (text) => {
      if (text === undefined) return undefined
      const value = JSON.parse(text)
      delete value.epoch
      return value
    }
    const base = parse(history.base), local = parse(history.local), remote = parse(history.remote)
    checkHistory(base, local)
    checkHistory(base, remote)
    const merged = mergeHistory(base, local, remote)
    if (merged === undefined) throw new Error("Refusing to remove device schema history")
    writes.push([schemaPath, `${JSON.stringify(canonicalHistory(merged), null, 2)}\n`])
  }
  // Validate every merge before writing any result.
  for (const [path] of writes) sourcePath(root, path)
  for (const [path, contents] of writes) writeSource(root, path, contents)
  return writes.map(([path]) => path)
}

/** Source-only migration registry drift check, also runnable in a VCS-free test checkout. */
export function checkManifest(root) {
  if (!existsSync(join(root, manifestPath))) return
  if (readFileSync(join(root, manifestPath), "utf8") !== migrationManifest(readdirSync(join(root, migrations)))) {
    throw new Error("MigrationManifest.ts drift: run workspace sync before landing")
  }
}
