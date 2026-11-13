/*
 * The default repo UI's fixture contract (UI Mock Program, 2026-10-17).
 *
 * Every view under src/sites/repo reads only these shapes. The data lives in plain JSON beside this file, one file per
 * subject (repo.json, tree.json, files.json, commits.json, ...), so the mocks can later move onto the living-mock
 * platform (flows as e2e tests with mocked fixtures) without rewriting views. index.ts loads the JSON and offers
 * lookups; views never import JSON directly.
 *
 * A product site (Smithers, VibeLang, the Effect.ts monorepo) customizes the same UI through RepoConfig, never a fork.
 * Times are ISO 8601 strings in UTC; views format them ("3 hours ago") against MOCK_NOW in index.ts.
 */

/** A person or an agent. Agents are first-class authors: commits, PRs, comments and wiki edits carry them. */
export interface Person {
  login: string
  name: string
  kind: "human" | "agent"
  /** Owner and member may write; contributor is a signed-in outsider; agent acts for a person through a run. */
  role: "owner" | "member" | "contributor" | "agent"
  /** One initial for a person; agents display the bot glyph. */
  initials: string
}

/** Who did something on behalf of whom, when an agent did it. Every agent-made artifact links its run. */
export interface AgentMark {
  run: string
  flow: string
  /** "claude-code" or "codex", with the model, e.g. "Codex · gpt-6.1-sol". */
  harness: string
  /** The person the agent worked for. */
  for: string
}

/* ---------- Repo and customization ---------- */

export type TabId = "code" | "issues" | "pulls" | "runs" | "flows" | "evals" | "wiki" | "docs" | "packages" | "settings"

/**
 * A block of the repo's .smithers/home.json, shown above the README on Code home. Same shape as the real file
 * (see .smithers/home.json in the smithers and effectscript repositories), so engineering builds to it directly.
 * links[].url is an absolute https URL (opens in a new tab) or a smithers.sh route ("smithers.sh/docs", or a path
 * relative to the repo such as "issues?q=is:fixed-by-agents").
 */
export type HomeBlock =
  | { type: "text"; text: string }
  | { type: "prompt"; title: string; placeholder: string; chips?: string[] }
  | { type: "links"; links: Array<{ label: string; url: string }> }
  | { type: "markdown"; path: string; title: string }
  | { type: "app"; flow: string; title: string; picture: "issue" | "review" | "wiki" | "schedule" | string }
  /** Proposed (app-spec M): the Fixed by agents evidence strip for these issues. */
  | { type: "fixed-by-agents"; issues: number[]; compact?: boolean; acceptedOnly?: boolean }

/** One package of a monorepo (stage 4). Absent for a single-package repo. */
export interface PackageInfo extends PackageDetails {
  name: string
  path: string
  description: string
  version: string
  owners: string[]
  docs?: string
}

/** What a product site changes about the default UI. The default repo leaves every field at its default. */
export interface RepoConfig {
  /** Tabs in order; default: code, issues, pulls, runs, flows, wiki, (docs when declared), settings. */
  tabs?: TabId[]
  /** Code home blocks from .smithers/home.json; default none. */
  home?: HomeBlock[]
  /** Rename the Stack (e.g. "Landing queue"); hide Add TODO when items come only from a queue. */
  stack?: { title: string; addTodo?: boolean }
  /** The Docs tab appears only when the repo declares docs (PM ruling 2026-10-17). */
  docs?: { root: string; title: string }
  /** Monorepo packages; turns on package-aware navigation (stage 4). */
  packages?: PackageInfo[]
  /** Monorepo sources: changesets, CI, package flows (stage 4). */
  monorepo?: MonorepoConfig
  /** The Evals tab appears only when the repo declares eval suites (smthrs eval), like Docs. */
  evals?: { title: string }
}

export interface Repo {
  owner: string
  name: string
  /** "maya/tinyhttp" */
  slug: string
  description: string
  visibility: "public" | "private"
  defaultBranch: string
  /** The GitHub repo this one syncs with, or null for a native Smithers repo. */
  github: string | null
  homepage?: string
  license: string
  topics: string[]
  languages: Array<{ name: string; percent: number }>
  /** Counts the header and sidebar show; must agree with the fixture lists. */
  counts: { commits: number; branches: number; tags: number; issuesOpen: number; pullsOpen: number; runsActive: number; contributors: number }
  config: RepoConfig
}

/* ---------- Code ---------- */

