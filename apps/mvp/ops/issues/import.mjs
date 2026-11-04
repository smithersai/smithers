#!/usr/bin/env node
// Plans the import of our open work into issues on the public repositories, as a tree under "Ship VibeLang"
// (tree.mjs). It reads, scrubs, deduplicates and places; it posts nothing. The plan is a mode-600 JSONL file that
// contains private repository verdicts, so it never goes in a repository.
//
//   node ops/issues/import.mjs --out <plan.jsonl> --draft <source>=<file>... --private-repos <file>
//   node ops/issues/import.mjs --out <plan.jsonl> [--source lane-host|fuzz]... [--host <lane host>]
//                              [--draft <source>=<file or host:path>]... [--replace-findings <repo>]... [--pending-ref main]
//
// Draft mode, the first form: one or more `--draft` and no `--source`. It reads only the named local draft files, then
// counts every normalized status and plans only open drafts, placing, scrubbing and deduplicating them with the tree.
// It runs no `gh` and no `ssh`, so an agent holding only the App's machine token can plan its drafts: agent actions
// go through the App, never a personal login. A
// `host:path` draft needs ssh, so draft mode refuses it; copy the file here, or select a source. It reads no existing
// issues: `issues/file-tree` reuses an issue or a tree node by its `key:` marker when it files
// (ops/issues/track.mjs `findMatch`). Private repository names for the scrub come from `--private-repos <file>` or
// $SMITHERS_PRIVATE_REPOS_FILE, one per line (`name` for every owner, or `owner/name`), as for track.mjs. Every
// listed name is private wherever it appears, under any owner or path root; with no list, nothing is planned.
// Repository references come from one decode-then-extract pipeline (scrub.mjs, "Repository references"), shared by
// discovery and the scrub: every decoded reading (NFKC, percent escapes, named and numeric entities, Markdown
// escapes, tab/CR/LF removal, and slash runs, `/./` and the fraction and division slashes read as `/`) of every
// token is read for a URL's repository (GitHub-owned hosts, GitLab, Bitbucket,
// github1s, Sourcegraph, smithers.sh, the API's /repos, and Pages, where `<owner>.github.io/<name>` names
// `<owner>/<name>`), for a bare pair that starts a path (dotted names and path suffixes included; a lowercase
// apps/packages/src/lib/test/docs/node_modules/worker/ops/e2e/dist root starts a file path instead), for every
// other pair inside a repository's path, query keys and values, and fragment (the nested references), and, in any
// position, for a pair under a watched owner (smithersai, roninjin10, evmts, codeplanesmithers, a target's owner and
// a listed owner). Only the path's own structure is exempt: the repository name joined to the next segment, a route
// to its ref or number, a common ref to its first directory, and a file path after a path root. Gists, unknown
// GitHub routes and zero-name code or unknown hosts are denied; example.org/com/net, developer.mozilla.org and
// w3.org links are not code links. Each unconfirmed reference is redacted by its source span; a second layer redacts
// every known private name (the private list, and names learned private under a watched owner) found as text in any
// normalized reading. See work-links.md "Repository confirmation" for the readings and the bare-name rule.
// Tree destinations, repeatable --repo targets and explicit draft repo fields are checked first, then primary
// references in order, then nested ones, each only once a repository around it is public. --public-repos
// <mode-600-file> grants exact owner/name entries only; --private-repos always wins. Public private:false
// verdicts persist in ~/.cache/smithers/public-repos.json (mode 600, 24h TTL); no other verdict is cached.
// Each reference is denied unless GET https://api.github.com/repos/<owner>/<name> returns 200 with private:false,
// its fresh cached verdict exists, or the allowlist grants it. The read is anonymous, or uses the App's read token
// when SMITHERS_GITHUB_READ_TOKEN_FILE names one whose scope receipt covers the owner (githubRead.mjs); no gh or
// ssh is used for verification. 404 is private; other statuses, invalid replies and network errors are
// unconfirmed. Both are scrubbed. Each case-insensitive name is checked once per run; 403/429 stops later requests
// of that kind, and 60 anonymous or 500 App-token requests stop that kind too. A body can be
// redacted; an exact field needing redaction drops its row. Generated nodes, destinations and property names are
// checked too. Every decoded
// name is credential-screened before requests or reports; diagnostics never include arbitrary keys. URL fields
// are parsed whole (spaces included). Credential-bearing fields
// are opaque to discovery: no substring is requested or reported after redaction erases credential context.
// Credential-named properties (also decoded) keep their values/subtrees opaque and cannot appear in public rows.
// The summary (stdout and plan) lists `repositories: [{ repo, verdict, reason }]`, also written to mode-600
// `<out>.repos.json`. `repositoryRequests` counts actual requests (`anonymousRepositoryRequests` and
// `authenticatedRepositoryRequests` split them); `unconfirmedRepositories` lists exact names
// to consider for a mode-600 --public-repos allowlist and rerun. These reports include private names: inspect
// locally before filing, never publish them.
//
// The second form reads the selected sources, every source when no `--source` and no `--draft` is given:
// - `lane-host`, over SSH, read-only: the merge queue (`~/vibe/mq/queue.jsonl`, latest state per id; its entries are
//   work, so they file no issue: one naming none goes in `<out>.queue-unlinked.jsonl`, mode 600, until TODO leaves
//   can hold it), the latest
//   spec-review round and the scoped reviews (`~/vibe/review-spec/loop`), and each example repository's migration
//   inbox (`~/vibe/review-spec/fuzz-coverage/inbox/migrate-<repo>.md`); lane reports (`~/lanes/*.REPORT.md`) are
//   counted and dated only, since they hold no open/fixed finding records;
// - `fuzz`, main's pending fuzz gaps (`typescript/tsc/internal/vibelangfuzz/testdata/pending/*.txt` on smithersai/vibelang),
//   through `gh api`;
// - the agents' issue drafts, `--draft <source>=<file>` (a JSON array or JSONL; `host:path` reads over SSH). A
//   source whose drafts cover its whole migration inbox, `--replace-findings <repo>`, stands in for that inbox's
//   parsed findings. A repository's tracking draft becomes its tree node's issue.
// Repository verification uses the same deny-by-default check in both forms, never `gh repo list`.
// Source collection still uses the operator's own `gh` and `ssh` logins, so only an operator runs this form.
//
// Non-open drafts are counted and saved to `<out>.skipped.jsonl` (mode 600), with key, status and any duplicate_of.
// Unknown draft statuses refuse the import with exit 2 before output files are written.
//
// Plan rows, in filing order: `{"type":"node", ...}` (the tree), then `{"type":"issue", ...}` (drafts, then findings;
// each with key, repo, title, body, labels, links, parent, depth), then `{"type":"queue-link", key, repo, issue, link}`
// (a `queue` work link per issue an open merge-queue entry names), then
// `{"type":"dropped", key, kind, problems}` for each refused record (opaque key, field and rule only).
// Duplicate rows likewise use opaque keys; rejected source content never enters these diagnostics. Then `{"type":"summary", ...}` with counts per kind, repo, parent and drop rule.
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import { cleanRecord } from "./scrub.mjs"
import { confirmRepositories, publicCacheFile, publicReposOf } from "./repositories.mjs"
import { PENDING_URL, draftRecords, formatRecord, fuzzRecords, migrationRecords, queuePlan, reviewRoundRecords, scopedRecords } from "./sources.mjs"
import { MIGRATED_REPOS, place } from "./tree.mjs"
import { markerOf, bodyWithMarker, privateReposOf } from "./track.mjs"

