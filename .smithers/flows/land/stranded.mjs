#!/usr/bin/env node
/**
 * Classify commits outside main by content, not by subject.
 *
 * For every hunk of a candidate commit's own diff, ask whether its added lines
 * are in main's current tree (or, for a deletion hunk, whether the removed lines
 * are gone). Missing content is then checked for supersession: a later main
 * commit whose diff carries those lines (main had them, then changed them), a
 * file main deleted, or a later commit in the candidate's own stack that changed
 * them again. Read-only: every jj call uses --ignore-working-copy.
 *
 * Usage:
 *   node .smithers/flows/land/stranded.mjs --repo <jj repo> --tree <dir at main@origin>
 *     [--revset <candidates>] [--exclude <revset>] [--since YYYY-MM-DD]
 *     [--json <out.json>] [--md <out.md>] [--title <text>]
 *
 * --tree must be a directory whose files are main@origin's tree (an empty jj
 * workspace at main@origin); it is the reference "main" for every repository.
 */
import { spawn, spawnSync } from "node:child_process"
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

export const generatedPaths = new Set(["pnpm-lock.yaml", "bun.lock", ".smithers/target-index.json", "apps/mvp/src/device/schemas.lock.json"])
export const scaffoldPattern = /\b(temporary|temp(?:orary)? (?:red|proof)|red proof|crash red|scaffold|throwaway|do not land|wip\b|checkpoint\b|stage (?:unchanged )?w\d+ .*qualification)/i
const SEP = "\x1f"

export function jjRun(repo, args, { allowFail = false } = {}) {
  const result = spawnSync("jj", ["-R", repo, "--ignore-working-copy", "--no-pager", "--color=never", ...args], { encoding: "utf8", maxBuffer: 1 << 30 })
  if (result.status !== 0 && !allowFail) throw new Error(`jj ${args.join(" ")}: ${result.stderr}`)
  return result.status === 0 ? result.stdout : ""
}

/** A repository-relative exact path as a fileset; a quoted string alone is a cwd-relative path to jj. */
export const fileset = (path) => `root-file:${quote(path)}`
const quote = (text) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/** A line worth matching: not blank, not lone punctuation, not trivially short. */
export function significant(line) {
  const text = line.trim()
  // jj conflict markers are not content.
  if (/^(?:%{7}|\+{7}|-{7}|<{7}|>{7}|\\{7})(?: |$)/.test(text)) return false
  if (text.length < 6) return false
  if (/^[\s{}()[\];,.:'"`<>/*#|=+-]*$/.test(text)) return false
  return true
}

/** Parse `jj diff --git` output into files and hunks. */
export function parseDiff(text) {
  const files = []
  let file, hunk
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      file = { from: match?.[1], path: match?.[2], hunks: [], binary: false, deleted: false, created: false }
      files.push(file); hunk = undefined; continue
    }
    if (!file) continue
    if (!hunk) {
      if (line.startsWith("deleted file mode")) file.deleted = true
      else if (line.startsWith("new file mode")) file.created = true
      else if (line.startsWith("rename from ")) file.from = line.slice(12)
      else if (line.startsWith("rename to ")) file.path = line.slice(10)
      else if (line.startsWith("Binary files")) file.binary = true
    }
    if (line.startsWith("@@")) { hunk = { header: line, added: [], removed: [] }; file.hunks.push(hunk); continue }
    if (!hunk) continue
    if (line.startsWith("+")) hunk.added.push(line.slice(1))
    else if (line.startsWith("-")) hunk.removed.push(line.slice(1))
  }
  return files
}

export class MainTree {
  constructor(root) { this.root = root; this.cache = new Map(); this.global = undefined }
  lines(path) {
    if (this.cache.has(path)) return this.cache.get(path)
    let value = null
    try {
      const full = join(this.root, path)
      if (statSync(full).isFile()) value = new Set(readFileSync(full, "utf8").split("\n").map((l) => l.trim()))
    } catch {}
    this.cache.set(path, value)
    return value
  }
  bytesHash(path) {
    try { return createHash("sha256").update(readFileSync(join(this.root, path))).digest("hex") } catch { return null }
  }
  /** Long lines anywhere in main, for content that moved to another file. */
  anywhere(line) {
    if (!this.global) {
      this.global = new Set()
      const walk = (dir) => {
        for (const entry of readdirSync(join(this.root, dir), { withFileTypes: true })) {
          if ([".jj", ".git", "node_modules", "dist", ".cache"].includes(entry.name)) continue
          const rel = dir ? `${dir}/${entry.name}` : entry.name
          if (entry.isDirectory()) walk(rel)
          else if (entry.isFile()) {
            try {
              const full = join(this.root, rel)
              if (statSync(full).size > 2_000_000) continue
              for (const l of readFileSync(full, "utf8").split("\n")) { const t = l.trim(); if (t.length >= 25) this.global.add(t) }
            } catch {}
          }
        }
      }
      walk("")
    }
    return this.global.has(line)
  }
}

