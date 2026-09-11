/*
 * Regenerates the bundled practice repository the onboarding tutorial reads
 * (apps/app/src/mainview/state/practice/hello-server/*.json). Never hand-edit
 * those files: run `bun scripts/record-practice-hello-server.ts` from apps/app.
 *
 * What is real: every file, every seed commit, the three fix commits and the
 * four picks' rebases are made by git in a throwaway clone with fixed authors
 * and dates, so every commit id is reproducible byte for byte. The run
 * journal is scripted from those real commits; recording a live agent run of
 * the `tutorial-change` flow needs its host binding (TUTORIAL2_INTEGRATION.md,
 * "Remaining defects"), and until then the journal is labelled `scripted`.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"

const OUT = join(import.meta.dir, "..", "src", "mainview", "state", "practice", "hello-server")
const REPO = "smithersai/hello-server"
const BRANCH = "smithers/fix-hello-3"

const people = {
  ada: { name: "Ada Park", email: "ada@example.com" },
  mira: { name: "Mira Chen", email: "mira@example.com" },
  jonas: { name: "Jonas Weber", email: "jonas@example.com" },
  smithers: { name: "Smithers", email: "smithers@smithers.sh" },
} as const
type Person = keyof typeof people

const dir = mkdtempSync(join(tmpdir(), "hello-server-"))
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", TZ: "UTC" }
const git = (args: string[], extra: Record<string, string> = {}) =>
  execFileSync("git", args, { cwd: dir, env: { ...env, ...extra }, encoding: "utf8" }).trim()
const write = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text) }
const read = (path: string) => readFileSync(join(dir, path), "utf8")
const stamp = (who: Person, date: string) => ({
  GIT_AUTHOR_NAME: people[who].name, GIT_AUTHOR_EMAIL: people[who].email, GIT_AUTHOR_DATE: date,
  GIT_COMMITTER_NAME: people[who].name, GIT_COMMITTER_EMAIL: people[who].email, GIT_COMMITTER_DATE: date,
})
/* SCRIPT.md: every commit passes `npm test` by itself (Node strips the TypeScript types natively). */
const passes = (label: string) => {
  try { execFileSync("node", ["--test"], { cwd: dir, env, stdio: "pipe" }) } catch { throw new Error(`npm test fails at ${label}`) }
}
const commit = (who: Person, date: string, message: string) => {
  git(["add", "-A"])
  git(["commit", "-q", "--no-gpg-sign", "-m", message], stamp(who, date))
  return git(["rev-parse", "HEAD"])
}
/** A jj-style change id: stable across a rebase because it derives from the change, not the commit. */
const changeIdOf = (message: string) =>
  [...createHash("sha1").update(`hello-server:${message}`).digest()].slice(0, 8).map(byte => "klmnopqrstuvwxyz"[byte % 16]).join("")
const numstat = (sha: string) => git(["show", "--numstat", "--format=", sha]).split("\n").filter(Boolean).map(line => {
  const [add, del, path] = line.split("\t")
  return { path: path!, additions: Number(add), deletions: Number(del) }
})

git(["init", "-q", "-b", "main"])

/* The seeded history (SCRIPT.md section 2): a deliberately messy middle. */
const history: Array<{ commitId: string; message: string; author: string; date: string }> = []
const seed = (who: Person, date: string, message: string) => history.push({ commitId: commit(who, date, message), message, author: people[who].name, date })

write("package.json", `{"name":"hello-server","type":"module","scripts":{"start":"node src/server.ts","test":"node --test"}}\n`)
write("README.md", "# hello-server\nPractice repository for the Smithers tutorial.\n")
seed("ada", "2026-08-03T10:00:00Z", "Initial commit")
write("src/server.ts", `import { createServer } from "node:http"

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname === "/health") {
    res.end("ok")
  } else {
    res.statusCode = 404
    res.end("not found")
  }
})

server.listen(3000)
`)
seed("ada", "2026-08-04T10:00:00Z", "Add HTTP server with /health")
write("README.md", "# hello-server\nPractice repository for the Smithers tutorial.\nRun `npm start` to serve on port 3000.\nRun `npm test` to run the tests.\n")
seed("mira", "2026-08-05T10:00:00Z", "Document how to run the server (closes #1)")
write("src/hello.ts", "export function greet(name: string | null): string {\n  return `Helo, ${name}!`\n}\n")
seed("jonas", "2026-08-06T10:00:00Z", "wip hello")
write("src/server.ts", `import { createServer } from "node:http"
import { greet } from "./hello.ts"

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname === "/health") {
    res.end("ok")
  } else if (url.pathname === "/hello") {
    res.end(greet(url.searchParams.get("name")))
  } else {
    res.statusCode = 404
    res.end("not found")
  }
})

server.listen(3000)
`)
seed("jonas", "2026-08-06T15:00:00Z", "Add /hello greeting")
write("src/hello.ts", "export function greet(name: string | null): string {\n  return `Hello, ${name}!`\n}\n")
seed("mira", "2026-08-07T10:00:00Z", "fix typo")
write("src/hello.test.ts", `import { test } from "node:test"
import assert from "node:assert/strict"
import { greet } from "./hello.ts"

test("greets by name", () => assert.equal(greet("Ada"), "Hello, Ada!"))
`)
seed("ada", "2026-08-08T10:00:00Z", "Add test for greet")
write(".github/workflows/test.yml", `name: test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
`)
seed("ada", "2026-08-09T10:00:00Z", "Run tests on pushes")