export interface TreeEntry {
  /** Full path from the repo root, no leading slash: "src/router.ts". */
  path: string
  kind: "dir" | "file"
  /** Bytes, files only. */
  size?: number
  /** The last commit that touched this path. */
  sha: string
}

export interface Symbol {
  line: number
  name: string
  kind: "function" | "class" | "method" | "type" | "const" | "interface"
  /** The hover card's signature and one-line doc, as code intelligence (code.* flows) shows it. */
  hover: string
  /** Where its definition lives when it is in another file. */
  definition?: { path: string; line: number }
}

export interface Diagnostic { line: number; severity: "error" | "warning" | "info"; message: string; source: string }

export interface FileBlob {
  path: string
  lang: "vibe" | "ts" | "tsx" | "js" | "json" | "md" | "yaml" | "sh" | "txt" | "toml"
  /** Full content. No truncation: the blob view must render every line (fixes A43). */
  content: string
  symbols?: Symbol[]
  diagnostics?: Diagnostic[]
}

/** Contiguous lines last changed by one commit. Ranges for a file cover every line exactly once. */
export interface BlameRange { path: string; start: number; end: number; sha: string }

/* ---------- History ---------- */

export interface DiffLine { kind: "ctx" | "add" | "del" | "hunk"; text: string; old?: number; new?: number }
export interface DiffFile {
  path: string
  /** For renames. */
  from?: string
  status: "added" | "modified" | "deleted" | "renamed"
  additions: number
  deletions: number
  lines: DiffLine[]
}

export type CheckState = "success" | "failure" | "pending" | "skipped"
export interface Check { name: string; state: CheckState; duration?: string; detail: string; run?: string }

export interface Commit {
  sha: string
  /** First line of the message. */
  title: string
  body?: string
  author: string
  /** Present when an agent wrote it; blame and commits mark these and link the run. */
  agent?: AgentMark
  date: string
  parents: string[]
  /** Branches this commit is on. */
  branches: string[]
  /** The pull request or landing that brought it to the default branch. */
  pull?: number
  checks: Check[]
  verified: boolean
  files: DiffFile[]
}

export interface Branch {
  name: string
  head: string
  author: string
  updated: string
  ahead: number
  behind: number
  isDefault?: boolean
  protected?: boolean
  pull?: number
  /** The branch's sandbox ("Run on a sandbox" opens one; box.open). */
  sandbox?: { state: "running" | "suspended"; id: string; since: string; ports?: number[] }
  /** The run working on this branch now, if any. */
  run?: string
}

export interface Tag { name: string; sha: string; date: string; release: boolean }

/* ---------- Issues ---------- */

export interface Label { name: string; tone: "brand" | "warning" | "danger" | "success" | "neutral" | "info"; description: string }

export interface Comment { author: string; date: string; body: string; agent?: AgentMark }

export type TimelineEvent =
  | { kind: "labeled"; actor: string; date: string; label: string }
  | { kind: "assigned"; actor: string; date: string; assignee: string }
  | { kind: "referenced"; actor: string; date: string; sha?: string; pull?: number }
  | { kind: "closed"; actor: string; date: string; reason: "completed" | "not_planned"; sha?: string; pull?: number }
  | { kind: "reopened"; actor: string; date: string }
  | { kind: "todo"; actor: string; date: string; run: string }
  | { kind: "run"; actor: string; date: string; run: string; state: RunState }

/** The "Fixed by agents" evidence strip: Reported → Accepted → Working → In review → Landed, each with its evidence. */
export interface FactoryReceipt {
  reported: { by: string; date: string }
  accepted?: { by: string; date: string }
  working?: { run: string; date: string }
  review?: { pull: number; date: string }
  /** Landed means the commit is on the remote default branch, not merely closed. */
  landed?: { sha: string; date: string }
}

export interface Issue {
  n: number
  title: string
  state: "open" | "closed"
  author: string
  assignees: string[]
  labels: string[]
  milestone?: string
  opened: string
  updated: string
  /** Markdown. */
  body: string
  comments: Comment[]
  events: TimelineEvent[]
  /** A TODO attached to this issue ("Make TODO"); the canonical TODO list is the Stack. */
  todo?: string
  receipt?: FactoryReceipt
  pulls: number[]
}

/* ---------- Pull requests, landings and the stack ---------- */

export type DiffSide = "old" | "new"
export interface ReviewComment { path: string; line: number; side?: DiffSide; author: string; date: string; body: string; agent?: AgentMark; resolved?: boolean }
export interface Review { author: string; date: string; state: "approved" | "changes_requested" | "commented"; body: string; agent?: AgentMark }