/** The sources besides drafts: each needs the operator's own logins (`ssh` to the lane host, `gh`). */
const SOURCES = ["lane-host", "fuzz"]

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "nyc-01" },
    out: { type: "string" },
    draft: { type: "string", multiple: true, default: [] },
    "pending-ref": { type: "string", default: "main" },
    "replace-findings": { type: "string", multiple: true, default: [] },
    source: { type: "string", multiple: true, default: [] },
    "private-repos": { type: "string" },
    "public-repos": { type: "string" },
    repo: { type: "string", multiple: true, default: [] },
  },
})
if (values.out === undefined) throw new Error("--out <plan.jsonl> is required")
for (const source of values.source) if (!SOURCES.includes(source)) throw new Error(`--source is one of ${SOURCES.join(", ")}`)
const draftOnly = values.draft.length > 0 && values.source.length === 0
const selected = new Set(draftOnly ? [] : values.source.length === 0 ? SOURCES : values.source)
const drafts = values.draft.map((spec) => {
  const at = spec.indexOf("=")
  if (at <= 0) throw new Error(`--draft is <source>=<file>, not ${spec}`)
  return { source: spec.slice(0, at), file: spec.slice(at + 1) }
})
/** A draft file named `<host>:<path>` with no local file of that name: read over SSH. */
const remoteDraft = (file) => (existsSync(file) ? null : /^([\w.-]+):((?:~|\/).*)$/.exec(file))
if (draftOnly) {
  for (const { source, file } of drafts) {
    if (remoteDraft(file) !== null) throw new Error(`--draft ${source}=${file} is on another host and needs ssh: draft mode reads local files only. Copy it here, or add --source lane-host`)
  }
}
const namedPublic = publicReposOf(values["public-repos"])
const namedPrivate = privateReposOf(values["private-repos"] ?? process.env.SMITHERS_PRIVATE_REPOS_FILE)
// The private list forces names private everywhere, even where GitHub would answer public or a reference sits in a
// path the scrub otherwise reads as a file. A run without one cannot honor it, so nothing is planned.
if (namedPrivate.length === 0) {
  throw new Error("no private repository names: the importer reads them from --private-repos <file> or SMITHERS_PRIVATE_REPOS_FILE, one per line. The scrub would miss them, so nothing is planned")
}
// One read-only pass on the lane host. It opens files for reading and lists directories; nothing else.
const REMOTE = String.raw`
import json, os, glob, re
home = os.path.expanduser("~")
def text(path, limit=4000000):
    try:
        with open(path, errors="replace") as f: return f.read(limit)
    except OSError: return None
entries = {}
for line in open(home + "/vibe/mq/queue.jsonl", errors="replace"):
    try: entry = json.loads(line)
    except ValueError: continue
    if isinstance(entry, dict) and entry.get("id"): entries[entry["id"]] = entry
for entry in entries.values():
    print(json.dumps({"kind": "queue", "entry": {k: entry.get(k) for k in ("id", "rev", "lane", "commits", "at", "state", "reason", "issues")}}))
loop = home + "/vibe/review-spec/loop"
rounds = sorted(int(m.group(1)) for d in os.listdir(loop) for m in [re.match(r"r(\d+)$", d)] if m)
if rounds:
    r = rounds[-1]
    for reviewer in sorted(os.listdir("%s/r%d" % (loop, r))):
        t = text("%s/r%d/%s/FINDINGS.md" % (loop, r, reviewer))
        if t is not None: print(json.dumps({"kind": "round", "round": r, "reviewer": reviewer, "text": t}))
for path in sorted(glob.glob(loop + "/scoped/*/FINDINGS.md")):
    print(json.dumps({"kind": "scoped", "scope": path.split("/")[-2], "text": text(path)}))
for repo in ${JSON.stringify(MIGRATED_REPOS)}:
    t = text(home + "/vibe/review-spec/fuzz-coverage/inbox/migrate-%s.md" % repo)
    if t is not None: print(json.dumps({"kind": "migration", "repo": repo, "text": t}))
reports = glob.glob(home + "/lanes/*.REPORT.md")
times = sorted(int(os.path.getmtime(p)) for p in reports)
print(json.dumps({"kind": "lane-reports", "count": len(reports), "oldest": times[0] if times else None, "newest": times[-1] if times else None}))
`