const base = git(["rev-parse", "HEAD"])
const baseTree = git(["rev-parse", "HEAD^{tree}"])
const files = Object.fromEntries(git(["ls-files"]).split("\n").map(path => [path, read(path)]))

/* Mira's open pull request #4, on its own branch. */
git(["checkout", "-q", "-b", "mira/request-logging"])
write("src/server.ts", read("src/server.ts").replace(`  const url = new URL(req.url ?? "/", "http://localhost")\n`, `  const url = new URL(req.url ?? "/", "http://localhost")\n  console.log(req.method, url.pathname)\n`))
const miraCommit = commit("mira", "2026-08-12T10:00:00Z", "Add request logging")
git(["checkout", "-q", "main"])

/* The fix: three small commits, bottom to top, the optional one at the bottom. */
git(["checkout", "-q", "-b", BRANCH])
const fixes = [
  { tag: "optional", hint: "Docs could ship separately.", locked: false, message: "Document the /hello default in README",
    intent: "Tell readers what /hello answers without a name.", apply: () => write("README.md", read("README.md") + "\n`GET /hello` without a name replies `Hello, world!`.\n") },
  { tag: "required", hint: "The fix for #3", locked: true, message: `Default greet() name to "world"`,
    intent: "Line 2 prints null when the name is missing; default it to world.", apply: () => write("src/hello.ts", read("src/hello.ts").replace("`Hello, ${name}!`", '`Hello, ${name || "world"}!`')) },
  { tag: "recommended", hint: "Keeps #3 from coming back.", locked: false, message: "Test /hello without a name",
    intent: "Pin the default with a test that failed on the old code.", apply: () => write("src/hello.test.ts", read("src/hello.test.ts") + `\ntest("greets the world when no name is given", () => {\n  assert.equal(greet(null), "Hello, world!")\n})\n`) },
] as const
const commits = fixes.map((fix, index) => {
  fix.apply()
  const commitId = commit("smithers", `2026-09-10T12:0${index}:00Z`, fix.message)
  passes(fix.message)
  const stat = numstat(commitId)
  return { index: index + 1, commitId, changeId: changeIdOf(fix.message), message: fix.message, intent: fix.intent,
    tag: fix.tag, hint: fix.hint, locked: fix.locked, files: stat.map(row => row.path),
    additions: stat.reduce((sum, row) => sum + row.additions, 0), deletions: stat.reduce((sum, row) => sum + row.deletions, 0) }
})
git(["checkout", "-q", "main"])

/* The four picks. A pick that keeps commit 1 is already in order; any other is rebased onto main by real cherry-picks. */
const picks = [[2, 3], [1, 2, 3], [1, 2], [2]] as const
const stacks = picks.map(pick => {
  const inOrder = pick[0] === 1
  let rows
  if (inOrder) {
    rows = pick.map(index => ({ ...rowOf(commits[index - 1]!), commitId: commits[index - 1]!.commitId }))
  } else {
    git(["checkout", "-q", "--detach", base])
    rows = pick.map((index, position) => {
      const original = commits[index - 1]!
      git(["cherry-pick", "--allow-empty", "--keep-redundant-commits", original.commitId], stamp("smithers", `2026-09-10T12:1${position}:00Z`))
      const to = git(["rev-parse", "HEAD"])
      passes(`${original.message} rebased onto main`)
      return { ...rowOf(original), commitId: to, rebased: { from: original.commitId, to } }
    })
    git(["checkout", "-q", "main"])
  }
  const rebased = rows.filter(row => "rebased" in row).length
  return {
    pick: [...pick], landingNumber: 1, targetBookmark: "main", branch: BRANCH, rows,
    line: rebased === 0 ? `Already in order. Change #1 is a stack of ${rows.length}.`
      : `Rebased ${rebased} ${rebased === 1 ? "commit" : "commits"} onto main. Change #1 is ready for review.`,
  }
})
function rowOf(commit: typeof commits[number]) {
  return { index: commit.index, changeId: commit.changeId, message: commit.message, additions: commit.additions, deletions: commit.deletions }
}

