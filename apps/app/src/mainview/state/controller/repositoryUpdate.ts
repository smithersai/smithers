import { readResult } from "../seams/SeamContext"
import type { SeamContext } from "../seams/SeamContext"
import { readRepositoryUpdate } from "../seams/RepositoryUpdateSource"
import { processRepositoryEvents } from "../RepositoryNotifications"
import { conversationTabIdOf, type Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { isPracticeRepo, PRACTICE_REPO } from "../practice/PracticeRepository"

type UpdateCard = Extract<Card, { kind: "repo-update" }>
export function repositoryUpdateScope(ctx: SeamContext, repo: string): string {
  if (isPracticeRepo(repo)) return `practice:${ctx.store.session().guide?.playthrough ?? 0}`
  const identity = ctx.store.collections.identitySessions.get("identity")
  return identity?.state === "signed-in" ? `github:${identity.login}` : "anonymous"
}
export function createRepositoryUpdate(ctx: SeamContext) {
  const pending = new Map<string, Promise<string | { value: string }>>()
  const updateRepo = async (explicit?: string): Promise<string | { value: string }> => {
    const target = isPracticeRepo(explicit) ? { repo: PRACTICE_REPO } : resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    const scope = repositoryUpdateScope(ctx, repo)
    const session = ctx.store.session()
    const conversation = conversationTabIdOf(session)
    const context = JSON.stringify([scope, conversation, session.activeRepoKey, session.activeWorkspaceId, session.activeBranchId])
    const key = JSON.stringify([scope, repo, conversation])
    const prior = pending.get(key)
    if (prior) return prior
    const work = (async () => {
      const snapshot = await readRepositoryUpdate(ctx, repo)
      const current = ctx.store.session()
      if (JSON.stringify([repositoryUpdateScope(ctx, repo), conversationTabIdOf(current), current.activeRepoKey, current.activeWorkspaceId, current.activeBranchId]) !== context) return "The repository or account changed while its update was loading."
      const at = Date.now()
      const processed = processRepositoryEvents(scope, repo, [...snapshot.issues.events, ...snapshot.prs.events, ...snapshot.notifications.events], [...ctx.store.collections.repositoryNotifications.values()], at)
      const fresh = processed.fresh
      const newIssues = fresh.filter(row => row.kind === "issue")
      const prs = fresh.filter(row => row.kind === "pr")
      const notices = fresh.filter(row => row.kind === "notification")
      const problems = [...new Set([...snapshot.issues.problems, ...snapshot.prs.problems, ...snapshot.notifications.problems])]
      const summary = fresh.length === 0
        ? problems.length ? "Some repository activity could not be checked." : "You're up to date. No new issue or PR updates since my last check."
        : `${newIssues.length} issue ${newIssues.length === 1 ? "update" : "updates"}, ${prs.length} PR ${prs.length === 1 ? "update" : "updates"}${notices.length ? `, and ${notices.length} ${notices.length === 1 ? "notification" : "notifications"}` : ""} since my last check.`
      const id = `repo-update-${encodeURIComponent(key)}`
      const existing = ctx.store.collections.cards.get(id)
      const visible = new Map(fresh.map(row => [row.id, row]))
      // Refreshing does not erase notices the user has yet to read.
      for (const row of processed.rows) if (row.announcedVersion === row.version && row.readVersion !== row.version) visible.set(row.id, row)
      const items = [...visible.values()].map(row => ({ id: row.id, version: row.version, kind: row.kind, number: row.number, title: row.title, state: row.state, tags: row.tags, read: row.readVersion === row.version }))
      const card: UpdateCard = { id, kind: "repo-update", title: `Repository update · ${repo.replace("practice:smithersai/", "")}`,
        status: "active", createdAt: existing?.createdAt ?? at, ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
        payload: { repo, scope, checkedAt: at, summary, items, problems, branch: snapshot.branch,
          openIssues: snapshot.issues.available ? snapshot.issues.events.filter(row => row.state === "open").length : null,
          openPrs: snapshot.prs.available ? snapshot.prs.events.filter(row => row.state === "open").length : null } }
      const announced = new Set(fresh.map(row => row.id))
      await ctx.dispatch({ type: "repo.update.published", actor: ctx.actor(), card,
        notifications: processed.rows.map(row => announced.has(row.id) ? { ...row, announcedVersion: row.version } : row)
      }).isPersisted.promise
      return readResult(`${summary}\n${items.map(row => `${row.kind}${row.number ? ` #${row.number}` : ""}: ${row.title}`).join("\n")}${problems.length ? `\nPartial update: ${problems.join(" ")}` : ""}`)
    })()
    pending.set(key, work)
    try { return await work } finally { pending.delete(key) }
  }
  const markUpdateRead = async (cardId: string): Promise<string | void> => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card?.kind !== "repo-update") return "That repository update is no longer available."
    if (card.payload.scope !== repositoryUpdateScope(ctx, card.payload.repo)) return "This update belongs to another account."
    await ctx.dispatch({ type: "notifications.read", actor: ctx.actor(), receipts: card.payload.items.map(row => ({ id: row.id, version: row.version })) }).isPersisted.promise
  }
  const tagNotification = async (id: string, tag: string): Promise<string | void> => {
    const row = ctx.store.collections.repositoryNotifications.get(id)
    if (!row || row.scope !== repositoryUpdateScope(ctx, row.repo)) return "That notification is not available in this account."
    if (!tag.trim() || tag.trim().length > 48) return "Use a tag between 1 and 48 characters."
    await ctx.dispatch({ type: "notification.tagged", actor: ctx.actor(), id, tag: tag.trim() }).isPersisted.promise
  }
  return { updateRepo, markUpdateRead, tagNotification }
}
