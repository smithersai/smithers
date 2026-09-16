import type { RepositoryEvent } from "../RepositoryNotifications";
import { isPracticeRepo,practiceIssueList,practicePrList } from "../practice/PracticeRepository";
import type { SeamContext } from "./SeamContext";

type Section = { events: RepositoryEvent[]; problems: string[]; available: boolean }
export interface RepositoryUpdateSnapshot { issues: Section; prs: Section; notifications: Section; branch?: string }
const record = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null
const str = (v: unknown): string | null => typeof v === "string" ? v : null

/** Pull every advertised page; a bound or bad page is visible, never an empty-success claim. */
async function pages(ctx: SeamContext, path: string): Promise<{ rows: unknown[]; problems: string[]; available: boolean }> {
  const rows: unknown[] = []
  for (let page = 1; page <= 10; page++) {
    const url = `${ctx.baseUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100&limit=100&page=${page}`
    try {
      const response = await ctx.http(url)
      if (!response.ok) return { rows, problems: [`Could not load ${path.includes("notifications") ? "notifications" : "repository activity"} (${response.status}).`], available: rows.length > 0 }
      const body: unknown = await response.json()
      if (!Array.isArray(body)) return { rows, problems: ["Repository activity returned an unreadable response."], available: rows.length > 0 }
      rows.push(...body)
      if (!response.headers.get("link")?.includes('rel="next"') && body.length < 100) return { rows, problems: [], available: true }
    } catch { return { rows, problems: ["Repository activity could not be reached."], available: rows.length > 0 } }
  }
  return { rows, problems: ["This update is partial: additional activity pages remain."], available: true }
}
const activity = (raw: unknown, source: string, kind: "issue" | "pr"): RepositoryEvent | undefined => {
  if (!record(raw) || !Number.isInteger(raw.number) || typeof raw.title !== "string" || typeof raw.state !== "string") return
  return { source, sourceId: String(raw.number), kind, number: raw.number, title: raw.title, state: raw.state,
    updatedAt: str(raw.updated_at) ?? str(raw.updatedAt), tags: [kind, raw.state, ...(Array.isArray(raw.labels) ? raw.labels.flatMap((v: unknown) => typeof v === "string" ? [v] : record(v) && typeof v.name === "string" ? [v.name] : []) : [])] }
}
const section = (result: Awaited<ReturnType<typeof pages>>, source: string, kind: "issue" | "pr", keep: (v: unknown) => boolean = () => true): Section => {
  const selected = result.rows.filter(keep)
  const events = selected.flatMap(row => { const parsed = activity(row, source, kind); return parsed ? [parsed] : [] })
  return { events, available: result.available, problems: [...result.problems, ...(events.length !== selected.length ? ["Some activity rows could not be read."] : [])] }
}
export async function readRepositoryUpdate(ctx: SeamContext, repo: string): Promise<RepositoryUpdateSnapshot> {
  if (isPracticeRepo(repo)) return {
    issues: { events: practiceIssueList("all").issues.flatMap(row => { const item = activity(row, "practice", "issue"); return item ? [item] : [] }), problems: [], available: true },
    prs: { events: practicePrList().landings.flatMap(row => { const item = activity(row, "practice", "pr"); return item ? [item] : [] }), problems: [], available: true },
    notifications: { events: [], problems: [], available: true }, branch: "main"
  }
  const path = repo.split("/").map(encodeURIComponent).join("/")
  const results = await Promise.allSettled([
    (async () => {
      const states = await Promise.all([pages(ctx, `/api/repos/${path}/issues?state=open`), pages(ctx, `/api/repos/${path}/issues?state=closed`)])
      return { rows: states.flatMap(state => state.rows), problems: states.flatMap(state => state.problems), available: states.some(state => state.available) }
    })(), pages(ctx, `/api/user/github-repos/${path}/issues?state=all`),
    pages(ctx, `/api/repos/${path}/landings`), pages(ctx, "/api/notifications/list?all=true")
  ])
  const values = results.map(result => result.status === "fulfilled" ? result.value : { rows: [], problems: ["Activity check failed."], available: false })
  const nativeIssues = section(values[0]!, "smithers", "issue")
  const githubIssues = section(values[1]!, "github", "issue", v => record(v) && !v.pull_request)
  const githubPrs = section(values[1]!, "github", "pr", v => record(v) && !!v.pull_request)
  const nativePrs = section(values[2]!, "smithers", "pr")
  const combine = (a: Section, b: Section): Section => ({ events: [...a.events, ...b.events], available: a.available || b.available,
    problems: [...a.problems, ...b.problems] })
  const notifications: Section = { events: [], problems: [...values[3]!.problems], available: values[3]!.available }
  for (const raw of values[3]!.rows) {
    if (!record(raw)) { notifications.problems.push("Some notifications could not be read."); continue }
    const target = typeof raw.repository === "string" ? raw.repository : raw.repository?.full_name ?? raw.repo
    if (target !== repo) continue
    const title = typeof raw.subject === "string" ? raw.subject : raw.subject?.title ?? raw.title
    if ((typeof raw.id !== "string" && typeof raw.id !== "number") || typeof title !== "string") { notifications.problems.push("Some notifications could not be read."); continue }
    notifications.events.push({ source: "github-inbox", sourceId: String(raw.id), kind: "notification", title,
      state: "updated", updatedAt: str(raw.updated_at) ?? str(raw.created_at), read: raw.unread === false || raw.status === "read",
      tags: ["notification", ...(typeof raw.reason === "string" ? [raw.reason] : []), ...(typeof raw.subject?.type === "string" ? [raw.subject.type.toLowerCase()] : [])] })
  }
  return { issues: combine(nativeIssues, githubIssues), prs: combine(nativePrs, githubPrs), notifications }
}
