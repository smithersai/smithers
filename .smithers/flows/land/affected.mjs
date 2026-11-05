/**
 * The tests a land owes its change, run on the farm before the push lock: every test target the change
 * affects, through the target index's reverse dependency edges, and apps/mvp's whole Vitest suite when the
 * change reaches apps/mvp or a package it depends on. A failure that doesn't also fail on the base refuses
 * the land, by test name. Missing execution proof is incomplete and permits the land. --validated and a
 * lane's own --test commands add to this set; neither replaces it.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { COPYFILE_FICLONE } from "node:constants"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, hostname, tmpdir } from "node:os"
import { basename, dirname, join, posix } from "node:path"
import { jj } from "./numbering.mjs"
import { farmHosts, runClient } from "./typecheck.mjs"
import { runProcess, boundedSpawnSync as spawnSync } from "./process.mjs"
import { acquireLock, atomicWrite, processStartTime } from "./lock.mjs"
import { sourcePath } from "./files.mjs"

const jobContext = new AsyncLocalStorage()
const recoveryEvidence = (output) => ({
  boxes: [...new Map([...output.matchAll(/^cfbox: (?:\[(\d+)\] )?box ([a-f0-9]{8,64}) \((pg|base|playwright|node), (\d+) vCPU\) started /gm)].map((match) => [match[1] ?? "1", { job: Number(match[1] ?? 1), idPrefix: match[2], image: match[3], cpu: Number(match[4]) }])).values()].slice(0, maxPgJobs),
  servers: [...new Map([...output.matchAll(/^\[lat-run\] ([A-Za-z0-9_.-]+) slot (\d+)\r?$/gm)].map((match) => [`${match[1]}:${match[2]}`, { host: match[1], slot: Number(match[2]) }])).values()].slice(0, 8),
  ended: [...new Map([...output.matchAll(/^cfbox: (?:\[(\d+)\] )?exit (-?\d+); command /gm)].map((match) => [match[1] ?? "1", { job: Number(match[1] ?? 1), exit: Number(match[2]) }])).values()].slice(0, maxPgJobs)
})
const clientLifetime = (client, log, boxJobs) => {
  const context = jobContext.getStore()
  if (!context) return {}
  const record = { client, log, boxJobs, state: "starting", started: Date.now() }
  context.clients.push(record); context.save()
  return {
    onStart: (pid) => {
      record.pid = pid; record.state = pid === undefined ? "stopped" : "running"; context.save()
      record.startTime = pid === undefined ? undefined : processStartTime(pid); context.save()
    },
    onEnd: (status, signal, interrupted) => {
      record.status = status; record.signal = signal
      record.interrupted = Boolean(interrupted)
      // runProcess calls onEnd only after the client's close. An interrupted or
      // failed client has still exited; remote boxes keep their own lifetime.
      record.state = status === 0 && !signal && !interrupted ? "completed" : "stopped"
      try {
        const output = readFileSync(log, "utf8")
        record.recovery = recoveryEvidence(output)
        const relay = process.env.SMITHERS_CFBOX_VIA ?? "nyc-01"
        if (boxJobs && /^[A-Za-z0-9_.-]+$/.test(relay)) record.recovery.relay = relay
      } finally { context.save() }
    }
  }
}

export const gateBudgetMs = 30 * 60 * 1000
const budgetMs = gateBudgetMs
// Admission consumes the same wall budget as preparation, execution and comparison.
const admissionSeconds = 15 * 60
const receipt = /^SMITHERS_AFFECTED ([A-Za-z0-9+/=]+)$/m
const runner = "../../.smithers/flows/land/affected-run.mjs"
const lines = (text) => text ? text.split("\n").filter(Boolean) : []
const vitestConfig = "apps/mvp/vitest.config.ts"

/** A glob with `**`, `*` and `{a,b}`, as Vitest's include patterns use them. */
export const globRegExp = (glob) => new RegExp(`^${glob
  .replace(/[.+^$()|[\]\\]/g, "\\$&")
  .replace(/\{([^}]*)\}/g, (_, alternatives) => `(?:${alternatives.split(",").join("|")})`)
  .replace(/\*\*\/|\*\*|\*/g, (token) => token === "*" ? "[^/]*" : token === "**/" ? "(?:.*/)?" : ".*")}$`)

/**
 * The include globs of apps/mvp's Vitest config: `test.include`, read from its source. The scan skips strings
 * and comments and tracks nesting, so `coverage.include` or a bracket in a comment can't stand in for it. Only
 * a list of plain string literals is understood; anything else refuses, so an unread form can't shrink the
 * expected file list.
 */