/** Fraction of significant lines found, by the given predicate. */
const fraction = (lines, has) => lines.length ? lines.filter(has).length / lines.length : 1

/** Judge one hunk against main. Returns {state: on|missing|part|trivial, lines: string[]}. */
export function judgeHunk(tree, path, hunk) {
  const added = [...new Set(hunk.added.filter(significant).map((l) => l.trim()))]
  const addedSet = new Set(added)
  const removed = [...new Set(hunk.removed.filter(significant).map((l) => l.trim()))].filter((l) => !addedSet.has(l))
  const main = tree.lines(path)
  if (added.length) {
    const here = (l) => (main?.has(l) ?? false) || (l.length >= 25 && tree.anywhere(l))
    const score = fraction(added, here)
    const missing = added.filter((l) => !here(l))
    return { state: score >= 0.9 ? "on" : score <= 0.3 ? "missing" : "part", score, missing, kind: "add" }
  }
  if (removed.length) {
    const gone = (l) => !(main?.has(l) ?? false)
    const score = fraction(removed, gone)
    const missing = removed.filter((l) => !gone(l))
    return { state: score >= 0.9 ? "on" : score <= 0.3 ? "missing" : "part", score, missing, kind: "delete" }
  }
  return { state: "trivial", score: 1, missing: [], kind: "trivial" }
}

/**
 * Main's history since the oldest fork: which files each main commit touched,
 * and (lazily) the lines each one added or removed in a file. One jj call for
 * the file map; one cached `jj diff` per (main commit, file) after that.
 */
export class MainHistory {
  constructor(repo, since) {
    this.repo = repo
    this.since = since
    this.diffs = new Map()
    this.order = new Map()
    this.byPath = new Map()
    const text = jjRun(repo, ["log", "--no-graph", "-r", `::main@origin & committer_date(after:${quote(since)})`, "-T",
      `"@@" ++ commit_id.short(10) ++ "${SEP}" ++ description.first_line() ++ "\\n" ++ self.diff().files().map(|f| f.path()).join("\\n") ++ "\\n"`])
    this.subjects = new Map()
    let current, index = 0
    for (const line of text.split("\n")) {
      if (line.startsWith("@@")) { const [id, subject] = line.slice(2).split(SEP); current = id; this.subjects.set(id, subject); this.order.set(id, index++); continue }
      if (!line || !current) continue
      if (!this.byPath.has(line)) this.byPath.set(line, [])
      this.byPath.get(line).push(current) // newest first
    }
    this.after = new Map()
  }
  /** Main commits not in the candidate's ancestry. */
  afterFork(commit) {
    if (!this.after.has(commit)) this.after.set(commit, new Set(jjRun(this.repo, ["log", "--no-graph", "-r", `(::main@origin ~ ::${commit}) & committer_date(after:"2026-01-01")`, "-T", 'commit_id.short(10) ++ "\\n"']).split("\n").filter(Boolean)))
    return this.after.get(commit)
  }
  /** Lines each main commit (since `since`) added or removed in path: one jj call per path. */
  lines(id, path) {
    if (!this.diffs.has(path)) {
      const perCommit = new Map()
      const text = jjRun(this.repo, ["log", "--no-graph", "-r", `::main@origin & committer_date(after:${quote(this.since)}) & files(${fileset(path)})`,
        "--git", "-T", '"@@COMMIT " ++ commit_id.short(10) ++ "\\n"', fileset(path)])
      let current
      for (const chunk of text.split(/^@@COMMIT /m).filter(Boolean)) {
        const newline = chunk.indexOf("\n")
        current = chunk.slice(0, newline).trim()
        const added = new Set(), removed = new Set()
        for (const file of parseDiff(chunk.slice(newline + 1)))
          for (const hunk of file.hunks) { for (const l of hunk.added) added.add(l.trim()); for (const l of hunk.removed) removed.add(l.trim()) }
        perCommit.set(current, { added, removed })
      }
      this.diffs.set(path, perCommit)
    }
    return this.diffs.get(path).get(id) ?? { added: new Set(), removed: new Set() }
  }
  /** The newest main commit after the fork that touched path. */
  lastTouch(commit, path) {
    const after = this.afterFork(commit)
    const id = (this.byPath.get(path) ?? []).find((c) => after.has(c))
    return id ? `${id} (${this.subjects.get(id)})` : undefined
  }
  /** Main carried these lines (added or removed them) after the fork, yet they are gone now: superseded. */
  carrier(commit, path, missing) {
    if (!missing.length) return undefined
    const after = this.afterFork(commit)
    for (const id of (this.byPath.get(path) ?? []).filter((c) => after.has(c))) {
      const { added, removed } = this.lines(id, path)
      const hits = missing.filter((l) => added.has(l) || removed.has(l)).length
      if (hits / missing.length >= 0.5) return `${id} (${this.subjects.get(id)})`
    }
    return undefined
  }
}