/* GitHub-like people: a login and an avatar. Avatars are generated SVG data: URIs, so the offline practice beats fetch nothing. */
const loginOf = { ada: "adapark", mira: "mirachen", jonas: "jonasweber", smithers: "smithers" } as const
const avatarOf = (who: Person) => {
  const hue = [...createHash("sha1").update(loginOf[who]).digest()].slice(0, 2).reduce((sum, byte) => sum * 256 + byte, 0) % 360
  const initials = people[who].name.split(" ").map((part) => part[0]).join("").slice(0, 2)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="hsl(${hue} 55% 42%)"/><text x="20" y="25" font-family="system-ui,sans-serif" font-size="15" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
}
const person = (who: Person) => ({ login: loginOf[who], avatar: avatarOf(who) })
const authored = (who: Person) => ({ author: people[who].name, authorLogin: loginOf[who], authorAvatar: avatarOf(who) })
/* GitHub's default label colors. */
const LABEL_COLORS: Record<string, string> = { "bug": "d73a4a", "good first issue": "7057ff", "enhancement": "a2eeef", "documentation": "0075ca" }
const colorsOf = (labels: ReadonlyArray<string>) => Object.fromEntries(labels.map((label) => [label, LABEL_COLORS[label] ?? "ededed"]))

const issue3Body = [
  "### Steps",
  "",
  "1. `npm start`",
  "2. `curl localhost:3000/hello`",
  "",
  "```",
  "Expected: Hello, world!",
  "Actual:   Hello, null!",
  "```",
  "",
  "`/hello?name=Ada` works fine.",
].join("\n")
const issues = [
  { number: 3, title: `GET /hello without a name replies "Hello, null!"`, state: "open", ...authored("jonas"),
    labels: ["bug", "good first issue"], labelColors: colorsOf(["bug", "good first issue"]), assignees: [],
    createdAt: "2026-08-19T16:42:00Z", updatedAt: "2026-08-20T09:00:00Z", body: issue3Body,
    comments: [{ ...authored("mira"), createdAt: "2026-08-20T09:00:00Z",
      body: "Reproduced on `main`. `/hello?name=` prints `Hello, !` too, so an empty name should get the default as well." }] },
  { number: 2, title: "Add a /time endpoint", state: "open", ...authored("ada"),
    labels: ["enhancement"], labelColors: colorsOf(["enhancement"]), assignees: [person("ada")],
    createdAt: "2026-08-15T09:00:00Z", updatedAt: "2026-08-15T09:00:00Z",
    body: "Return the server time as ISO 8601 so the status page can show it.\n\n```\nGET /time\n2026-08-15T09:00:00.000Z\n```", comments: [] },
  { number: 1, title: "Document how to run the server", state: "closed", ...authored("ada"),
    labels: ["documentation"], labelColors: colorsOf(["documentation"]), assignees: [person("mira")],
    createdAt: "2026-08-04T12:00:00Z", updatedAt: "2026-08-05T10:00:00Z",
    body: "The README should say how to start the server and how to run the tests.",
    comments: [{ ...authored("mira"), createdAt: "2026-08-05T10:00:00Z", body: "Done in the README (closed by the commit that documents it)." }] },
]
const miraStat = numstat(miraCommit)
/* A GitHub-like per-file patch: the unified hunks only, as the pulls API's `patch` field carries them. */
const patchOf = (sha: string, path: string) => git(["show", "--format=", "-p", sha, "--", path]).split("\n").slice(4).join("\n")
const prs = [{ number: 4, title: "Add request logging", state: "open", draft: false, ...authored("mira"),
  branch: "mira/request-logging", baseBranch: "main", commitId: miraCommit, files: miraStat.map((row) => row.path),
  commits: [{ changeId: changeIdOf("Add request logging"), commitId: miraCommit, message: "Add request logging", author: people.mira.name, timestamp: "2026-08-12T10:00:00Z" }],
  filesDetail: miraStat.map((row) => ({ path: row.path, status: "modified", additions: row.additions, deletions: row.deletions, patch: patchOf(miraCommit, row.path) })),
  additions: miraStat.reduce((sum, row) => sum + row.additions, 0), deletions: miraStat.reduce((sum, row) => sum + row.deletions, 0),
  labels: ["enhancement"], labelColors: colorsOf(["enhancement"]), comments: 1, reviewsRequested: 1,
  reviewers: [person("ada")], assignees: [person("mira")],
  createdAt: "2026-08-12T10:00:00Z", updatedAt: "2026-08-12T10:00:00Z",
  body: "Logs each request's method and path, so we can see what the status page calls.\n\n```\nGET /health\nGET /hello\n```" }]