export const vitestIncludes = (config) => {
  const token = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`|([A-Za-z_$][\w$]*)|([{}[\]():,])|([^\s])/y
  const tokens = []
  for (let at = 0; at < config.length; ) {
    token.lastIndex = at
    const match = token.exec(config)
    if (!match) break
    at = token.lastIndex
    if (match[1] !== undefined || match[2] !== undefined || match[3] !== undefined) tokens.push({ string: match[1] ?? match[2] ?? match[3] })
    else if (match[4] || match[5] || match[6]) tokens.push({ text: match[4] ?? match[5] ?? match[6] })
    else if (match[0].startsWith("`")) tokens.push({ text: "`" })
  }
  const refuse = (why) => { throw new Error(`${vitestConfig}: ${why}; cannot compute the affected suites, so the land refuses`) }
  // `key: {` or `key: [` at the given depth of the object that opened at `from`.
  const member = (from, key) => {
    for (let i = from, depth = 0; i < tokens.length; i++) {
      const text = tokens[i].text
      if (text === "{" || text === "[" || text === "(") depth++
      else if (text === "}" || text === "]" || text === ")") { if (--depth < 0) return -1 }
      else if (depth === 0 && (text === key || tokens[i].string === key) && tokens[i + 1]?.text === ":") return i + 2
    }
    return -1
  }
  // One config object, one test object, nothing merged in: anything that could replace test.include refuses.
  for (const name of ["mergeConfig", "defineProject", "defineWorkspace"]) if (tokens.some((t) => t.text === name)) refuse(`${name} could change test.include`)
  // The default export itself: `export default defineConfig({` or `export default {`. A config built
  // elsewhere and exported by name, or a second defineConfig, could be the one Vitest reads.
  const exported = tokens.findIndex((t, i) => t.text === "export" && tokens[i + 1]?.text === "default")
  const object = exported < 0 ? -1
    : tokens[exported + 2]?.text === "{" ? exported + 2
    : tokens[exported + 2]?.text === "defineConfig" && tokens[exported + 3]?.text === "(" && tokens[exported + 4]?.text === "{" ? exported + 4 : -1
  if (object < 0) refuse("no export default defineConfig({ ... }) or export default { ... }")
  const calls = tokens.filter((t, i) => t.text === "defineConfig" && tokens[i + 1]?.text === "(").length
  if (calls > (tokens[exported + 2]?.text === "defineConfig" ? 1 : 0)) refuse("more than one defineConfig call")
  const test = member(object + 1, "test")
  if (test < 0 || tokens[test]?.text !== "{") refuse("no test object")
  // Every member of the object at depth 0 must be `name: value` or `"name": value`; a getter, a method, a
  // spread or a computed key could stand in for `key`, and so could a second `key`.
  const own = (from, key, at) => {
    const where = from === object + 1 ? "the config" : "test"
    for (let i = from; i < tokens.length && tokens[i].text !== "}"; ) {
      const name = tokens[i]
      if (name.text === "." && tokens[i + 1]?.text === "." && tokens[i + 2]?.text === ".") refuse(`${where} object spreads another object, which could set ${key}`)
      if (name.text === "[") refuse(`${where} has a computed key, which could be ${key}`)
      if (!(name.string !== undefined || /^[A-Za-z_$][\w$]*$/.test(name.text ?? "")) || tokens[i + 1]?.text !== ":") refuse(`${where} has a member that isn't \`name: value\` (${name.text ?? JSON.stringify(name.string)} ${tokens[i + 1]?.text ?? ""}), which could set ${key}`)
      if ((name.text === key || name.string === key) && i + 2 !== at) refuse(`${where} sets ${key} twice`)
      // Skip the value to the next member.
      let j = i + 2
      for (let depth = 0; j < tokens.length; j++) {
        const text = tokens[j].text
        if (["{", "[", "("].includes(text)) depth++
        else if (["}", "]", ")"].includes(text)) { if (depth === 0) break; depth-- }
        else if (text === "," && depth === 0) break
      }
      i = tokens[j]?.text === "," ? j + 1 : j
    }
  }
  own(object + 1, "test", test)
  const include = member(test + 1, "include")
  if (include < 0 || tokens[include]?.text !== "[") refuse("no test.include list")
  // The test object's own members: a second include, a spread or projects could replace the one read here.
  own(test + 1, "include", include)
  if (member(test + 1, "projects") >= 0 || member(test + 1, "workspace") >= 0) refuse("test declares projects, which have their own include")
  const globs = []
  let i = include + 1
  for (; tokens[i]?.text !== "]"; i++) {
    if (i >= tokens.length) refuse("test.include never closes")
    if (tokens[i].text === ",") continue
    if (tokens[i].string === undefined) refuse(`test.include holds more than string literals (${tokens[i].text})`)
    globs.push(tokens[i].string)
  }
  // The list is the whole value: `[...].concat(...)` or `[...] || other` would be another list.
  if (![",", "}"].includes(tokens[i + 1]?.text)) refuse(`test.include is an expression, not a list (${tokens[i + 1]?.text})`)
  // Each object is the whole value: `{...} && {...}` or `defineConfig({...}).x` would be another config.
  const close = (open) => {
    for (let i = open, depth = 0; i < tokens.length; i++) {
      if (["{", "[", "("].includes(tokens[i].text)) depth++
      else if (["}", "]", ")"].includes(tokens[i].text) && --depth === 0) return i
    }
    refuse("an object never closes")
  }
  if (![",", "}"].includes(tokens[close(test) + 1]?.text)) refuse(`test is an expression, not an object (${tokens[close(test) + 1]?.text})`)
  const after = tokens.slice(close(object) + 1).map((t) => t.text ?? JSON.stringify(t.string))
  const tail = tokens[exported + 2]?.text === "defineConfig" ? [")"] : []
  if (!(after.length === tail.length || (after.length === tail.length + 1 && after.at(-1) === ";")) || after.slice(0, tail.length).join() !== tail.join()) refuse(`the default export continues past its object (${after.slice(0, 4).join(" ")})`)
  if (!globs.length) refuse("test.include is empty")
  return globs
}

const readJson = (text) => { try { return JSON.parse(text) } catch { return undefined } }

/** A target input as a path predicate. Extglob `!(...)` widens to `*`, so a match is never missed. */
const inputMatcher = (input) => {
  const glob = (pattern) => globRegExp(pattern.replace(/[!@+?]\([^)]*\)/g, "*"))
  if (input.kind === "file") return (path) => path === input.path
  if (input.kind === "glob") {
    const include = glob(input.pattern), exclude = (input.exclude ?? []).map(glob)
    return (path) => include.test(path) && !exclude.some((pattern) => pattern.test(path))
  }
  if (input.kind === "git-diff") { const patterns = (input.paths ?? []).map(glob); return (path) => patterns.some((pattern) => pattern.test(path)) }
  if (input.kind === "pnpm-workspace") return (path) => /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path)
  return () => true
}

/**
 * The index's test targets a change affects: targets whose declared inputs read a changed path,
 * every test target `owed` names by its executable package dependencies, and
 * every target that depends on one of those, transitively. A target that reads a changed path doesn't pull in
 * the rest of its package: the root's `**\/*` readers would otherwise make every change affect every package.
 */
export const affectedTargets = (index, changed, owed = () => false) => {
  if (!changed.length) return []
  index = index.filter((row) => typeof row?.label === "string").map((row) => ({ ...row, package: row.package ?? "", inputs: row.inputs ?? [], dependencies: row.dependencies ?? [], kinds: row.kinds ?? [] }))
  // These generated groups transport the full repository into clean-clone tests and
  // provide cache identities. Consumers declare their executable inputs separately.
  // Traversing an inventory edge makes every source edit execute the CLI's build.
  index = index.filter((row) => !(row.rule === "Filegroup" && /^\/\/packages\/repo-targets:repositoryInputs(?:_|$)/.test(row.label)))
  const reads = (row) => changed.some((path) => row.source?.file === path || row.inputs.some((input) => inputMatcher(input)(path)))
  const reached = new Set(index.filter((row) => reads(row) || (row.kinds.includes("test") && owed(row.package))).map((row) => row.label))
  const dependents = new Map()
  for (const row of index) for (const dependency of row.dependencies) dependents.set(dependency, [...dependents.get(dependency) ?? [], row.label])
  const queue = [...reached]
  while (queue.length) for (const dependent of dependents.get(queue.shift()) ?? []) if (!reached.has(dependent)) { reached.add(dependent); queue.push(dependent) }
  return index.filter((row) => reached.has(row.label) && row.kinds.includes("test")).map((row) => row.label).sort()
}

/**
 * pnpm-workspace.yaml's `packages:` list: indented `- "glob"` items, with blank and comment lines between them,
 * up to the next top-level key. Any other form refuses rather than truncating the list. Undefined: no file.
 */
export const workspaceGlobs = (text) => {
  if (text === undefined) return undefined
  const lines = text.split("\n")
  const start = lines.findIndex((line) => /^packages:\s*(#.*)?$/.test(line))
  if (start < 0) return undefined
  const globs = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue
    if (/^\S/.test(line)) break
    const item = line.match(/^\s+-\s*(?:"([^"]+)"|'([^']+)'|([^\s#"']+))\s*(#.*)?$/)
    if (!item) throw new Error(`pnpm-workspace.yaml: cannot read the packages entry ${line.trim()}; cannot compute the affected suites, so the land refuses`)
    globs.push((item[1] ?? item[2] ?? item[3]).replace(/^\.\//, ""))
  }
  return globs
}

/**
 * The workspace packages that depend on a changed one, the changed ones included, by directory. Any
 * dependency naming a workspace package counts, `workspace:` or a version: pnpm-workspace.yaml sets
 * linkWorkspacePackages, so a version range links the local package too.
 */
export const dependentPackages = (files, read, changed) => {
  // Membership is what pnpm-workspace.yaml declares, so a nested manifest that isn't a member, such as a
  // plugin's, can't take its paths from the package holding it.
  const globs = workspaceGlobs(read("pnpm-workspace.yaml"))
  const member = (dir) => globs === undefined || dir === "." || (globs.some((glob) => !glob.startsWith("!") && globRegExp(glob).test(dir)) && !globs.some((glob) => glob.startsWith("!") && globRegExp(glob.slice(1)).test(dir)))
  const byName = new Map()
  for (const path of files.filter((path) => path.endsWith("package.json") && !/(^|\/)(test|fixtures?|node_modules)\//.test(path) && member(posix.dirname(path)))) {
    const manifest = readJson(read(path) ?? "")
    if (typeof manifest?.name === "string") byName.set(manifest.name, { dir: posix.dirname(path), manifest })
  }
  const dirs = [...new Set([...byName.values()].map((entry) => entry.dir))].sort((a, b) => b.length - a.length)
  const owner = (path) => dirs.find((dir) => dir !== "." && path.startsWith(`${dir}/`))
  const users = new Map()
  for (const { dir, manifest } of byName.values()) {
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })) {
      const dependency = byName.get(name)
      if (dependency && dependency.dir !== dir) users.set(dependency.dir, [...users.get(dependency.dir) ?? [], dir])
    }
  }
  const reached = new Set(changed.map(owner).filter(Boolean))
  const queue = [...reached]
  while (queue.length) for (const user of users.get(queue.shift()) ?? []) if (!reached.has(user)) { reached.add(user); queue.push(user) }
  // An index package outside every workspace package, the root's "" included, belongs to the root manifest.
  return { dirs: reached, owner: (path) => owner(`${path}/`) ?? "." }
}

/**
 * How land reads a checkout: jj in a workspace, Git in an old shared checkout. Both read head bytes from disk.
 * `baseEntries` maps each base path to its type and executable bit, so the base tree keeps them.
 */
export const jjSource = (root, base = "main@origin", pinned) => {
  // The head is one commit, fixed at first use: what the farm tests is that commit's bytes, not a checkout
  // an editor can change while a run waits for capacity.
  let head = pinned
  let fileList
  const at = () => head ??= jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).trim()
  const files = () => fileList ??= lines(jj(root, ["file", "list", "--ignore-working-copy", "-r", at()]))
  return {
  base,
  head: at,
  read: (path) => {
    if (!files().includes(path)) return undefined
    const result = spawnSync("jj", ["--color=never", "--no-pager", "file", "show", "--ignore-working-copy", "-r", at(), path], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    if (result.status !== 0) throw new Error(`Cannot read affected selection input ${path} at ${at()}`)
    return result.stdout
  },
  // Both endpoints include the old path of a rename, without consulting Git directly.
  changed: () => [...new Set(jj(root, ["diff", "--ignore-working-copy", "--from", base, "--to", at(), "-T", 'source.path() ++ "\\0" ++ target.path() ++ "\\0"']).split("\0").filter(Boolean))],
  files,
  materialize: (directory) => jjTree(root, at(), directory),
  baseEntries: () => new Map(lines(jj(root, ["file", "list", "--ignore-working-copy", "-r", base, "-T", 'file_type ++ " " ++ executable ++ " " ++ path ++ "\\n"'])).map((line) => {
    const [type, executable, ...path] = line.split(" ")
    return [path.join(" "), { symlink: type === "symlink", executable: executable === "true" }]
  })),
  baseBytes: (path) => {
    const bytes = spawnSync("jj", ["--color=never", "--no-pager", "file", "show", "--ignore-working-copy", "-r", base, path], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
    if (bytes.status !== 0) throw new Error(`Cannot read ${path} at ${base}`)
    return bytes.stdout
  },
  // jj file show prints nothing for a symlink; a full diff export preserves its target and mode.
  baseLink: (path) => {
    const tree = mkdtempSync(join(tmpdir(), "smithers-affected-link-"))
    try { jjTree(root, base, tree); return readlinkSync(join(tree, path)) }
    finally { rmSync(tree, { recursive: true, force: true }) }
  }
  }
}

// Export the full right side of a diff from the empty root. This reads exact blobs, symlinks and modes
// without registering a workspace or touching the invoking checkout's sparse patterns.
const jjTree = (root, revision, directory) => {
  if (jj(root, ["log", "--ignore-working-copy", "-r", `${revision} & conflicts()`, "--no-graph", "-T", "commit_id"]).trim()) throw new Error(`Cannot snapshot conflicted revision ${revision}`)
  const unsupported = jj(root, ["file", "list", "--ignore-working-copy", "-r", revision, "-T", 'if(file_type == "git-submodule", path ++ "\\n")']).trim()
  if (unsupported) throw new Error(`Cannot snapshot submodules: ${unsupported}`)
  const scratch = mkdtempSync(join(tmpdir(), "smithers-snapshot-")), done = join(scratch, "done")
  try {
    const script = 'const fs = require("node:fs"); fs.cpSync(process.argv[1], process.argv[2], { recursive: true, verbatimSymlinks: true }); const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = p + "/" + e.name; if (e.isDirectory()) walk(f); else if (e.isFile()) fs.chmodSync(f, fs.statSync(f).mode & 0o111 ? 0o755 : 0o644) } }; walk(process.argv[2]); fs.writeFileSync(process.argv[3], "done")'
    jj(root, ["diff", "--ignore-working-copy", "--from", "root()", "--to", revision, "--tool", "land-snapshot",
      "--config", `merge-tools.land-snapshot.program=${JSON.stringify(process.execPath)}`,
      "--config", `merge-tools.land-snapshot.diff-args=${JSON.stringify(["-e", script, "$right", directory, done])}`])
    // jj reports an external diff tool's failure as a warning; require the export's completion marker.
    if (!existsSync(done)) throw new Error(`Cannot snapshot ${revision}: the export did not complete`)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

/**
 * Writes a commit's or tree's exact blobs into an empty directory, from the Git store: each path with its
 * recorded mode, each symlink with its target, and no export-ignore, export-subst or line-ending filter.
 */
const archive = (gitDir, treeish, directory, cwd) => {
  const git = (args, input) => {
    const result = spawnSync("git", ["--git-dir", gitDir, ...args], { cwd, input, maxBuffer: 8 * 1024 * 1024 * 1024 })
    if (result.status !== 0) throw new Error(`git ${args[0]} ${treeish}: ${result.stderr}`)
    return result.stdout
  }
  // `<mode> <type> <oid>\t<path>`, NUL-separated so any path survives.
  const entries = git(["ls-tree", "-r", "-z", treeish]).toString("utf8").split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t"), [mode, type, oid] = line.slice(0, tab).split(" ")
    return { mode, type, oid, path: line.slice(tab + 1) }
  })
  const blobs = entries.filter((entry) => entry.type === "blob")
  if (entries.length !== blobs.length) throw new Error(`${treeish} holds a submodule or other non-file entry; cannot snapshot it, so the land refuses`)
  const raw = git(["cat-file", "--batch"], blobs.map((entry) => entry.oid).join("\n") + "\n")
  let at = 0
  for (const entry of blobs) {
    const header = raw.indexOf(10, at)
    const size = Number(raw.subarray(at, header).toString("utf8").split(" ")[2])
    const bytes = raw.subarray(header + 1, header + 1 + size)
    at = header + 1 + size + 1
    const to = sourcePath(directory, entry.path)
    mkdirSync(dirname(to), { recursive: true })
    if (entry.mode === "120000") symlinkSync(bytes.toString("utf8"), to)
    else writeFileSync(to, bytes, { mode: entry.mode === "100755" ? 0o755 : 0o644 })
  }
}
export const gitSource = (root, base, tree) => {
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd: root, maxBuffer: 256 * 1024 * 1024 })
    if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`)
    return result.stdout
  }
  return {
    base,
    head: () => tree,
    read: (path) => {
      const result = spawnSync("git", ["show", `${tree}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
      return result.status === 0 ? result.stdout : undefined
    },
    // Between the fetched base and the validated tree, never the live checkout, which may have moved since.
    changed: () => lines(base ? git("diff-tree", "-r", "--name-only", "--no-renames", "-z", base, tree).toString("utf8").replaceAll("\0", "\n") : git("ls-tree", "-r", "--name-only", tree).toString("utf8")),
    // The tree commit.mjs is about to commit, written to a private index before the checks ran.
    files: () => lines(git("ls-tree", "-r", "--name-only", tree).toString("utf8")),
    materialize: (directory) => archive(git("rev-parse", "--absolute-git-dir").toString("utf8").trim(), tree, directory, root),
    // `<mode> <type> <object>\t<path>`: 120000 is a symlink, 100755 an executable file.
    baseEntries: () => new Map(base ? lines(git("ls-tree", "-r", base).toString("utf8")).map((line) => {
      const tab = line.indexOf("\t"), mode = line.slice(0, 6)
      return [line.slice(tab + 1), { symlink: mode === "120000", executable: mode === "100755" }]
    }) : []),
    baseBytes: (path) => git("show", `${base}:${path}`),
    baseLink: (path) => git("cat-file", "blob", `${base}:${path}`).toString("utf8")
  }
}