const pickProbe = (lines) => [...lines].sort((a, b) => b.length - a.length).find((l) => l.length >= 12 && l.length <= 200) ?? lines[0]

export function listCandidates(repo, revset) {
  const template = ["commit_id", "change_id.short(12)", 'author.timestamp().format("%Y-%m-%d %H:%M")', 'committer.timestamp().format("%Y-%m-%d %H:%M")',
    'parents.map(|p| p.commit_id()).join(",")', 'local_bookmarks.map(|b| b.name()).join(",")', 'working_copies', 'if(conflict, "conflict", "")', 'if(divergent, "divergent", "")', "description.first_line()"].join(` ++ "${SEP}" ++ `) + ' ++ "\\n"'
  return jjRun(repo, ["log", "--no-graph", "-r", revset, "-T", template]).split("\n").filter(Boolean).map((line) => {
    const [id, change, authored, committed, parents, bookmarks, workingCopies, conflict, divergent, subject] = line.split(SEP)
    return { id, short: id.slice(0, 10), change, authored, committed, parents: parents.split(",").filter(Boolean), bookmarks: bookmarks.split(",").filter(Boolean), workingCopies: workingCopies.trim(), conflict: !!conflict, divergent: !!divergent, subject }
  })
}

export function classifyCommit(repo, tree, commit, { lineage, history } = {}) {
  const files = parseDiff(jjRun(repo, ["diff", "--git", "-r", commit.id]))
  const out = { files: files.length, hunks: 0, on: 0, missing: 0, part: 0, superseded: 0, generated: [], evidence: [], gaps: [] }
  let significantLines = 0
  for (const file of files) {
    if (generatedPaths.has(file.path)) { out.generated.push(file.path); continue }
    const judged = []
    if (file.binary) {
      const want = file.deleted ? null : createHash("sha256").update(spawnSync("jj", ["-R", repo, "--ignore-working-copy", "file", "show", "-r", commit.id, fileset(file.path)], { maxBuffer: 1 << 30 }).stdout).digest("hex")
      significantLines++
      judged.push({ state: tree.bytesHash(file.path) === want ? "on" : "missing", missing: [], kind: "binary" })
    } else if (!file.hunks.length) {
      if (file.from !== file.path) { significantLines++; judged.push({ state: tree.lines(file.path) && !tree.lines(file.from) ? "on" : "missing", missing: [], kind: "rename" }) }
    } else for (const hunk of file.hunks) {
      const verdict = judgeHunk(tree, file.path, hunk)
      if (verdict.state === "trivial") continue
      significantLines += hunk.added.filter(significant).length + hunk.removed.filter(significant).length
      judged.push(verdict)
    }
    for (const verdict of judged) {
      out.hunks++
      if (verdict.state === "on") { out.on++; continue }
      // Missing or partial: look for the reason before calling it stranded.
      const probe = verdict.missing.length ? pickProbe(verdict.missing) : undefined
      let reason
      if (!reason && tree.lines(file.path) === null && verdict.kind !== "delete") {
        const last = history.lastTouch(commit.id, file.path)
        if (last) reason = `main deleted it in ${last}`
      }
      if (!reason && verdict.kind === "add") {
        const carrier = history.carrier(commit.id, file.path, verdict.missing)
        if (carrier) reason = `main carried then changed it: ${carrier}`
      }
      if (!reason && lineage) { const later = lineage.changedLater(commit, file.path, verdict.missing); if (later) reason = later }
      if (reason) { out.superseded++; out.evidence.push(`${file.path}: ${reason}`) }
      else {
        if (verdict.state === "part") out.part++; else out.missing++
        out.gaps.push(`${file.path}${probe ? `: ${probe.slice(0, 80)}` : ` (${verdict.kind})`}`)
      }
    }
  }
  let klass
  if (!significantLines) klass = "EMPTY-ISH"
  else if (out.missing + out.part === 0) klass = out.superseded ? "SUPERSEDED" : "ON-MAIN"
  else if (out.on + out.superseded === 0 && out.part === 0) klass = "STRANDED"
  else klass = "PARTIAL"
  if ((klass === "STRANDED" || klass === "PARTIAL") && scaffoldPattern.test(commit.subject)) klass = "SCAFFOLD"
  return { ...out, class: klass, significantLines }
}

