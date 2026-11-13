/*
 * The fixture API every repo view reads. Several repos have datasets (fixtures/data/<owner>__<name>/), and the route
 * wrapper in repo/routes.tsx calls selectRepo(owner/name) before a page renders, so these exports are live bindings
 * that always name the current repo's data. Read them inside components or functions, never at module top level.
 * Times are relative to the current dataset's MOCK_NOW.
 */
import type { Repo, Person, TreeEntry, FileBlob, BlameRange, Commit, Branch, Tag, Label, Issue, Pull, StackItem, Run, Approval, Flow, Agent, WikiPage, DocPage, Release, Settings, AskSample, Dataset } from "./types"
import { pluralize } from "../ui/pluralize"
import { DATASETS } from "./registry"
import effeckPathAliases from "./data/effeck__effeck/path-aliases.json"

export const KNOWN_REPOS: string[] = Object.keys(DATASETS)

export let MOCK_NOW: string
export let BASE: string
export let repo: Repo
export let people: Person[]
export let tree: TreeEntry[]
export let files: FileBlob[]
let blameRanges: BlameRange[]
export let commits: Commit[]
let omittedCommits: NonNullable<Dataset["omittedCommits"]>
export let branches: Branch[]
export let tags: Tag[]
export let labels: Label[]
export let issues: Issue[]
export let pulls: Pull[]
export let stack: StackItem[]
export let runs: Run[]
export let approvals: Approval[]
export let flows: Flow[]
export let agents: Agent[]
export let wiki: WikiPage[]
export let docs: DocPage[]
export let releases: Release[]
export let settings: Settings
export let askSamples: AskSample[]
let current = ""

const load = (slug: string, data: Dataset) => {
  current = slug
  MOCK_NOW = data.MOCK_NOW
  BASE = `smithers.sh/${slug}`
  repo = data.repo; people = data.people; tree = data.tree; files = data.files; blameRanges = data.blame
  commits = data.commits; omittedCommits = data.omittedCommits ?? []; branches = data.branches; tags = data.tags; labels = data.labels; issues = data.issues
  pulls = data.pulls; stack = data.stack; runs = data.runs; approvals = data.approvals; flows = data.flows
  agents = data.agents; wiki = data.wiki; docs = data.docs; releases = data.releases; settings = data.settings
  askSamples = data.ask
}

/** Point every export at this repo's dataset. Returns false (and keeps the current data) for a repo with none. */
export const selectRepo = (slug: string): boolean => {
  if (slug === current) return true
  const data = DATASETS[slug]
  if (data === undefined) return false
  load(slug, data)
  return true
}

/** The repo the exports name right now, "owner/name". */
export const currentRepo = () => current

load(KNOWN_REPOS[0]!, DATASETS[KNOWN_REPOS[0]!]!)

export const to = (path?: string): string => path ? `${BASE}/${path.replace(/^\/+/, "")}` : BASE

export const person = (login: string): Person => people.find(value => value.login === login) ?? {
  login, name: login, kind: "human", role: "contributor", initials: login.slice(0, 2).toUpperCase()
}
export const children = (dir: string): TreeEntry[] => {
  const parent = dir.replace(/^\/+|\/+$/g, "")
  return tree.filter(entry => entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === parent
    && (entry.kind !== "dir" || tree.some(child => child.kind === "file" && child.path.startsWith(`${entry.path}/`))))
    .sort((a, b) => a.kind === b.kind ? a.path.localeCompare(b.path, "en") : a.kind === "dir" ? -1 : 1)
}
/** Keep existing review URLs and verbatim historical links readable after source renames. */
const sourcePath = (path: string): string => repo.slug === "effeck/effeck"
  ? (effeckPathAliases as Record<string, string>)[path] ?? path : path