const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
const plan = {
  prompt: "Fix #3",
  memoryRevision: `practice:${base}`,
  base: { changeId: changeIdOf("base"), commitId: base, treeId: baseTree, operationId: "practice-recording", parentCommitIds: [history[history.length - 2]!.commitId] },
  changes: [{
    id: "fix-hello-3", title: "Fix /hello without a name (#3)",
    intent: "GET /hello with no name replies Hello, null!; reply Hello, world! instead.",
    implementation: "Write the failing test, default the name on line 2 of src/hello.ts, then document it.",
    implementationDigest: digest(commits.map(commit => commit.commitId)),
    atoms: commits.map(commit => ({ changeId: null, message: commit.message, intent: commit.intent, reads: ["src/hello.ts"], writes: commit.files })),
    checks: [
      { id: "npm-test", target: "npm test", flow: "checks/run", flowDigest: digest("npm test"), tier: "fast", required: true },
      { id: "checks", target: ".github/workflows/test.yml", flow: "checks/github", flowDigest: digest("test.yml"), tier: "slow", required: true },
    ],
  }],
}

/* The scripted journal, shaped like the run-events projection the trace folds (cards/RunTrace.ts). */
let sequence = 0
const at = (ms: number) => 1_757_505_600_000 + ms
const events: Array<Record<string, unknown>> = []
const record = (ms: number, kind: string, payload: Record<string, unknown>) => events.push({ sequence: ++sequence, kind, payload, occurredAt: at(ms) })
const oldHello = files["src/hello.ts"]!
record(0, "control.agent.turn-opened", {})
record(400, "control.agent.model-settled", { text: "Write the test first, so the bug shows up as a failure." })
record(500, "control.agent.cell-produced", { language: "ts", text: `await ctx.call("edit", { path: "src/hello.test.ts", append: TEST })\nawait ctx.call("test", { target: "npm test" })` })
record(600, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/hello.test.ts" } })
record(900, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "src/hello.test.ts +4" })
record(1000, "control.agent.cell-call-started", { flowName: "test", input: { target: "npm test" } })
record(2600, "control.agent.cell-call-settled", { flowName: "test", outcome: "failure", message: "✖ greets the world when no name is given\n  expected 'Hello, world!'\n  actual   'Hello, null!'" })
record(2700, "control.agent.cell-settled", { outcome: "success" })
record(3400, "control.agent.turn-opened", {})
record(3800, "control.agent.model-settled", { text: `Edit src/hello.ts: default a missing name to "world" on line 2.` })
record(3900, "control.agent.cell-produced", { language: "ts", text: `const file = await ctx.call("files.read", { path: "src/hello.ts" })\nawait ctx.call("edit", { path: "src/hello.ts", line: 2, text: 'return \`Hello, \${name || "world"}!\`' })\nawait ctx.call("test", { target: "npm test" })` })
record(4000, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "src/hello.ts" } })
record(4200, "control.agent.cell-call-settled", { flowName: "files.read", outcome: "success", value: oldHello })
record(4300, "control.agent.cell-call-started", { flowName: "edit", input: { path: "src/hello.ts", line: 2 } })
record(4600, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "src/hello.ts −1 +1" })
record(4700, "control.agent.cell-call-started", { flowName: "test", input: { target: "npm test" } })
record(6200, "control.agent.cell-call-settled", { flowName: "test", outcome: "success", value: "✔ greets by name\n✔ greets the world when no name is given\n2 tests pass" })
record(6300, "control.agent.cell-settled", { outcome: "success" })
record(7000, "control.agent.turn-opened", {})
record(7300, "control.agent.model-settled", { text: "Document the default in the README." })
record(7400, "control.agent.cell-produced", { language: "ts", text: `await ctx.call("edit", { path: "README.md", append: NOTE })` })
record(7500, "control.agent.cell-call-started", { flowName: "edit", input: { path: "README.md" } })
record(7800, "control.agent.cell-call-settled", { flowName: "edit", outcome: "success", value: "README.md +2" })
record(7900, "control.agent.cell-settled", { outcome: "success" })
record(8400, "control.agent.turn-opened", {})
record(8700, "control.agent.model-settled", { text: "Split the work into three commits, ordered for review." })
record(8800, "control.agent.cell-produced", { language: "ts", text: commits.map(commit => `await ctx.call("commit", { message: ${JSON.stringify(commit.message)} })`).join("\n") })
for (const [index, commit] of commits.entries()) {
  record(8900 + index * 200, "control.agent.cell-call-started", { flowName: "commit", input: { message: commit.message } })
  record(9000 + index * 200, "control.agent.cell-call-settled", { flowName: "commit", outcome: "success", value: `${commit.changeId} ${commit.commitId.slice(0, 12)}` })
}
record(9500, "control.agent.cell-settled", { outcome: "success" })
record(9600, "control.agent.resolved", { text: `3 commits on ${BRANCH}` })
const journal = {
  source: "scripted",
  runId: "practice-fix-hello-3",
  editFrame: "frame-2",
  result: `3 commits on ${BRANCH}`,
  steps: [
    { at: 0, text: "Writing the test…" },
    { at: 2600, text: "Fails on the old code: Hello, null! (expected)" },
    { at: 3400, text: "Fixing line 2…" },
    { at: 6200, text: "2 tests pass" },
    { at: 7000, text: "Documenting…" },
    { at: 9600, text: `3 commits on ${BRANCH}` },
  ],
  events,
}