/**
 * Later commits in the candidate's own stack that changed the missing lines:
 * if every candidate descendant head lacks the lines, the stack itself moved on.
 */
export function makeLineage(repo, candidates) {
  const ids = new Set(candidates.map((c) => c.id))
  const heads = new Map()
  const removedLater = new Map()
  const headsOf = (commit) => {
    if (!heads.has(commit.id)) heads.set(commit.id, jjRun(repo, ["log", "--no-graph", "-r", `heads(${commit.id}:: & ~${commit.id})`, "-T", 'commit_id ++ "\\n"']).split("\n").filter(Boolean))
    return heads.get(commit.id)
  }
  /** Lines removed per path between the commit and one descendant head: one jj call per pair. */
  const removedBy = (commit, head) => {
    const key = `${commit}:${head}`
    if (!removedLater.has(key)) {
      const byPath = new Map()
      for (const file of parseDiff(jjRun(repo, ["diff", "--git", "--from", commit, "--to", head], { allowFail: true }))) {
        const set = new Set()
        for (const hunk of file.hunks) for (const l of hunk.removed) set.add(l.trim())
        byPath.set(file.from ?? file.path, set)
      }
      removedLater.set(key, byPath)
    }
    return removedLater.get(key)
  }
  return {
    changedLater(commit, path, missing) {
      if (!missing.length) return undefined
      const descendants = headsOf(commit)
      if (!descendants.length) return undefined
      if (!descendants.every((head) => { const removed = removedBy(commit.id, head).get(path); return removed && missing.every((line) => removed.has(line)) })) return undefined
      return `changed later in its stack (head ${descendants.map((h) => h.slice(0, 10)).join(", ")})`
    },
    ids,
  }
}

/**
 * A stack's net change: its head against the fork point with main. Intermediate
 * edits inside the stack collapse, so this is what landing the stack must add.
 */
export function netVerdict(repo, tree, head) {
  const fork = jjRun(repo, ["log", "--no-graph", "-r", `heads(::${head} & ::main@origin)`, "-T", 'commit_id ++ "\\n"']).split("\n").filter(Boolean)[0]
  if (!fork) return { on: 0, missing: 0, part: 0, gaps: [] }
  const files = parseDiff(jjRun(repo, ["diff", "--git", "--from", fork, "--to", head]))
  const net = { fork: fork.slice(0, 10), on: 0, missing: 0, part: 0, lines: 0, gaps: [], files: [] }
  for (const file of files) {
    if (generatedPaths.has(file.path)) continue
    let fileMissing = 0
    for (const hunk of file.hunks) {
      const verdict = judgeHunk(tree, file.path, hunk)
      if (verdict.state === "trivial") continue
      if (verdict.state === "on") net.on++
      else { verdict.state === "part" ? net.part++ : net.missing++; fileMissing += verdict.missing.length; net.gaps.push(`${file.path}: ${verdict.missing[0]?.slice(0, 80) ?? verdict.kind}`) }
    }
    if (fileMissing) { net.files.push(`${file.path} (${fileMissing})`); net.lines += fileMissing }
  }
  return net
}

/**
 * Workspaces that are other agents' live work: a process whose cwd is inside,
 * or a file (outside .jj and node_modules) modified in the last `hours`.
 */