const remote = !selected.has("lane-host") ? [] : execFileSync("ssh", ["-o", "BatchMode=yes", values.host, "python3", "-"], { input: REMOTE, maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" })
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line))

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
const pendingPath = "typescript/tsc/internal/vibelangfuzz/testdata/pending"
const pendingNames = !selected.has("fuzz") ? [] : JSON.parse(gh("api", `repos/smithersai/vibelang/contents/${pendingPath}?ref=${values["pending-ref"]}`)).map((file) => file.name).filter((name) => name.endsWith(".txt"))
const pending = pendingNames.map((name) => ({ name, text: gh("api", "-H", "Accept: application/vnd.github.raw", `repos/smithersai/vibelang/contents/${pendingPath}/${name}?ref=${values["pending-ref"]}`) }))
/** A draft file: local, or `<host>:<path>` read over SSH (read-only) when no local file has that name; never in draft mode. */
const readDrafts = (file) => {
  const remotePath = remoteDraft(file)
  const text = (remotePath !== null
    ? execFileSync("ssh", ["-o", "BatchMode=yes", remotePath[1], "cat", "--", remotePath[2].replace(/^~\//, "")], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    : readFileSync(file, "utf8")).trim()
  if (text.startsWith("[")) return JSON.parse(text)
  if (text.startsWith("{") && !text.includes("\n{")) {
    const value = JSON.parse(text)
    return Array.isArray(value.issues) ? value.issues : [value]
  }
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
}

const draftInputs = drafts.map(({ source, file }) => ({ source, drafts: readDrafts(file) }))
const fuzz = fuzzRecords(pending)
const round = remote.filter((row) => row.kind === "round")
// Filing order: the tree, then the agents' drafts, then the findings, then the queue's work links. Drafts come first so
// they win a title match against a finding of the same thing. A queue entry is work, never an issue.
const queue = queuePlan(remote.filter((row) => row.kind === "queue").map((row) => row.entry))
const replaced = new Set(values["replace-findings"])
// Drafts and findings are parsed unformatted, so validation sees the original text before any clipping.
const unformatted = { unformatted: true }
let draftRows
try {
  draftRows = draftInputs.flatMap(({ source, drafts }) => draftRecords(source, drafts, unformatted))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
const statuses = { open: 0, fixed: 0, nonbug: 0, duplicate: 0, closed: 0 }
for (const row of draftRows) statuses[row.status]++
const skipped = draftRows.filter((row) => row.status !== "open").map(({ key, status, duplicate_of }) => ({
  key, status, ...(duplicate_of === undefined ? {} : { duplicate_of }),
}))
// Discover before deduplication or filtering, so the operator can inspect every draft reference, including
// closed/duplicate drafts and generated tree content. Discover original source fields only: clipping or
// transformation can erase credential context. Derived names get no new authority. This cache is the only
// authority for public references.
const initialNodes = place([]).nodes
const repositoryVerdicts = await confirmRepositories([draftInputs, remote, pending, initialNodes, ...(selected.has("fuzz") ? pending.map(({ name }) => ({ url: `${PENDING_URL}/${name}` })) : [])], {
  privateRepos: namedPrivate, publicRepos: namedPublic, cacheFile: publicCacheFile(), env: process.env,
  targets: [
    ...initialNodes.map((node) => node.repo), ...values.repo,
    ...draftInputs.flatMap(({ drafts }) => drafts.map((draft) => draft?.repo)).filter((repo) => typeof repo === "string"),
  ],
})
const scrubOptions = { privateRepos: namedPrivate, repositoryVerdicts }

// Validate original draft and operator fields before normalization or clipping can hide a rejected reference.
const dropped = []
const rejectedRecords = new WeakMap()
const prepareRecord = (input) => {
  const result = cleanRecord(input, scrubOptions)
  const record = formatRecord(result.ok ? result.record : input)
  // Keep rejected originals in deduplication so a later duplicate cannot replace the first record.
  if (!result.ok) rejectedRecords.set(record, result)
  return record
}
const records = [
  ...draftRows.filter((row) => row.status === "open"),
  ...reviewRoundRecords(round.map((row) => ({ reviewer: row.reviewer, round: row.round, text: row.text })), unformatted),
  ...remote.filter((row) => row.kind === "scoped").flatMap((row) => scopedRecords(row.scope, row.text, unformatted)),
  ...remote.filter((row) => row.kind === "migration" && !replaced.has(row.repo)).flatMap((row) => migrationRecords(row.repo, row.text, unformatted)),
  ...fuzzRecords(pending, unformatted).records,
].map(prepareRecord)
const diagnosticKey = (key) => `record:${createHash("sha256").update(String(key)).digest("hex")}`
const drop = (row, problems) => dropped.push({ type: "dropped", key: diagnosticKey(row.key), kind: row.kind, problems })

// Deduplicate by key, then by normalized title within a repository (an agent's draft and an imported finding of the
// same thing): the first wins, and the later's key is noted in its body.
const byKey = new Map()
const duplicates = []
for (const record of records) {
  if (byKey.has(record.key)) duplicates.push({ key: record.key, of: record.key })
  else byKey.set(record.key, record)
}
const byTitle = new Map()
const unique = []
for (const record of byKey.values()) {
  const title = `${record.repo}\n${record.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`
  const first = byTitle.get(title)
  if (first !== undefined) {
    duplicates.push({ key: record.key, of: first.key })
    continue
  }
  byTitle.set(title, record)
  unique.push(record)
}

const clean = []
for (const record of unique) {
  const result = rejectedRecords.get(record) ?? cleanRecord(record, scrubOptions)
  if (result.ok) clean.push(result.record)
  else drop(record, result.problems)
}
const queueLinks = []
for (const row of queue.links) {
  const result = cleanRecord(row, scrubOptions)
  if (result.ok) queueLinks.push({ type: "queue-link", ...row, link: result.record.link })
  else drop(row, result.problems)
}
const placed = place(clean, fuzz.areas)
const nodes = new Map()
for (const node of placed.nodes) {
  const result = cleanRecord(node, scrubOptions)
  if (result.ok) nodes.set(node.key, result.record)
  else drop(node, result.problems)
}
// A denied node cannot leave children pointing at an absent parent. The resulting plan is deliberately
// unfileable if the root itself was denied; the private report still explains every verdict.
let removed
do {
  removed = false
  for (const [key, node] of nodes) {
    if (node.parent !== undefined && !nodes.has(node.parent)) {
      drop(node, [{ field: "parent", rules: ["private-repo"] }])
      nodes.delete(key)
      removed = true
    }
  }
} while (removed)
const tree = {
  nodes: [...nodes.values()],
  records: placed.records.filter((row) => {
    if (nodes.has(row.parent)) return true
    drop(row, [{ field: "parent", rules: ["private-repo"] }])
    return false
  }),
}
const count = (rows, of) => rows.reduce((acc, row) => ({ ...acc, [of(row)]: (acc[of(row)] ?? 0) + 1 }), {})
const reports = remote.find((row) => row.kind === "lane-reports")
const summary = {
  type: "summary",
  at: new Date().toISOString(),
  repositories: [...repositoryVerdicts.values()],
  repositoryRequests: repositoryVerdicts.requests,
  anonymousRepositoryRequests: repositoryVerdicts.anonymousRequests,
  authenticatedRepositoryRequests: repositoryVerdicts.authenticatedRequests,
  unconfirmedRepositories: [...repositoryVerdicts.values()].filter((entry) => entry.verdict === "unconfirmed").map((entry) => entry.repo),
  nodes: tree.nodes.length,
  issues: tree.records.length,
  statuses,
  planned: statuses.open,
  byKind: count(tree.records, (row) => row.kind),
  bySource: count(tree.records, (row) => (row.kind === "draft" ? `draft:${row.source}` : row.kind)),
  queueLinks: queueLinks.length,
  queueUnlinked: queue.unlinked.length,
  trackingDraftsAsNodes: tree.nodes.filter((node) => node.draft !== undefined).map((node) => node.key),
  replacedFindings: [...replaced],
  byRepo: count([...tree.nodes, ...tree.records], (row) => row.repo),
  byParent: count(tree.records, (row) => row.parent),
  maxDepth: Math.max(0, ...tree.records.map((row) => row.depth), ...tree.nodes.map((row) => row.depth)),
  crossRepoChildren: tree.records.filter((row) => row.repo !== "smithersai/vibelang").length,
  duplicates: duplicates.length,
  dropped: dropped.length,
  droppedByKind: count(dropped, (row) => row.kind),
  droppedByRule: count(dropped.flatMap((row) => row.problems.flatMap((p) => p.rules)), (rule) => rule),
  droppedByField: count(dropped.flatMap((row) => row.problems.map((p) => p.field.replace(/\[\d+\]/, "[]"))), (field) => field),
  laneReports: reports === undefined ? null : { count: reports.count, oldest: reports.oldest && new Date(reports.oldest * 1000).toISOString(), newest: reports.newest && new Date(reports.newest * 1000).toISOString(), imported: 0 },
  sources: [...(drafts.length === 0 ? [] : ["drafts"]), ...selected],
  fuzzSource: selected.has("fuzz") ? `smithersai/vibelang@${values["pending-ref"]}:${pendingPath} (${pending.length} areas)` : null,
}
const out = resolve(values.out)
mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
const rows = [
  // Markers are generated only after all source content is checked, from already-validated exact fields.
  // Their paragraph boundary must not be mistaken for a control character inside a source URL.
  ...tree.nodes.map((node) => ({ type: "node", ...node, ...(node.draft === undefined ? {} : { status: "open" }), labels: node.labels ?? ["tree"],
    about: node.draft === undefined ? node.about : bodyWithMarker(node.about, markerOf({ key: node.draft, labels: node.labels })) })),
  ...tree.records.map((record) => ({ type: "issue", ...record, body: bodyWithMarker(record.body, markerOf(record)) })),
  ...queueLinks,
  ...dropped,
  ...duplicates.map((row) => ({ type: "duplicate", key: diagnosticKey(row.key), of: diagnosticKey(row.of) })),
  summary,
]
const skippedOut = `${out}.skipped.jsonl`
writeFileSync(skippedOut, skipped.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 })
chmodSync(skippedOut, 0o600)
const reposOut = `${out}.repos.json`
// Tighten existing reports before writing private names, as well as creating new ones with mode 600.
if (existsSync(reposOut)) chmodSync(reposOut, 0o600)
writeFileSync(reposOut, JSON.stringify(summary.repositories, null, 2) + "\n", { mode: 0o600 })
chmodSync(reposOut, 0o600)
const queueOut = out.replace(/(\.jsonl)?$/, ".queue-unlinked.jsonl")
const unlinkedDiagnostics = queue.unlinked.map((row) => {
  const result = cleanRecord(row, scrubOptions)
  return result.ok ? result.record : { id: diagnosticKey(row.id), problems: result.problems }
})
writeFileSync(queueOut, unlinkedDiagnostics.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 })
chmodSync(queueOut, 0o600)
writeFileSync(out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 })
chmodSync(out, 0o600)
console.log(JSON.stringify({ out, ...summary }, null, 2))
