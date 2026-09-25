#!/usr/bin/env node
// Keeps target results across the disposable revision exports coding checks
// run in. `seed <workspace>` copies the host partition into the export's
// `.flows/cache`; `save <workspace>` publishes entries the partition lacks.
// Publication is a copy then link(2), which refuses to replace a concurrent
// writer's entry; only an entry that no longer parses is replaced.
//
// The partition is named by the bytes of host tools the target key does not
// bind: Bun, JJ and the native exporter (and Node, which is key material, so
// a runtime change also starts clean). A VM image change starts a fresh
// partition instead of replaying results other tools produced.
//
// Trust: one workspace VM, one repository, one owner. Code a check runs has
// the same uid and could write this directory; an entry here is evidence for
// this host only, like a developer's own `.flows`.
import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const staleMs = 14 * 24 * 60 * 60 * 1000
const defaultMaxBytes = 2 * 1024 * 1024 * 1024

export const cacheRoot = (environment = process.env) => {
  const explicit = environment.SMITHERS_CHECK_CACHE_DIR
  if (explicit !== undefined && explicit !== "") {
    if (!path.isAbsolute(explicit)) throw new Error("SMITHERS_CHECK_CACHE_DIR must be absolute")
    return explicit
  }
  if (!environment.HOME) throw new Error("HOME or SMITHERS_CHECK_CACHE_DIR must name the check cache")
  return path.join(environment.HOME, ".cache", "smithers-checks", "cache")
}

const digestFile = (file) => {
  try {
    return createHash("sha256").update(fs.readFileSync(fs.realpathSync(file))).digest("hex")
  } catch {
    return null
  }
}

const onPath = (name, environment) => {
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (directory === "") continue
    const candidate = path.join(directory, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Not in this directory.
    }
  }
  return undefined
}

/** The host tool bytes a partition is named by; an absent tool is `null`. */
export const toolIdentity = (environment = process.env) => {
  const tool = (name) => {
    const found = onPath(name, environment)
    return found === undefined ? null : digestFile(found)
  }
  return {
    platform: `${process.platform}-${process.arch}`,
    node: digestFile(process.execPath),
    bun: tool("bun"),
    jj: tool("jj"),
    exporter: digestFile(environment.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY || "/usr/local/bin/smithers-jj-export")
  }
}

export const partitionOf = (root, identity) =>
  path.join(root, "targets", createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32))

const parses = (file) => {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"))
    return true
  } catch {
    return false
  }
}

/** Copies regular files from `from` into `to` that `to` lacks or holds corrupt; returns the count. */
export const copyMissing = (from, to) => {
  let copied = 0
  const walk = (source, target) => {
    let entries
    try {
      entries = fs.readdirSync(source, { withFileTypes: true })
    } catch (cause) {
      if (cause.code === "ENOENT") return
      throw cause
    }
    for (const entry of entries) {
      // Dot files are in-flight temporaries of an atomic write.
      if (entry.name.startsWith(".")) continue
      const sourcePath = path.join(source, entry.name)
      const targetPath = path.join(target, entry.name)
      if (entry.isDirectory()) {
        walk(sourcePath, targetPath)
        continue
      }
      if (!entry.isFile()) continue
      const exists = fs.existsSync(targetPath)
      if (exists && (!entry.name.endsWith(".json") || parses(targetPath) || !parses(sourcePath))) continue
      fs.mkdirSync(target, { recursive: true })
      const temporary = path.join(target, `.${entry.name}.${randomBytes(6).toString("hex")}.tmp`)
      try {
        // A clone or copy, never a hard link: the export's copy stays private.
        fs.copyFileSync(sourcePath, temporary, fs.constants.COPYFILE_FICLONE)
        // A corrupt entry is removed first; link(2) then admits exactly one
        // replacement even when two writers repair it at once.
        // Two repairers can still both replace it; each writes a valid result
        // for the same key, so the survivor is equivalent either way.
        if (exists && !parses(targetPath)) fs.rmSync(targetPath, { force: true })
        fs.linkSync(temporary, targetPath)
        copied++
      } catch (cause) {
        if (cause.code !== "EEXIST") throw cause
      } finally {
        fs.rmSync(temporary, { force: true })
      }
    }
  }
  walk(from, to)
  return copied
}

const filesUnder = (directory) => {
  const found = []
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) {
        try {
          const stat = fs.statSync(file)
          found.push({ file, size: stat.size, mtimeMs: stat.mtimeMs })
        } catch {
          // Removed concurrently.
        }
      }
    }
  }
  walk(directory)
  return found
}

/** Removes the oldest entries until the partition is within `maxBytes`. */
export const trim = (partition, maxBytes) => {
  const files = filesUnder(partition).sort((left, right) => left.mtimeMs - right.mtimeMs)
  let total = files.reduce((sum, entry) => sum + entry.size, 0)
  let removed = 0
  for (const entry of files) {
    if (total <= maxBytes) break
    fs.rmSync(entry.file, { force: true })
    total -= entry.size
    removed++
  }
  return removed
}

const prune = (root, keep) => {
  const parent = path.join(root, "targets")
  let names
  try {
    names = fs.readdirSync(parent)
  } catch {
    return
  }
  for (const name of names) {
    const partition = path.join(parent, name)
    if (partition === keep) continue
    try {
      if (Date.now() - fs.statSync(partition).mtimeMs > staleMs) fs.rmSync(partition, { recursive: true, force: true })
    } catch {
      // A concurrent prune removed it.
    }
  }
}

const main = (argv, environment = process.env) => {
  const [command, workspace] = argv
  if ((command !== "seed" && command !== "save") || workspace === undefined) {
    throw new Error("usage: check-cache.mjs seed|save <workspace>")
  }
  const root = cacheRoot(environment)
  const partition = partitionOf(root, toolIdentity(environment))
  const local = path.join(path.resolve(workspace), ".flows", "cache")
  // Save publishes only into the partition the run was seeded from: a tool
  // replaced mid-check must not carry old-tool verdicts into the new partition.
  const marker = path.join(path.resolve(workspace), ".flows", "check-cache-partition")
  if (command === "seed") {
    fs.mkdirSync(partition, { recursive: true })
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, partition)
    // The partition directory's mtime records its last use for pruning.
    const now = new Date()
    fs.utimesSync(partition, now, now)
    prune(root, partition)
    const copied = copyMissing(partition, local)
    process.stderr.write(`check cache: seeded ${copied} entries from ${partition}\n`)
  } else {
    let seeded
    try {
      seeded = fs.readFileSync(marker, "utf8")
    } catch {
      throw new Error("check cache: this export was not seeded; refusing to save")
    }
    if (seeded !== partition) throw new Error("check cache: host tools changed during the check; refusing to save")
    const copied = copyMissing(local, partition)
    const maxBytes = Number(environment.SMITHERS_CHECK_CACHE_MAX_BYTES ?? defaultMaxBytes)
    const removed = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? trim(partition, maxBytes) : 0
    process.stderr.write(`check cache: saved ${copied} new entries to ${partition}` +
      (removed > 0 ? `, evicted ${removed}` : "") + "\n")
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2))
}