export interface Pull {
  n: number
  title: string
  state: "open" | "draft" | "merged" | "closed"
  /** A GitHub pull request (synced repo) or a native Smithers landing request. Both list together. */
  kind: "pull" | "landing"
  author: string
  agent?: AgentMark
  base: string
  head: string
  opened: string
  updated: string
  merged?: { by: string; date: string; sha: string }
  body: string
  reviewers: string[]
  reviews: Review[]
  reviewComments: ReviewComment[]
  comments: Comment[]
  checks: Check[]
  commits: string[]
  files: DiffFile[]
  fixes: number[]
  labels: string[]
}

/** One entry of the team's ordered work (/stack). TODOs and agent changes share one list. */
export interface StackItem {
  id: string
  order: number
  title: string
  state: "queued" | "working" | "needs-answer" | "ready" | "failed" | "merged"
  owner: string
  issue?: number
  pull?: number
  run?: string
  /** Person who approved this queue entry, when recorded. */
  approver?: string
  /** What the agent asks when state is needs-answer. */
  question?: { text: string; options: string[] }
  /** Why it failed, in one sentence, when state is failed. */
  failure?: string
  updated: string
}

/* ---------- Runs, approvals, flows and agents ---------- */

export type RunState = "queued" | "running" | "waiting" | "failed" | "succeeded" | "cancelled"

export interface Stage {
  id: string
  label: string
  state: RunState | "skipped"
  started?: string
  duration?: string
  summary: string
  log: string[]
}

export interface Approval {
  id: string
  run: string
  title: string
  question: string
  askedOf: string
  asked: string
  options: string[]
  state: "waiting" | "approved" | "denied"
  decided?: { by: string; date: string; option: string }
}

export interface TraceEvent { at: string; stage: string; kind: "tool" | "message" | "checkpoint" | "error" | "approval"; text: string }

export interface Run {
  id: string
  flow: string
  title: string
  state: RunState
  trigger: { kind: "issue" | "todo" | "manual" | "schedule" | "push" | "pull"; by: string; ref?: string }
  /** The harness and model, e.g. "Claude Code · claude-opus-5-5". */
  harness: string
  started: string
  finished?: string
  duration: string
  cost: { usd: number; tokens: number }
  branch?: string
  issue?: number
  pull?: number
  stages: Stage[]
  approvals: string[]
  /** Required when state is failed: the stage and one-sentence reason a person can act on. */
  failure?: { stage: string; reason: string }
  trace: TraceEvent[]
  /** Survived a closed tab or a crash: when it resumed and from which checkpoint. */
  resumed?: { at: string; checkpoint: string }
}

export interface Trigger { kind: "issue-label" | "schedule" | "push" | "manual" | "pull"; spec: string; enabled: boolean }

export interface FlowNode { id: string; label: string; kind: "agent" | "check" | "approval" | "step" }

export interface Flow {
  name: string
  /** The flow's source file, e.g. ".smithers/flows/implement-issue.tsx". */
  file: string
  description: string
  inputs: Array<{ name: string; type: string; required: boolean; description: string }>
  triggers: Trigger[]
  roles: Array<{ role: string; agent: string }>
  graph: { nodes: FlowNode[]; edges: Array<[string, string]> }
  /** Run ids, newest first. */
  runs: string[]
}

export interface Agent {
  id: string
  name: string
  harness: "claude-code" | "codex"
  model: string
  /** Which connection pays for it (Settings > Models). */
  connection: "claude" | "codex"
  instructions: string
  flows: string[]
}

/* ---------- Wiki, docs, releases ---------- */

export interface WikiPage {
  slug: string
  title: string
  /** Markdown; links to other pages use [Title](wiki:slug). */
  body: string
  updated: string
  author: string
  revision: number
  provenance: { source: "person" | "run"; run?: string; confidence?: "high" | "medium" | "low" }
  /** Optional revision history for a wiki page's history view, newest first. */
  revisions?: Array<{ n: number; date: string; author: string; summary: string; agent?: AgentMark }>
  /** Learning proposals from runs, waiting for a person to accept. */
  proposals?: Array<{ run: string; date: string; summary: string; diff: string }>
}

export interface DocPage { slug: string; title: string; section: string; body: string }

export interface Release {
  tag: string
  name: string
  date: string
  author: string
  prerelease: boolean
  latest?: boolean
  /** Markdown notes. */
  body: string
  /** The landed changes the notes were generated from. */
  pulls: number[]
}