export function liveWorkspaces(repo, hours = 6) {
  const cwds = spawnSync("lsof", ["-d", "cwd", "-Fn"], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1))
  const names = jjRun(repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n").filter(Boolean)
  return names.map((name) => {
    const root = jjRun(repo, ["workspace", "root", "--name", name], { allowFail: true }).trim()
    if (!root || !existsSync(root)) return { name, root, live: false, reason: "no directory" }
    const process = cwds.some((cwd) => cwd === root || cwd.startsWith(`${root}/`))
    const recent = spawnSync("find", [root, "(", "-name", ".jj", "-o", "-name", ".git", "-o", "-name", "node_modules", ")", "-prune", "-o", "-type", "f", "-mmin", `-${hours * 60}`, "-print", "-quit"], { encoding: "utf8" }).stdout.trim()
    return { name, root, live: process || !!recent, reason: [process && "process cwd", recent && `edited ${recent.slice(root.length + 1)}`].filter(Boolean).join(", ") }
  })
}

function parseArgs(argv) {
  const args = { exclude: [] }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "")
    if (key === "exclude") args.exclude.push(argv[++i])
    else if (key === "skip-live") args.skipLive = true
    else args[key.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i]
  }
  return args
}

export async function run(args) {
  const repo = args.repo
  if (!repo || !args.tree) throw new Error("Usage: --repo <jj repo> --tree <dir at main@origin> [--revset r] [--exclude r] [--since date] [--json f] [--md f]")
  const treeMain = jjRun(args.tree, ["log", "--no-graph", "-r", "main@origin", "-T", "commit_id"])
  const treeAt = jjRun(args.tree, ["diff", "--from", "main@origin", "--to", "@", "--summary"]).trim()
  if (treeAt) throw new Error(`--tree is not at main@origin: ${treeAt.split("\n")[0]}`)
  const repoMain = jjRun(repo, ["log", "--no-graph", "-r", "main@origin", "-T", "commit_id"])
  let revset = args.revset ?? "~::main@origin & ~empty() & ~::remote_bookmarks(remote=origin)"
  if (args.since) revset = `(${revset}) & committer_date(after:${quote(args.since)})`
  for (const exclude of args.exclude) revset = `(${revset}) ~ (${exclude})`
  // Other agents' live workspaces are listed, not judged.
  let skipped = []
  if (args.skipLive !== undefined && !args.shard) {
    const own = new Set((args.own ?? "").split(",").filter(Boolean))
    skipped = liveWorkspaces(repo).filter((w) => w.live && !own.has(w.name))
    if (skipped.length) revset = `(${revset}) ~ (${skipped.map((w) => `${quote(w.name)}@`).join(" | ")})`
  }
  // Another lane's copies of a stack it owns: same subject, committed after that stack's newest commit.
  if (args.excludeCopiesOf && !args.shard) {
    const owned = jjRun(repo, ["log", "--no-graph", "-r", `${args.excludeCopiesOf} ~ ::main@origin`, "-T", `description.first_line() ++ "${SEP}" ++ committer.timestamp().format("%Y-%m-%d") ++ "\\n"`]).split("\n").filter(Boolean).map((l) => l.split(SEP))
    const newest = owned.map(([, d]) => d).sort().at(-1)
    const subjects = [...new Set(owned.map(([subject]) => subject))]
    if (subjects.length) revset = `(${revset}) ~ ((${subjects.map((subject) => `description(substring:${quote(subject)})`).join(" | ")}) & committer_date(after:${quote(newest)}))`
  }
  const candidates = listCandidates(repo, revset)
  const results = []
  if (args.shard) {
    const [k, n] = args.shard.split("/").map(Number)
    const tree = new MainTree(args.tree)
    const lineage = makeLineage(repo, candidates)
    const history = new MainHistory(repo, args.historySince ?? "2026-09-15")
    for (const [index, commit] of candidates.entries()) {
      if (index % n !== k) continue
      const verdict = classifyCommit(repo, tree, commit, { lineage, history })
      results.push({ ...commit, ...verdict })
      process.stderr.write(`[${k}/${n}] ${index + 1}/${candidates.length} ${commit.short} ${verdict.class}\n`)
    }
    writeFileSync(args.json, JSON.stringify(results))
    return { results }
  }
  // Fan out over --jobs processes (each one sequential jj calls), then merge.
  const jobs = Number(args.jobs ?? 8)
  const children = Array.from({ length: jobs }, (_, k) => {
    const out = `${args.json ?? "/tmp/stranded"}.shard${k}`
    const forwarded = ["--repo", repo, "--tree", args.tree, "--revset", revset, "--shard", `${k}/${jobs}`, "--json", out]
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, ...forwarded], { stdio: ["ignore", "inherit", "inherit"] })
    return { out, exited: new Promise((done, fail) => child.on("exit", (code) => code === 0 ? done() : fail(new Error(`shard ${k} exited ${code}`)))) }
  })
  await Promise.all(children.map((c) => c.exited))
  const order = new Map(candidates.map((c, i) => [c.id, i]))
  for (const { out } of children) results.push(...JSON.parse(readFileSync(out, "utf8")))
  results.sort((a, b) => order.get(a.id) - order.get(b.id))
  const tree = new MainTree(args.tree)
  // Every head of the candidate set, with the bookmark that names it.
  const headIds = jjRun(repo, ["log", "--no-graph", "-r", `heads(${revset})`, "-T", 'commit_id ++ "\\n"']).split("\n").filter(Boolean)
  const byId = new Map(results.map((r) => [r.id, r]))
  const stacks = headIds.map((head) => {
    const members = jjRun(repo, ["log", "--no-graph", "-r", `(::${head}) & (${revset})`, "-T", 'commit_id ++ "\\n"']).split("\n").filter(Boolean)
    const counts = {}
    for (const id of members) { const k = byId.get(id)?.class; counts[k] = (counts[k] ?? 0) + 1 }
    const net = netVerdict(repo, tree, head)
    return { head, memberIds: members, short: head.slice(0, 10), bookmarks: byId.get(head)?.bookmarks ?? [], workingCopies: byId.get(head)?.workingCopies ?? "", members: members.length, counts, net }
  })
  for (const r of results) r.stacks = []
  for (const s of stacks) for (const id of s.memberIds) byId.get(id)?.stacks.push(s.bookmarks[0] ?? s.short)
  for (const s of stacks) delete s.memberIds
  const report = { repo, repoMain, treeMain, revset, generated: new Date().toISOString(), results, stacks, skipped }
  if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2))
  if (args.md) writeFileSync(args.md, renderMarkdown(report, args.title))
  return report
}

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")