export const file = (path: string): FileBlob | undefined => files.find(value => value.path === sourcePath(path))
export const blame = (path: string): BlameRange[] => blameRanges.filter(value => value.path === sourcePath(path)).sort((a, b) => a.start - b.start)
export const commit = (shaOrPrefix: string): Commit | undefined => {
  if (!shaOrPrefix) return undefined
  const matches = commits.filter(value => value.sha.startsWith(shaOrPrefix))
  return matches.length === 1 ? matches[0] : undefined
}
export const branch = (name: string): Branch | undefined => branches.find(value => value.name === name)
export const history = (ref: string, path?: string): Commit[] => {
  const head = branch(ref)?.head ?? tags.find(value => value.name === ref)?.sha ?? commit(ref)?.sha
  if (!head) return []
  const reachable = new Set<string>()
  const visit = [head]
  while (visit.length) {
    const sha = visit.pop()!
    if (reachable.has(sha)) continue
    reachable.add(sha)
    visit.push(...(commit(sha)?.parents ?? omittedCommits.find(value => value.sha === sha)?.parents ?? []))
  }
  return commits.filter(value => reachable.has(value.sha) && (!path || value.files.some(changed => sourcePath(changed.path) === sourcePath(path) || sourcePath(changed.path).startsWith(`${sourcePath(path)}/`) || (changed.from && sourcePath(changed.from) === sourcePath(path)))))
}
export const lastCommitFor = (path: string): Commit | undefined => history(repo.defaultBranch, path)[0]
export const label = (name: string): Label | undefined => labels.find(value => value.name === name)
export const issue = (n: number): Issue | undefined => issues.find(value => value.n === n)
export const pull = (n: number): Pull | undefined => pulls.find(value => value.n === n)
export const run = (id: string): Run | undefined => runs.find(value => value.id === id)
export const approval = (id: string): Approval | undefined => approvals.find(value => value.id === id)
export const flow = (name: string): Flow | undefined => flows.find(value => value.name === name)
export const wikiPage = (slug: string): WikiPage | undefined => wiki.find(value => value.slug === slug)
export const doc = (slug: string): DocPage | undefined => docs.find(value =>
  value.slug === slug || sourcePath(`docs/${value.slug}.md`) === sourcePath(`docs/${slug}.md`))
export const release = (tag: string): Release | undefined => releases.find(value => value.tag === tag)
/* Views name their Ask view by family ("issue", "pull"); samples are keyed by route suffix ("issues/:n"). */
const ASK_ALIASES: Record<string, string> = {
  issue: "issues/:n", pull: "pull/:n", run: "runs/:id", commit: "commit/:sha", commits: "commits/:ref", flow: "flows/:name",
  wiki: "wiki/*", docs: "docs/*", settings: "settings/*", blob: "blob/:ref/*", blame: "blame/:ref/*", tree: "", home: "", code: ""
}
export const askFor = (view: string): AskSample | undefined => {
  const clean = (ASK_ALIASES[view] ?? view).split("?")[0].replace(BASE, "").replace(/^\/+|\/+$/g, "")
  const direct = askSamples.find(value => value.view === clean)
  if (direct) return direct
  const matches = askSamples.filter(value => {
    const pattern = value.view.split("/")
    const parts = clean.split("/")
    return pattern.every((part, i) => part === "*" || (part.startsWith(":") ? Boolean(parts[i]) : part === parts[i]))
  })
  // Pull tabs and run trace routes keep their parent view's question and evidence.
  return matches.sort((a, b) => b.view.split("/").length - a.view.split("/").length)[0]
}
export const fmtAgo = (iso: string): string => {
  const seconds = Math.max(0, Math.floor((Date.parse(MOCK_NOW) - Date.parse(iso)) / 1000))
  if (!Number.isFinite(seconds)) return "Unknown date"
  if (seconds < 60) return "just now"
  const units: Array<[number, string]> = [[60, "minute"], [3600, "hour"], [86400, "day"]]
  if (seconds < 30 * 86400) {
    const [size, unit] = units[seconds < 3600 ? 0 : seconds < 86400 ? 1 : 2]
    const count = Math.floor(seconds / size)
    return `${count} ${pluralize(count, unit)} ago`
  }
  return `on ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`
}
export const fmtDate = (iso: string): string => Number.isFinite(Date.parse(iso))
  ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Unknown date"
export const shortSha = (sha: string): string => sha.slice(0, 7)