/*
 * Every commit on main and on the fix branch, GitHub-style, for the commits
 * views (state/seams/CommitsSeam.ts PracticeCommits): author, time, parents,
 * the full message, and per-file change type, counts and unified patch.
 */
const whoByEmail = Object.fromEntries((Object.keys(people) as Array<Person>).map((who) => [people[who].email, who]))
const CHANGE_TYPES: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed" }
const detailOf = (sha: string) => {
  const [name = "", email = "", authoredAt = "", parentLine = "", ...body] = git(["show", "-s", "--format=%an%n%ae%n%aI%n%P%n%B", sha]).split("\n")
  const message = body.join("\n").trim()
  const who = whoByEmail[email] as Person | undefined
  const stat = numstat(sha)
  const kinds = Object.fromEntries(git(["show", "--format=", "--name-status", sha]).split("\n").filter(Boolean).map((line) => {
    const [kind = "M", path = ""] = line.split("\t"); return [path, CHANGE_TYPES[kind[0]!] ?? "modified"]
  }))
  return {
    commitId: sha, changeId: changeIdOf(message.split("\n")[0]!), title: message.split("\n")[0]!, message,
    author: { name, email, ...(who === undefined ? {} : { login: loginOf[who], avatarUrl: avatarOf(who) }) },
    authoredAt: new Date(authoredAt).toISOString(),
    parents: parentLine.split(" ").filter(Boolean).map((parent) => ({ commitId: parent })),
    files: stat.map((row) => ({ path: row.path, changeType: kinds[row.path] ?? "modified", isBinary: false,
      additions: row.additions, deletions: row.deletions, patch: git(["show", "--format=", "-p", sha, "--", row.path]).split("\n").slice(4).join("\n") })),
  }
}
const branchCommits = Object.fromEntries(["main", BRANCH].map((branch) => [branch, git(["log", "--format=%H", branch]).split("\n").filter(Boolean)]))
const details = Object.fromEntries([...new Set(Object.values(branchCommits).flat())].map((sha) => [sha, detailOf(sha)]))
for (const detail of Object.values(details)) {
  for (const parent of detail.parents) (parent as { changeId?: string }).changeId = details[parent.commitId]?.changeId
}

const snapshot = { repo: REPO, branch: "main", base: { commitId: base, treeId: baseTree }, history, files }
const put = (name: string, value: unknown) => { mkdirSync(dirname(join(OUT, name)), { recursive: true }); writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`) }
put("snapshot.json", snapshot)
put("issues.json", issues)
put("prs.json", prs)
put("plan.json", plan)
put("commits.json", { base: { commitId: base }, branch: BRANCH, commits, branches: branchCommits, details })
put("run.journal.json", journal)
for (const stack of stacks) put(`stacks/${stack.pick.join("-")}.json`, stack)
rmSync(dir, { recursive: true, force: true })
console.log(`base ${base}\n${commits.map(commit => `${commit.index} ${commit.commitId} ${commit.message}`).join("\n")}`)