export function renderMarkdown(report, title = "Stranded commits") {
  const counts = {}
  for (const r of report.results) counts[r.class] = (counts[r.class] ?? 0) + 1
  const lines = [`## ${title}`, "", `Repository \`${report.repo}\`, main \`${report.repoMain.slice(0, 12)}\`, judged against main@origin \`${report.treeMain.slice(0, 12)}\` on ${report.generated}.`, "", `Candidates: \`${report.revset}\`.`, "",
    "| Class | Commits |", "|---|---|", ...Object.entries(counts).sort().map(([k, v]) => `| ${k} | ${v} |`), "",
    "### Heads", "", "Net: the head against its fork point with main, hunks on main / missing / partial, and missing lines.", "",
    "| Head | Bookmark / working copy | Commits | Classes | Net on/missing/partial (lines) | Missing files |", "|---|---|---|---|---|---|",
    ...report.stacks.map((s) => `| \`${s.short}\` | ${cell([...s.bookmarks, s.workingCopies].filter(Boolean).join(" "))} | ${s.members} | ${cell(Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(", "))} | ${s.net.on}/${s.net.missing}/${s.net.part} (${s.net.lines}) | ${cell(s.net.files.slice(0, 4).join(", ").slice(0, 200))} |`), "",
    "### Live workspaces skipped", "", ...(report.skipped?.length ? ["| Workspace | Directory | Why |", "|---|---|---|", ...report.skipped.map((w) => `| ${w.name} | \`${w.root}\` | ${cell(w.reason)} |`)] : ["None."]), "",
    "### Commits", "", "| Authored | Commit | Class | Hunks on/superseded/missing/partial | Stack | Subject | Evidence or gap |", "|---|---|---|---|---|---|---|",
    ...[...report.results].sort((a, b) => a.authored.localeCompare(b.authored)).map((r) => `| ${r.authored} | \`${r.short}\` | ${r.class} | ${r.on}/${r.superseded}/${r.missing}/${r.part} | ${cell(r.stacks.slice(0, 2).join(" "))} | ${cell(r.subject)} | ${cell([...r.gaps.slice(0, 2), ...r.evidence.slice(0, 1)].join("; ").slice(0, 220))} |`)]
  return lines.join("\n") + "\n"
}

if (import.meta.url === `file://${process.argv[1]}`) await run(parseArgs(process.argv.slice(2)))