const indexPath = ".smithers/target-index.json"

/**
 * Paths the farm clients never copy to a host (farm/mini-run's filter and lat-run's excludes): credentials,
 * build output and media. A change to one can't reach the tests that run there.
 */
export const farmSkips = (path) => {
  const parts = path.split("/"), name = parts.at(-1)
  return parts.slice(0, -1).some((dir) => ["node_modules", "dist", "dist-chrome", "dist-firefox", "target", ".alchemy", ".wrangler", ".cache", ".ssh", ".aws", "test-results", "playwright-report", ".venv", ".native", ".native-ffi", ".flows", ".artifacts", ".playwright-mcp", ".backend-go-modcache", ".backend-sqlc"].includes(dir)) ||
    parts[0] === "data" || path === "apps/backend/backend" ||
    ["apps/maintainer-site/queue/before/", "evals/swebench/logs/", ".specs/design/mock/", "apps/app/build/", "apps/app/artifacts/", "packages/smithers/out/"].some((prefix) => path.startsWith(prefix)) || /^(\.env|\.dev\.vars)/.test(name) || name === ".npmrc" || /\.(pem|key|p12|mp4|webm)$/.test(name) || /\.tfstate/.test(name)
}

/**
 * Files every package installs, resolves, compiles or runs through: the lockfile, the pnpm workspace and its
 * install hook (the inputs farm/mini-remote.sh hashes to decide a reinstall), the toolchain, and
 * .smithers/WORKSPACE.ts, which declares every target's runtime and its preloaded imports.
 */
export const sharedPath = (path) =>
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.[cm]?js|\.node-version|\.nvmrc|tsconfig[^/]*\.json|\.smithers\/WORKSPACE\.ts|\.smithers\/environment\.nix)$/.test(path) || path.startsWith("patches/")

// Markdown/text fixtures and templates are program inputs. Only documentation
// locations and conventional documentation filenames skip package propagation.
const documentationPath = (path) => /\.(md|rst|txt)$/i.test(path) && !/(?:^|\/)(?:_?fixtures?_?|__fixtures__|templates?)\//.test(path) && (
  /(?:^|\/)(?:docs?|\.specs)\//.test(path) ||
  /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|LICENSE|NOTICE|AUTHORS|CODE_OF_CONDUCT|AGENTS)(?:[._-][^/]*)?\.(md|rst|txt)$/i.test(path)
)

/**
 * What the change owes: the index's affected test targets, the test targets of every workspace package that
 * depends on a changed one, and apps/mvp's test files when the change reaches apps/mvp.
 */