/* ---------- Settings ---------- */

export interface Settings {
  members: Array<{ login: string; role: "owner" | "member"; added: string }>
  invites: Array<{ login: string; role: "member"; sent: string }>
  secrets: Array<{ name: string; updated: string; usedBy: string[] }>
  /** Model connections: a Claude or Codex subscription pays for agent work. */
  models: Array<{ provider: "claude" | "codex"; state: "connected" | "none"; account?: string; plan?: string; connected?: string }>
  environment: Array<{ name: string; image: string; updated: string; size: string; isDefault?: boolean }>
  sandboxes: { egress: "allowlist" | "open" | "none"; allow: string[]; services: string[]; maxRunning: number; idleSuspendMinutes: number }
  webhooks: Array<{ url: string; events: string[]; lastDelivery: { date: string; status: number } }>
  sync: { github: { state: "ok" | "stale" | "error"; lastSync: string; app: string; detail?: string } }
  /** Who may file reports from the app (bug.report). */
  reporting: "off" | "signed-in"
}

/* ---------- Ask (the docked composer) ---------- */

/** A sample exchange the Ask panel shows for a view; context names what the composer already knows. */
export interface AskSample {
  /** The route pattern suffix this sample belongs to, e.g. "issues/:n" or "" for Code home. */
  view: string
  context: string
  question: string
  /** Markdown answer; cards are embedded views the answer carries (the agent's door renders embedded). */
  answer: string
  cards?: Array<{ kind: "file" | "issue" | "pull" | "run" | "commit" | "flow"; ref: string }>
}

/* ---------- Monorepo (stage 4; optional, additive) ---------- */

/** Extra package facts a monorepo declares (stage 4). All optional, so single-package repos stay valid. */
export interface PackageDetails {
  /** URL slug, e.g. "sql-pg" for @effect/sql-pg. */
  slug?: string
  /** Directory group: "ai", "atom", "platform", "sql", "tools" or "" for top-level packages. */
  family?: string
  private?: boolean
  readme?: string
  changelog?: string
  dependencies?: Array<{ name: string; kind: "runtime" | "peer" | "dev" | "optional" }>
}

/** Monorepo configuration (stage 4): where changesets, CI and package flows come from. */
export interface MonorepoConfig {
  workspace?: string
  sharedPaths?: string[]
  changesets?: { directory?: string; config?: string; prerelease?: string }
  ci?: { workflows?: string[]; projects?: string }
  flows?: { implement?: string; release?: string }
}

/* ---------- One repo's whole dataset ---------- */

/** Everything one repo's fixture folder (fixtures/data/<owner>__<name>/) exports as `dataset`. */
export interface Dataset {
  MOCK_NOW: string
  repo: Repo
  people: Person[]
  tree: TreeEntry[]
  files: FileBlob[]
  blame: BlameRange[]
  commits: Commit[]
  /** Commits a fixture leaves out because a quoted message breaks a publication rule.
   *  Only their real identity and parents remain, so history walks through them. */
  omittedCommits?: Array<{ sha: string; parents: string[] }>
  branches: Branch[]
  tags: Tag[]
  labels: Label[]
  issues: Issue[]
  pulls: Pull[]
  stack: StackItem[]
  runs: Run[]
  approvals: Approval[]
  flows: Flow[]
  agents: Agent[]
  wiki: WikiPage[]
  docs: DocPage[]
  releases: Release[]
  settings: Settings
  ask: AskSample[]
  /** Eval suites (smthrs eval), when config.evals is set. */
  evals?: EvalSuite[]
}

/* ---------- Evals (smthrs eval; a declared tab like Docs) ---------- */

export interface EvalCase { id: string; title: string; score: number; baseline: number; passed: boolean; detail?: string; input?: string; expected?: string; actual?: string | null; diagnostics?: string | null; source?: string }

export interface EvalSuite {
  id: string
  title: string
  /** The suite's module, e.g. "evals/swebench/swebench.eval.ts". */
  file: string
  /** "Rubric (LLM judge)", "exact match", "tests pass", ... */
  scorer: string
  /** What passing means, e.g. "16 of 20 compile" or "no regression > 2 points". */
  threshold: string
  latest: { run: string; date: string; score: number; baseline: number; passed: number; total: number; state: "pass" | "regressed" | "inconclusive" }
  history: Array<{ date: string; score: number }>
  cases: EvalCase[]
}
