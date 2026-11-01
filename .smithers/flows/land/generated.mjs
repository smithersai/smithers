/** Rebuild generated migration registration and merge append-only schema history at landing. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { jj, migrations } from "./numbering.mjs"

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

/** Capture each side before rebase so conflict markers are never parsed as source or JSON. */
export function captureGenerated(root, target) {
  jj(root, ["status"])
  const base = jj(root, ["log", "--ignore-working-copy", "-r", `heads(::@ & ::${target})`, "--no-graph", "-T", "commit_id"])
  if (!base || /\n/.test(base)) throw new Error("Generated preparation needs one common ancestor")
  const result = { target, base, files: {} }
  for (const path of [databasePath, schemaPath]) {
    result.files[path] = { base: at(root, base, path), local: at(root, "@", path), remote: at(root, target, path) }
  }
  return result
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
  if (db.local !== undefined || db.remote !== undefined) {
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
  if (history.local !== undefined || history.remote !== undefined) {
    const parse = (text) => {
      if (text === undefined) return undefined
      const value = JSON.parse(text)
      delete value.epoch
      return value
    }
    const merged = mergeHistory(parse(history.base), parse(history.local), parse(history.remote))
    if (merged === undefined) throw new Error("Refusing to remove device schema history")
    writes.push([schemaPath, `${JSON.stringify(merged, null, 2)}\n`])
  }
  // Validate every merge before writing any result.
  for (const [path, contents] of writes) writeFileSync(join(root, path), contents)
  return writes.map(([path]) => path)
}

/** Source-only migration registry drift check, also runnable in a VCS-free test checkout. */
export function checkManifest(root) {
  if (!existsSync(join(root, manifestPath))) return
  if (readFileSync(join(root, manifestPath), "utf8") !== migrationManifest(readdirSync(join(root, migrations)))) {
    throw new Error("MigrationManifest.ts drift: run workspace sync before landing")
  }
}