export const affectedPlan = (root, source = jjSource(root)) => {
  const changed = source.changed()
  const unsent = changed.filter(farmSkips)
  if (unsent.length) throw new Error(`The farm never receives ${unsent.join(", ")}, so no test there can see this change; nothing pushed. Land it with a review of its own.`)
  const files = source.files()
  const read = source.read ?? ((path) => { try { return readFileSync(join(root, path), "utf8") } catch { return undefined } })
  const text = read(indexPath)
  // A change can't drop its own tests by deleting or breaking the index they're selected from.
  if (text === undefined && source.baseEntries().has(indexPath)) throw new Error(`${indexPath} is missing; cannot compute the affected suites, so the land refuses`)
  const index = text === undefined ? [] : readJson(text)
  if (!Array.isArray(index)) throw new Error(`${indexPath} is not a JSON list; cannot compute the affected suites, so the land refuses`)
  // Prose and the generated index are not runtime changes to their enclosing package.
  // Explicit target inputs still select their readers (including documentation checks).
  const executable = changed.filter((path) => path !== indexPath && !documentationPath(path))
  const packages = dependentPackages(files, read, executable)
  // A shared dependency or toolchain file can change any package, so it owes every package's tests.
  const everything = executable.some(sharedPath)
  const owed = (dir) => everything || packages.dirs.has(packages.owner(dir))
  const labels = affectedTargets(index, changed, owed)
  const executableLabels = affectedTargets(index, executable, owed)
  const config = read(vitestConfig)
  const hasMvp = config !== undefined || source.baseEntries().has(vitestConfig)
  // Runtime changes reaching app files, dependencies, rule sources or shared setup owe its suite.
  // A prose/index reader remains selected on its own, even when declared inside apps/mvp.
  const reachesMvp = hasMvp && (everything || packages.dirs.has("apps/mvp") || executableLabels.some((label) => label.startsWith("//apps/mvp:") || label.startsWith("//apps/mvp/")) ||
    executable.some((path) => path.startsWith("apps/mvp/") || path.startsWith("packages/repo-targets/test-utils/")))
  // Deleting the config can't drop the suite it declares.
  if (reachesMvp && config === undefined) throw new Error(`${vitestConfig} is missing; cannot compute the affected suites, so the land refuses`)
  let vitestFiles = []
  if (reachesMvp) {
    // Vitest reads `./src/**` and `src/**` alike; so does the land.
    const globs = vitestIncludes(config).map((glob) => glob.replace(/^\.\//, ""))
    // globRegExp knows `**`, `*` and a flat `{a,b}`; any other glob syntax, a `{1..3}` range or nested braces
    // included, would silently match too little.
    const unsupported = globs.find((glob) => /[[\]?]|[!@+*]\(|\{[^}]*(\.\.|\{)/.test(glob) || /^(\/|\.\.?\/)|\/\.\.?\//.test(glob))
    if (unsupported) throw new Error(`${vitestConfig}: test.include pattern ${unsupported} uses glob syntax the land can't expand; cannot compute the affected suites, so the land refuses`)
    const includes = globs.map(globRegExp)
    vitestFiles = files.filter((path) => path.startsWith("apps/mvp/")).map((path) => path.slice("apps/mvp/".length))
      .filter((path) => includes.some((pattern) => pattern.test(path)) && !/(^|\/)node_modules\//.test(path)).sort()
  }
  // A target that declares hosts runs only there: smthrs refuses the whole command on any other platform.
  const hosts = Object.fromEntries(index.filter((row) => labels.includes(row?.label) && Array.isArray(row.hosts)).map((row) => [row.label, row.hosts]))
  const byLabel = new Map(index.filter((row) => typeof row?.label === "string").map((row) => [row.label, row]))
  const needsDocker = (label, seen = new Set()) => {
    if (seen.has(label)) return false
    seen.add(label)
    const row = byLabel.get(label)
    return Boolean(row?.rule?.startsWith("Docker.")) || (row?.dependencies ?? []).some((dependency) => needsDocker(dependency, seen))
  }
  const docker = Object.fromEntries(labels.filter((label) => needsDocker(label)).map((label) => [label, true]))
  return { base: source.base, changed, labels, hosts, docker, reachesMvp, vitestFiles }
}

/**
 * A tree of the base for rerunning failures: the base's paths, each unchanged one cloned from the head (no
 * disk on APFS) and each changed one written from the base with its type and mode. No .jj or .git is copied.
 */
const baseTree = (root, plan, source) => {
  const tree = mkdtempSync(join(tmpdir(), "smithers-affected-base-"))
  try {
  const changed = new Set(plan.changed)
  // The runner is the tool, not the change under test: the base tree runs the head's copy.
  const runnerPath = ".smithers/flows/land/affected-run.mjs"
  const clone = (path) => {
    const from = join(root, path), to = sourcePath(tree, path)
    mkdirSync(dirname(to), { recursive: true })
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to)
    else copyFileSync(from, to, COPYFILE_FICLONE)
  }
  // Only the base's own paths, so no file or directory the change added is there.
  for (const [path, entry] of source.baseEntries()) {
    if (path === runnerPath) continue
    if (!changed.has(path)) { clone(path); continue }
    const to = sourcePath(tree, path)
    mkdirSync(dirname(to), { recursive: true })
    // A symlink points where it pointed on the base; a file keeps its executable bit.
    if (entry.symlink) symlinkSync(source.baseLink(path), to)
    else writeFileSync(to, source.baseBytes(path), { mode: entry.executable ? 0o755 : 0o644 })
  }
  if (existsSync(join(root, runnerPath))) { sourcePath(tree, runnerPath); clone(runnerPath) }
  return tree
  } catch (error) { rmSync(tree, { recursive: true, force: true }); throw error }
}

/**
 * Boxable work uses cfbox only. Platform and Docker-dependent targets use Latitude.
 * There is no cross-platform fallback for a pg failure. The Mac's own
 * upload fails, so the box's tree goes through SMITHERS_CFBOX_VIA (nyc-01); --cache can't go with --via, so
 * each box installs from the lockfile.
 */
export const affectedHosts = () => [{ client: process.env.SMITHERS_CFBOX ?? join(homedir(), ".vibe-orch/bin/cfbox"), platform: "linux", box: true, docker: false }, ...farmHosts().filter((host) => host.kind === "latitude").map((host) => ({ ...host, docker: true }))]
const boxes = () => new Set(affectedHosts().filter((host) => host.box).map((host) => host.client))

const runBox = async (box, root, signal, { argv, timeoutMs, source, image = "pg" }) => {
  const scratch = mkdtempSync(join(tmpdir(), "smithers-box-"))
  const log = join(scratch, "output.log")
  writeFileSync(log, "", { mode: 0o600 })
  const install = 'pnpm install --frozen-lockfile --prefer-offline >/tmp/affected-install.log 2>&1 || { tail -40 /tmp/affected-install.log; exit 4; }; exec "$@"'
  try {
    const result = await runProcess("bash", ["-c", 'log=$1; shift; exec "$@" >"$log" 2>&1', "box", log, box, "run", "--image", image, "--cpu", "4",
      "--via", process.env.SMITHERS_CFBOX_VIA ?? "nyc-01", "--with-deps", "--cwd", "apps/mvp", source, "--", "bash", "-c", install, "affected", ...argv], { cwd: root, signal, timeoutMs, ...clientLifetime(box, log, 1) })
    return { status: result.status, output: readFileSync(log, "utf8") }
  } catch (error) {
    if (signal?.aborted) throw signal.reason?.name === "TimeoutError" ? infrastructureFailure(null, readFileSync(log, "utf8") + " timed out") : error
    return { status: null, output: `${error.message}\n${readFileSync(log, "utf8")}` }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

/**
 * Many runs in one `cfbox parallel`: one pack, one SSH session to the via host and one upload for all the
 * boxes, each job's output prefixed `[n] ` and its exit in cfbox's closing table. Twelve separate `cfbox run`s
 * each copied the whole tree to nyc-01 and uploaded it again.
 */
export const readBoxReceipts = (output, seen, onReceipt) => {
  // A growing log's end is not a record boundary: wait for the newline before decoding JSON.
  for (const match of output.matchAll(/^\[(\d+)\] SMITHERS_AFFECTED ([^\r\n]*)\r?\n/gm)) {
    if (seen.has(match[1])) continue
    let result
    try { result = JSON.parse(Buffer.from(match[2], "base64").toString("utf8")) }
    catch { throw new AffectedIncomplete("receipt-decode", `Invalid affected-tests receipt from box ${match[1]}`) }
    onReceipt(Number(match[1]) - 1, result)
    seen.add(match[1])
  }
}

const runBoxes = async (box, root, signal, { argvs, timeoutMs, source, image = "pg" }) => {
  const scratch = mkdtempSync(join(tmpdir(), "smithers-boxes-"))
  const log = join(scratch, "output.log")
  writeFileSync(log, "", { mode: 0o600 })
  const install = 'pnpm install --frozen-lockfile --prefer-offline >/tmp/affected-install.log 2>&1 || { tail -40 /tmp/affected-install.log; exit 4; }; exec "$@"'
  const commands = argvs.flatMap((argv, i) => [...i ? [":::"] : [], "bash", "-c", install, "affected", ...argv])
  // Interim output is observation only. Drain final acknowledgments so one incomplete
  // job cannot hide completed proof in a later outcome; the shared deadline still bounds it.
  const seen = new Set()
  let observationError = false
  const watch = () => {
    try { readBoxReceipts(readFileSync(log, "utf8"), seen, index => console.error(`AFFECTED box ${index + 1} reported; awaiting client completion`)) }
    catch { if (!observationError) console.error("AFFECTED interim receipt incomplete; awaiting final outcomes"); observationError = true }
  }
  const timer = setInterval(watch, 2000)
  let output, clientStatus
  try {
    const result = await runProcess("bash", ["-c", 'log=$1; shift; exec "$@" >"$log" 2>&1', "boxes", log, box, "parallel", "--image", image, "--cpu", "4",
      "--via", process.env.SMITHERS_CFBOX_VIA ?? "nyc-01", "--with-deps", "--cwd", "apps/mvp", source, "--", ...commands], { cwd: root, signal, timeoutMs, ...clientLifetime(box, log, argvs.length) })
    clientStatus = result.signal ? null : result.status
    output = readFileSync(log, "utf8")
  } catch (error) {
    if (signal?.aborted) throw signal.reason?.name === "TimeoutError" ? infrastructureFailure(null, readFileSync(log, "utf8") + " timed out") : error
    clientStatus = null
    output = `${error.message}\n${readFileSync(log, "utf8")}`
  } finally { clearInterval(timer); rmSync(scratch, { recursive: true, force: true }) }
  return boxOutcomes(output, clientStatus, argvs.length)
}

export const boxOutcomes = (output, clientStatus, count) => {
  const lines = output.split("\n")
  // cfbox prints `cfbox: [n] exit <code>; command ...` once box n's command has ended and its status came back;
  // both that line and successful client completion are required. A job with no end,
  // or a client killed or disconnected before acknowledging completion, has no proof.
  const exits = new Map([...output.matchAll(/^cfbox: \[(\d+)\] exit (-?\d+); command /gm)].map((match) => [Number(match[1]), Number(match[2])]))
  return Array.from({ length: count }, (_, i) => {
    const tag = `[${i + 1}] `
    const own = lines.filter((line) => line.startsWith(tag)).map((line) => line.slice(tag.length))
    const tail = lines.filter((line) => line.startsWith("cfbox:")).slice(-3)
    return clientStatus === 0 && exits.has(i + 1)
      ? { status: exits.get(i + 1), output: [...own, ...tail].join("\n") }
      : { status: null, output: [...own, ...tail, `cfbox reported no end for this job (cfbox ${clientStatus === null ? "ended by a signal or timeout" : `exited ${clientStatus}`})`].join("\n") }
  })
}

export class AffectedIncomplete extends Error {
  constructor(stage, detail, retry = `Retry the affected gate after repairing ${stage}.`) {
    super(`INCOMPLETE stage=${stage}: ${detail}; execution proof is incomplete, so the land may proceed. ${retry}`)
    this.name = "AffectedIncomplete"
    this.status = "incomplete"
    this.stage = stage
    this.retry = retry
  }
}

export const infrastructureFailure = (status, output) => {
  const stage = /no pg .*box|waiting for a box|CFBOX_WAIT_MAX|maximum.*instance|no container instance/i.test(output) ? "pg-admission"
    : status === 5 || /integration.service|POSTGRES_NOT_READY|INTEGRATION_NOT_READY|PODMAN_|NAMESPACE_/i.test(output) ? "integration-services"
    : /global.setup|CLI.pack|canonical\/package.json/i.test(output) ? "global-setup"
    : status === 4 || /affected-install|install.*fail/i.test(output) ? "dependency-install"
    : /timed out|timeout/i.test(output) ? "execution-deadline"
    : "farm-transport"
  return new AffectedIncomplete(stage, `farm exit ${status ?? "unknown"}; no completed execution receipt`)
}

const receiptOf = (client, what, status, output, tried) => {
  // The receipt counts only from a run that also ended well: a client killed after printing it ran less.
  const answered = output.match(receipt)
  if (answered && status === 0) {
    const latitude = farmHosts().some((host) => host.client === client && host.kind === "latitude")
    const host = output.match(/^\[lat-run\] ([A-Za-z0-9_.-]+) slot \d+\r?$/m)?.[1]
    if (latitude && !host) throw new AffectedIncomplete("host-identity", "Latitude did not identify the server that ran the affected tests")
    let decoded
    try { decoded = JSON.parse(Buffer.from(answered[1], "base64").toString("utf8")) }
    catch { throw new AffectedIncomplete("receipt-decode", "invalid affected-tests receipt JSON") }
    return { ...decoded, client, ...host ? { host } : {} }
  }
  const failure = infrastructureFailure(status, output)
  tried?.push(failure)
  console.error(`AFFECTED ${what}: ${failure.message}`)
  return undefined
}

const describe = (request, source, root) => `${request.labels.length ? `${request.labels.length} targets` : ""}${request.labels.length && request.vitest ? " and " : ""}${request.vitest ? `apps/mvp Vitest${request.shard ? ` shard ${request.shard}` : ""}` : ""}${source === root ? "" : " (base tree)"}`

/**
 * Batches boxable requests, up to seven at once. Only explicit platform/service requirements
 * route to another farm. No completed receipt means incomplete, never a cross-host retry.
 */
const onFarmAll = async (root, items, { signal, source, onResult = () => {} }) => {
  signal?.throwIfAborted()
  // One cancellation for the batch and platform-specific requests: the first run that couldn't run stops the others.
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal?.addEventListener("abort", abort, { once: true })
  const stop = (error) => { if (!controller.signal.aborted) controller.abort(error); throw error }
  const pending = [], done = new Map()
  let failure
  const image = items.some((item) => item.request.vitest) ? "pg" : "node"
  try {
    const box = affectedHosts().find((host) => host.box)?.client
    const boxed = box === undefined ? [] : items.filter((item) => !item.clients || item.clients.includes(box))
    const others = affectedHosts().filter((host) => !host.box).map((host) => host.client)
    const elsewhere = (item) => {
      const promise = onFarm(root, item.request, { signal: controller.signal, source, clients: (item.clients ?? others).filter((client) => client !== box) })
        .then(result => {
          const proof = completedProof(result, item.request)
          done.set(item, proof); onResult(proof); assertRan(result); done.set(item, result)
        }).catch(stop)
      // Register the rejection handler immediately while the cfbox batch is still running.
      promise.catch(() => {})
      pending.push(promise)
    }
    for (const item of items.filter((item) => !boxed.includes(item))) elsewhere(item)
    for (const batch of pgBatches(boxed)) {
      controller.signal.throwIfAborted()
      const started = Date.now()
      console.error(`AFFECTED ${batch.map((item) => describe(item.request, source, root)).join(", ")} in ${batch.length} boxes on ${box}`)
      const outcomes = await runBoxes(box, root, controller.signal, {
        argvs: batch.map((item) => ["node", runner, Buffer.from(JSON.stringify(item.request)).toString("base64")]), timeoutMs: budgetMs, source, image
      }).catch((error) => stop(controller.signal.reason ?? error))
      let batchError
      for (const [i, outcome] of outcomes.entries()) {
        try {
          const result = receiptOf(box, describe(batch[i].request, source, root), outcome.status, outcome.output)
          if (!result) throw infrastructureFailure(outcome.status, outcome.output)
          result.image = image
          const proof = completedProof(result, batch[i].request)
          done.set(batch[i], proof); onResult(proof); assertRan(result); done.set(batch[i], result)
          console.error(`AFFECTED ${describe(batch[i].request, source, root)} ran on ${box} (${Math.round((Date.now() - started) / 1000)} s for the batch)`)
        } catch (error) {
          if (!batchError || error.status === "refused") batchError = error
        }
      }
      if (batchError) throw batchError
    }
    await Promise.all(pending)
    controller.signal.throwIfAborted()
    return items.map((item) => assertRan(done.get(item)))
  } catch (error) { failure = error; return stop(error) }
  finally { await Promise.allSettled(pending); if (failure) failure.completedResults = [...done.values()]; signal?.removeEventListener("abort", abort) }
}

export const onFarm = async (root, request, { signal, source = root, clients = affectedHosts().filter((host) => host.box).map((host) => host.client), host } = {}) => {
  const tried = []
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64")
  const what = describe(request, source, root)
  for (const client of clients) {
    const started = Date.now()
    console.error(`AFFECTED ${what} on ${client}`)
    const { status, output } = boxes().has(client)
      ? await runBox(client, root, signal, { argv: ["node", runner, encoded], timeoutMs: budgetMs, source, image: request.image ?? "pg" })
      : await runClient(client, root, signal, { argv: ["node", runner, encoded], timeoutMs: budgetMs, source, waitSeconds: admissionSeconds, lifecycle: (log) => clientLifetime(client, log), env: { LAT_RUN_DETACH: "0", ...host ? { LAT_RUN_HOSTS: host } : {} } })
    const result = receiptOf(client, what, status, output, tried)
    if (!result) continue
    if (host && result.host !== host) throw new AffectedIncomplete("host-identity", "base rerun answered from a different server")
    console.error(`AFFECTED ${what} ran on ${client} in ${Math.round((Date.now() - started) / 1000)} s`)
    return { ...result, ...boxes().has(client) ? { image: request.image ?? "pg" } : {} }
  }
  throw tried.at(-1) ?? new AffectedIncomplete("farm-routing", "no eligible farm client")
}

// smthrs reports ran, hit (a cached green), failed, skipped (a dependency failed) or cancelled per target.
// Only ran and hit passed; skipped and cancelled didn't run, so they leave the run incomplete.
const passed = new Set(["ran", "hit"])
// Ordinary targets are rerun by label; a base failure of the same target excuses that target failure.
const failingRows = result => [...(result.vitest?.failed ?? []), ...result.targets.results.filter(row => row.status === "failed")]
const failureName = row => row.label !== undefined ? `${row.label} (failed target)` : `apps/mvp/${row.file} > ${row.name}`
const failingNames = result => failingRows(result).map(failureName)

const zeroIdentity = test => test.skipped === true || (test.unexcused === true && test.name === "(ran no tests)")
const failureKind = test => test.assertion === true ? "assertion" : test.skipped === true ? "skipped" : zeroIdentity(test) ? "zero" : test.unexcused === true || /^\(the file failed: [a-f0-9]+\)/.test(test.name) ? "file" : "assertion"
const failureKey = row => JSON.stringify(row.label !== undefined ? ["target", row.label] : [failureKind(row), row.file, row.name])
const failingKeys = result => failingRows(result).map(failureKey)
const browserFailure = test => failureKind(test) === "file" && /^\(the file failed: [a-f0-9]+\) browserType\.launch: Executable doesn't exist/.test(test.name)
const targetShape = result => Array.isArray(result?.targets?.results) && result.targets.results.every(row => typeof row?.label === "string" && ["ran", "hit", "failed", "skipped", "cancelled"].includes(row.status))
const vitestShape = vitest => Array.isArray(vitest?.files) && vitest.files.every(file => typeof file === "string") && Array.isArray(vitest.failed) && vitest.failed.every(test => typeof test?.file === "string" && typeof test.name === "string" && (test.skipped === undefined || typeof test.skipped === "boolean") && (test.unexcused === undefined || typeof test.unexcused === "boolean") && (test.assertion === undefined || typeof test.assertion === "boolean") && [test.skipped, test.unexcused, test.assertion].filter(flag => flag === true).length <= 1)

/** Completed components remain proof even when an independent component or file has setup trouble. */
const vitestFinished = vitest => vitest.exit === undefined || (Number.isInteger(vitest.exit) && vitest.exit >= 0 && (vitest.exit === 0 || vitest.failed.length > 0))
const completedProof = (result, request) => {
  const vitest = request?.vitest !== false && vitestShape(result?.vitest) && vitestFinished(result.vitest) ? result.vitest : undefined
  const unavailable = new Set(vitest?.failed.filter(browserFailure).map(test => test.file) ?? [])
  const failed = vitest?.failed.filter(test => (!vitest.error || ["assertion", "file"].includes(failureKind(test))) && !browserFailure(test) && !(unavailable.has(test.file) && (zeroIdentity(test) || (test.unexcused === true && test.name === "(the file failed, with no error)"))))
  return { ...result, targets: { results: request?.labels?.length !== 0 && targetShape(result) && !result.targets.error ? result.targets.results : [] },
    // This is only the completed subset; the original outcome is still classified separately.
    vitest: vitest ? { ...vitest, error: undefined, exit: failed.length ? 1 : 0, files: vitest.error ? [] : vitest.files.filter(file => !unavailable.has(file)), failed } : undefined }
}

/** Refuses a farm run that couldn't run what it was asked: no target results, or a Vitest run that broke. */
const assertRan = (result) => {
  if (!targetShape(result) || (result.vitest && !vitestShape(result.vitest))) throw new AffectedIncomplete("receipt-decode", "missing or malformed farm result")
  if (result.targets.error) throw new AffectedIncomplete(result.targets.stage ?? "target-execution", "the affected targets did not run")
  if (result.vitest?.error) throw new AffectedIncomplete(result.vitest.stage ?? "vitest-execution", "apps/mvp Vitest did not complete")
  if (result.vitest && !vitestFinished(result.vitest)) throw new AffectedIncomplete("vitest-execution", "Vitest ended unsuccessfully without a completed failure identity")
  if (result.vitest?.failed.some(browserFailure)) throw new AffectedIncomplete("browser-setup", "the farm image lacks the browser executable required by the suite", "Retry the affected gate after installing the lockfile's Playwright browser in the farm image.")
  return result
}

/** Refuses unless the run covered the whole affected set. */
/** The affected suites a run didn't run: each planned target with no ran, hit or failed row, each planned file. */
export const missingSuites = (plan, result) => {
  const missing = []
  // A skipped or cancelled target never ran, so no base comparison can excuse it.
  const ranTargets = new Set(result.targets.results.filter((row) => passed.has(row.status) || row.status === "failed").map((row) => row.label))
  for (const label of plan.labels) if (!ranTargets.has(label)) missing.push(label)
  if (plan.reachesMvp) {
    if (!result.vitest) missing.push("apps/mvp Vitest suite")
    else {
      const ran = new Set(result.vitest.files)
      for (const file of plan.vitestFiles) if (!ran.has(file)) missing.push(`apps/mvp/${file}`)
    }
  }
  return missing
}
const incomplete = (missing) => `The test run is incomplete: ${missing.length} affected suites did not run; nothing pushed.\n${missing.slice(0, 80).join("\n")}${missing.length > 80 ? `\n... and ${missing.length - 80} more` : ""}`

/** Refuses unless the run covered the whole affected set. */
export const assertComplete = (plan, result) => {
  assertRan(result)
  const missing = missingSuites(plan, result)
  if (missing.length) throw new AffectedIncomplete("suite-completeness", incomplete(missing))
}

/**
 * Six app shards plus the index batch use at most seven pg boxes of the shared cap of eight.
 * A gate holds admission through its parent comparisons; other gates wait without holding boxes.
 */
export const vitestShards = 6
export const maxPgJobs = 7
export const pgBatches = (items) => Array.from({ length: Math.ceil(items.length / maxPgJobs) }, (_, i) => items.slice(i * maxPgJobs, (i + 1) * maxPgJobs))

/** Separate from publication admission: queued gates own no boxes; waiting consumes the wall budget. */
export async function withPgAdmission(body, { path = process.env.SMITHERS_AFFECTED_LOCK ?? join(homedir(), ".smithers-lead/affected-pg.lock"), signal, timeoutMs = admissionSeconds * 1000 } = {}) {
  // Only waiting is canceled through the lock API. After acquisition, execution owns
  // cancellation and must settle every client before finally releases admission.
  const waiting = new AbortController()
  const abortWaiting = () => waiting.abort(signal.reason)
  signal?.addEventListener("abort", abortWaiting, { once: true })
  if (signal?.aborted) abortWaiting()
  let release
  try {
    release = await acquireLock(path, { signal: waiting.signal, timeoutMs: Math.min(timeoutMs, budgetMs), maxHoldMs: budgetMs + 60000,
      log: (line) => console.error(`AFFECTED admission ${line.replaceAll("landing", "pg")}`) })
  } catch (error) {
    if (signal?.aborted && signal.reason?.status !== "incomplete") throw signal.reason
    throw new AffectedIncomplete("pg-admission", "the pg queue could not grant admission", `Retry the affected gate after checking the admission queue at ${path}.`)
  } finally { signal?.removeEventListener("abort", abortWaiting) }
  const directory = join(`${path}.queue`, release.ticket)
  const context = { host: hostname(), ownerPid: process.pid, ownerStartTime: processStartTime(process.pid), clients: [], save() {
    atomicWrite(join(directory, "external-work.json"), JSON.stringify({ host: this.host, ownerPid: this.ownerPid, ownerStartTime: this.ownerStartTime, clients: this.clients }))
  } }
  context.save() // Before any client can start, including one whose launch acknowledgment is lost.
  let executionError
  try { signal?.throwIfAborted(); release.check(); return await jobContext.run(context, body) }
  catch (error) { executionError = error; throw error }
  finally {
    // Every awaited client has closed before the gate settles, including failure
    // and cancellation. Publish that proof before retiring the admission ticket.
    // A pre-launch abort can settle runProcess before its onStart callback.
    for (const client of context.clients) if (client.state === "starting" && client.pid === undefined) client.state = "stopped"
    context.save()
    if (context.clients.every((client) => ["completed", "stopped"].includes(client.state))) atomicWrite(join(directory, "external-work-stopped"), JSON.stringify({ proof: "all-clients-exited", time: Date.now() }))
    try { await release() }
    catch { if (executionError?.status === "refused") throw executionError; throw new AffectedIncomplete(executionError?.stage ?? "pg-cleanup", `job termination is unconfirmed; admission retained at ${directory}`, `${executionError?.retry ?? ""} Confirm termination of the clients/jobs in external-work.json, record the host stop proof, then retry the affected gate.`.trim()) }
  }
}

/** One result from several farm runs: the union of what each ran and failed, each row naming its client. */
export const mergeResults = (results) => {
  const vitest = results.filter((result) => result.vitest)
  return {
    targets: { results: results.flatMap((result) => result.targets.results.map((row) => ({ ...row, client: result.client, ...result.image ? { image: result.image } : {}, ...result.host ? { host: result.host } : {} }))), error: results.map((result) => result.targets.error).find(Boolean), stage: results.find((result) => result.targets.error)?.targets.stage },
    vitest: vitest.length ? {
      exit: Math.max(...vitest.map((result) => result.vitest.exit ?? 1)),
      files: [...new Set(vitest.flatMap((result) => result.vitest.files))].sort(),
      failed: vitest.flatMap((result) => result.vitest.failed.map((test) => ({ ...test, client: result.client, ...result.image ? { image: result.image } : {}, ...result.host ? { host: result.host } : {} }))),
      error: vitest.map((result) => result.vitest.error).filter(Boolean).join("\n") || undefined,
      stage: vitest.find((result) => result.vitest.error)?.vitest.stage
    } : undefined
  }
}

/** Runs requests at once; the first that fails stops the rest, so a refusal doesn't wait on the others. */
const runAll = async (run, root, requests, { signal, source, onResult = () => {} } = {}) => {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal?.addEventListener("abort", abort, { once: true })
  let pending = [], failure
  const completed = []
  try {
    // A run that reports it couldn't run refuses at once, too, rather than after its siblings' budgets.
    pending = requests.map(({ request, clients, host }) => Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return run(root, request, { signal: controller.signal, source, ...clients ? { clients } : {}, ...host ? { host } : {} })
    }).then(result => {
      const proof = completedProof(result, request)
      completed.push(proof); onResult(proof); assertRan(result); return result
    }).catch((error) => {
      controller.abort(error)
      throw error
    }))
    const results = await Promise.all(pending)
    controller.signal.throwIfAborted()
    return mergeResults(results)
  } catch (error) { failure = error; throw error }
  finally { await Promise.allSettled(pending); if (failure) failure.completedResults = completed; signal?.removeEventListener("abort", abort) }
}

/**
 * Runs the affected set, then reruns only its failures on the base. Refuses any failure that doesn't also
 * fail on the base, naming each; a failure the base shares is reported and doesn't block.
 */
export async function affectedTests(root, { source, signal, run = onFarm, timeoutMs = budgetMs } = {}) {
  const started = Date.now()
  // Leave time for runProcess's bounded SIGTERM/SIGKILL and admission cleanup.
  const allowance = Math.min(budgetMs, timeoutMs)
  const controller = new AbortController()
  const proven = { targets: 0, files: 0, sharedFailures: 0 }, proof = {}
  let stage = "gate-preparation"
  const overrun = () => new AffectedIncomplete(stage === "pg-admission" ? stage : "execution-deadline", "the gate exhausted its wall budget (at most 30 minutes)")
  const deadlineAt = started + allowance - Math.min(5000, allowance / 10)
  let rejectDeadline, cleanupTimer, settled, outcome
  const expired = new Promise((_, reject) => { rejectDeadline = reject })
  const timer = setTimeout(() => { const error = overrun(); controller.abort(error); rejectDeadline(error) }, Math.max(0, deadlineAt - Date.now()))
  const executionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const check = () => { if (Date.now() >= deadlineAt) controller.abort(overrun()); executionSignal.throwIfAborted() }
  try {
    check()
    source ??= jjSource(root)
    const plan = affectedPlan(root, source)
    check()
    if (!plan.labels.length && !plan.reachesMvp) return undefined
    const execute = async () => {
      stage = "execution"
      check()
      const snapshot = mkdtempSync(join(tmpdir(), "smithers-affected-head-"))
      try {
        source.materialize(snapshot)
        check()
        const tool = join(import.meta.dirname, "affected-run.mjs"), target = sourcePath(snapshot, ".smithers/flows/land/affected-run.mjs")
        mkdirSync(dirname(target), { recursive: true })
        if (run === onFarm) copyFileSync(tool, target)
        const result = await affectedIn(snapshot, source, { signal: executionSignal, run, proven, proof })
        check()
        return { ...result, proven }
      } finally { rmSync(snapshot, { recursive: true, force: true }) }
    }
    stage = "pg-admission"
    const work = run === onFarm && plan.reachesMvp ? withPgAdmission(execute, { signal: executionSignal, timeoutMs: Math.max(0, Math.min(admissionSeconds * 1000, deadlineAt - Date.now())) }) : execute()
    settled = work.then(value => { outcome = { value } }, error => { outcome = { error } })
    return await Promise.race([work, expired])
  } catch (error) {
    if (controller.signal.aborted && settled) {
      // Give cooperative clients the reserved cleanup time. An unresponsive runner cannot
      // extend the wall bound; its admission/snapshot stay owned until it actually settles.
      await Promise.race([settled, new Promise(resolve => { cleanupTimer = setTimeout(resolve, Math.max(0, started + allowance - Date.now())) })])
      if (outcome?.error) error = outcome.error
    }
    // A proved regression always wins, even if an unresponsive sibling exhausts cleanup.
    if (proof.refusal) throw proof.refusal
    if (error.status === "refused") throw error
    if (controller.signal.aborted && !(error instanceof AffectedIncomplete)) error = controller.signal.reason
    if (signal?.aborted && !(error instanceof AffectedIncomplete)) error = new AffectedIncomplete("cancellation", "gate canceled before execution proof completed")
    if (!(error instanceof AffectedIncomplete)) error = new AffectedIncomplete(stage, error.message)
    error.proven = proven
    throw error
  } finally { clearTimeout(timer); clearTimeout(cleanupTimer) }
}

async function affectedIn(root, source, { signal, run, proven, proof }) {
  const plan = affectedPlan(root, source)
  if (!plan.labels.length && !plan.reachesMvp) return undefined
  // The snapshot has no VCS data, so packages/smithers' fresh-clone tests read the source inventory from the
  // runner instead (SMITHERS_TEST_TRACKED_SOURCE_FILE). The runner lists it from the snapshot it was sent, which
  // holds only tracked files: inline, 959 paths made the request too long for one SSH argument to the via host.
  const tracked = true
  // Index targets run grouped by the platforms they declare, each group only on farm clients of those.
  const groups = new Map()
  for (const label of plan.labels) {
    const key = `${(plan.hosts?.[label] ?? []).join(",")}:${plan.docker?.[label] ? "docker" : "any"}`
    groups.set(key, [...groups.get(key) ?? [], label])
  }
  const requests = [...groups].map(([key, labels]) => {
    const [platformsText, dockerText] = key.split(":")
    const platforms = platformsText ? platformsText.split(",") : []
    const needsDocker = dockerText === "docker"
    if (!platforms.length && !needsDocker) return { request: { labels, vitest: false, tracked } }
    const clients = affectedHosts().filter((host) => !host.box && (!platforms.length || platforms.includes(host.platform)) && (!needsDocker || host.docker)).map((host) => host.client)
    if (!clients.length) throw new AffectedIncomplete("farm-routing", `no farm client runs ${key}, which ${labels.join(", ")} require`)
    return { request: { labels, vitest: false, tracked }, clients }
  })
  if (plan.reachesMvp) for (let i = 1; i <= vitestShards; i++) requests.push({ request: { labels: [], vitest: true, shard: `${i}/${vitestShards}` } })
  const baseEntries = source.baseEntries(), completed = [], touched = new Set(plan.changed), sharedConfirmed = new Set()
  let parentLabels
  if (!baseEntries.has(indexPath)) parentLabels = new Set()
  else {
    try {
      const rows = JSON.parse(source.baseBytes(indexPath).toString("utf8"))
      if (Array.isArray(rows) && rows.every(row => typeof row?.label === "string")) parentLabels = new Set(rows.map(row => row.label))
    } catch (error) { if (error.status === "incomplete" || error.status === "refused") throw error }
  }
  const rememberFailure = error => {
    const names = [...new Set([...(proof.refusal?.regressions ?? []), ...error.regressions])]
    proof.refusal = new Error(`The change fails ${names.length} tests that pass on ${plan.base}; nothing pushed.\n${names.slice(0, 60).join("\n")}`)
    proof.refusal.status = "refused"; proof.refusal.regressions = names
    return proof.refusal
  }
  const onResult = result => {
    completed.push(result)
    const partial = mergeResults(completed)
    proven.targets = partial.targets.results.filter(row => passed.has(row.status) || row.status === "failed").length
    proven.files = partial.vitest?.files.length ?? 0
    const names = [
      ...partial.targets.results.filter(row => row.status === "failed" && parentLabels && !parentLabels.has(row.label)).map(row => `${row.label} (failed target)`),
      ...(partial.vitest?.failed ?? []).filter(row => !baseEntries.has(`apps/mvp/${row.file}`) || (zeroIdentity(row) && touched.has(`apps/mvp/${row.file}`))).map(row => `apps/mvp/${row.file} > ${row.name}`)
    ]
    if (names.length) { const error = new Error(); error.regressions = names; throw rememberFailure(error) }
  }
  // The real farm takes every boxable run in one cfbox parallel; an injected run (tests) takes each alone.
  let result, headError
  try {
    result = run === onFarm
      ? mergeResults(await onFarmAll(root, requests, { signal, source: root, onResult }))
      : await runAll(run, root, requests, { signal, source: root, onResult })
  } catch (error) {
    if (proof.refusal) throw proof.refusal
    if (!error.completedResults?.length) throw error
    headError = error
    result = mergeResults(error.completedResults)
  }
  // Compare failures before reporting missing suites: proved regressions take precedence.
  assertRan(result)
  proven.targets = result.targets.results.filter(row => passed.has(row.status) || row.status === "failed").length
  proven.files = result.vitest?.files.length ?? 0
  const missing = missingSuites(plan, result)
  const failing = failingNames(result)
  if (!failing.length && headError) throw headError
  if (!failing.length && missing.length) throw new AffectedIncomplete("suite-completeness", incomplete(missing))
  if (!failing.length) { console.error(`AFFECTED passed: ${result.targets.results.length} targets, ${result.vitest?.files.length ?? 0} apps/mvp test files`); return result }
  console.error(`AFFECTED ${failing.length} failing on the head; rerunning them on ${plan.base}:\n${failing.slice(0, 200).join("\n")}`)
  // Each failure reruns on the client that saw it, and only there: a host's own environment can fail a test,
  // and a base run elsewhere would pass it and call the difference a regression.
  const tree = baseTree(root, plan, source)
  let onBase
  try {
    const failures = [...result.targets.results.filter((row) => row.status === "failed"), ...(result.vitest?.failed ?? [])]
    const destinations = [...new Map(failures.map(({ client, host, image }) => [JSON.stringify([client, host, image]), { client, host, image }])).values()]
    // A test file or target the base doesn't have can't fail there: its failure is the change's.
    const baseIndex = existsSync(join(tree, indexPath)) ? readJson(readFileSync(join(tree, indexPath), "utf8")) : []
    if (!Array.isArray(baseIndex) || baseIndex.some(row => typeof row?.label !== "string")) throw new AffectedIncomplete("parent-target-index", `${indexPath} on ${plan.base} is not a valid target list`)
    const baseRows = new Map(baseIndex.map((row) => [row.label, row]))
    const baseLabels = new Set(baseRows.keys())
    const proved = new Set()
    const refuseProved = () => {
      if (!proved.size) return
      const error = new Error(`The change fails ${proved.size} tests that pass on ${plan.base}; nothing pushed.\n${[...proved].slice(0, 60).join("\n")}`)
      error.status = "refused"; error.regressions = [...proved]; throw rememberFailure(error)
    }
    // New failed files/targets and touched zero-test files already prove a regression.
    for (const row of failures) {
      if (row.label ? !baseLabels.has(row.label) : !existsSync(join(tree, "apps/mvp", row.file)) || (zeroIdentity(row) && plan.changed.includes(`apps/mvp/${row.file}`))) {
        proved.add(row.label ? `${row.label} (failed target)` : `apps/mvp/${row.file} > ${row.name}`)
      }
    }
    refuseProved()
    const requests = destinations.flatMap(({ client, host, image }) => {
      const files = [...new Set((result.vitest?.failed ?? []).filter((test) => test.client === client && test.host === host && test.image === image).map((test) => test.file))].filter((file) => existsSync(join(tree, "apps/mvp", file)))
      const labels = result.targets.results.filter((row) => row.client === client && row.host === host && row.image === image && row.status === "failed" && baseLabels.has(row.label)).map((row) => row.label)
      const groups = new Map()
      for (const label of labels) {
        const kinds = baseRows.get(label).kinds ?? []
        const verb = ["test", "build", "lint", "run"].find((kind) => kinds.includes(kind))
        if (!verb) throw new AffectedIncomplete("parent-target-selection", `no executable verb for ${label}`)
        groups.set(verb, [...groups.get(verb) ?? [], label])
      }
      return [
        ...[...groups].map(([verb, labels]) => ({ request: { labels, verb, ...image ? { image } : {}, vitest: false, vitestFiles: [], tracked: true }, client, host })),
        ...files.length ? [{ request: { labels: [], vitest: true, vitestFiles: files, ...image ? { image } : {} }, client, host }] : []
      ]
    })
    // A base run counts only if it ran, and ran everything it was asked: a crash there excuses nothing.
    onBase = await runAll(async (_root, request, options) => {
      const client = options.clients[0]
      if (!request.labels.length && !request.vitest) return { targets: { results: [] }, client }
      const raw = await run(root, request, options)
      const result = completedProof(raw, request)
      const ran = new Set(result.targets.results.filter((row) => passed.has(row.status) || row.status === "failed").map((row) => row.label))
      const files = new Set(result.vitest?.files ?? [])
      const parentFailures = new Set(failingKeys(result))
      for (const row of failures.filter(row => row.client === client && row.host === options.host && row.image === request.image)) {
        const name = failureName(row), key = failureKey(row)
        const forced = row.unexcused === true && !zeroIdentity(row)
        if (parentFailures.has(key) && !forced) sharedConfirmed.add(key)
        else if ((row.label ? ran.has(row.label) : files.has(row.file)) && (!parentFailures.has(key) || forced)) proved.add(name)
      }
      // Preserve both positive and shared proof before classifying unrelated setup trouble.
      proven.sharedFailures = sharedConfirmed.size
      refuseProved()
      assertRan(raw)
      const missing = [...request.labels.filter((label) => !ran.has(label)), ...request.vitestFiles.filter((file) => !files.has(file)).map((file) => `apps/mvp/${file}`)]
      if (missing.length) throw new AffectedIncomplete("parent-suite-completeness", `${missing.length} suites did not run on ${plan.base}: ${missing.slice(0, 40).join(", ")}`)
      return result
    }, root, requests.map(({ request, client, host }) => ({ request, clients: [client], ...host ? { host } : {} })), { signal, source: tree }).catch(error => { refuseProved(); throw error })
  } finally { rmSync(tree, { recursive: true, force: true }) }
  const shared = new Set(failingKeys(onBase))
  // A failure with no identity to compare, such as a file that failed with no error, is never excused.
  const unexcused = new Set((result.vitest?.failed ?? []).filter((test) => zeroIdentity(test) ? touched.has(`apps/mvp/${test.file}`) : test.unexcused).map(failureKey))
  result.unchangedZeroTestFiles = [...new Set((result.vitest?.failed ?? []).filter((test) => zeroIdentity(test) && !touched.has(`apps/mvp/${test.file}`) && shared.has(failureKey(test))).map((test) => `apps/mvp/${test.file}`))].sort()
  const regressions = failingRows(result).filter(row => !shared.has(failureKey(row)) || unexcused.has(failureKey(row))).map(failureName)
  const keptRows = failingRows(result).filter(row => shared.has(failureKey(row)) && !unexcused.has(failureKey(row)))
  const kept = keptRows.map(failureName)
  result.excusedSkippedFiles = [...new Set((result.vitest?.failed ?? []).filter((test) => test.skipped === true && shared.has(failureKey(test))).map((test) => `apps/mvp/${test.file}`))].sort()
  if (result.excusedSkippedFiles.length) console.error(`AFFECTED skipped on both trees with matching reasons; excused files in receipt: ${result.excusedSkippedFiles.join(", ")}`)
  if (kept.length) console.error(`AFFECTED failing on ${plan.base} too, not blocking:\n${kept.join("\n")}`)
  const refusals = [
    ...regressions.length ? [`The change fails ${regressions.length} tests that pass on ${plan.base}; nothing pushed.\n${regressions.slice(0, 60).join("\n")}`] : [],
    ...missing.length ? [incomplete(missing)] : []
  ]
  proven.sharedFailures = new Set(keptRows.map(failureKey)).size
  if (regressions.length) { const error = new Error(refusals.join("\n")); error.status = "refused"; error.regressions = regressions; throw error }
  if (headError) throw headError
  if (missing.length) throw new AffectedIncomplete("suite-completeness", incomplete(missing))
  return result
}
