import { publishIssueView, publishRepoView, repoPaneCard } from "../EmbeddedHistory"
import { lessonCompletion } from "../../onboarding/completion"
import { isPracticeRepo, PRACTICE_CARD, PRACTICE_NAME, practiceIssue, practiceIssueList, practicePr, practicePrList } from "../practice/PracticeRepository"
import { activeRepositoryId, resolveOpenRepo, resolveTargetRepo } from "../RepoContext"
import type { FormsController } from "../controller/forms"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage, readResult } from "./SeamContext"

class RepositorySignInRequired extends Error {}

/** Stop an unauthorized list before it can publish rows or complete a lesson. */
export async function readRepositoryListError(response: Response, fallback: string): Promise<string> {
  const message = await readErrorMessage(response, fallback)
  if (response.status === 401) throw new RepositorySignInRequired(message)
  return message
}

export type RepositoryForm = FormsController["renderFlowForm"]

const signalOf = (kind: "issues" | "prs") => kind === "issues" ? "issues.opened" : "prs.opened"

/** Complete the current lesson when it waits on `signal`; a later lesson or another playthrough is untouched. */
export const finishLesson = async (ctx: SeamContext, signal: string, playthrough: number | undefined): Promise<void> => {
  const guide = ctx.store.session().guide
  if (guide === undefined || guide.playthrough !== playthrough) return
  const next = lessonCompletion(guide, signal)
  if (next !== undefined) await ctx.dispatch({ type: "guide.changed", actor: ctx.actor(), guide: next }).isPersisted.promise
}

/** The practice repository answers from its bundle: no identity, no request. */
const practiceRead = async (ctx: SeamContext, kind: "issues" | "prs", filter: "open" | "closed" | "all"): Promise<{ readonly value: string }> => {
  const playthrough = ctx.store.session().guide?.playthrough
  const common = { status: "active" as const, createdAt: Date.now(), ordinal: ctx.nextOrdinal() }
  if (kind === "issues") {
    const baseline = practiceIssueList("all")
    const all = baseline.issues.map(issue => {
      const saved = savedPracticeIssue(ctx, issue.number)
      return saved ? { ...issue, state: saved.state, comments: saved.comments.length } : issue
    })
    const payload = { ...baseline, filter, issues: all.filter(issue => filter === "all" || issue.state === filter) }
    await publishRepoView(ctx, { ...common, id: PRACTICE_CARD.issues, kind: "issue-list", title: `Issues · ${PRACTICE_NAME}`, payload })
    await finishLesson(ctx, signalOf(kind), playthrough)
    return readResult(payload.issues.map(issue => `#${issue.number} ${issue.title} [${(issue.labels ?? []).join(", ")}]`).join("\n"))
  }
  const payload = practicePrList()
  await publishRepoView(ctx, { ...common, id: PRACTICE_CARD.prs, kind: "pr-list", title: `Pull requests · ${PRACTICE_NAME}`, payload })
  await finishLesson(ctx, signalOf(kind), playthrough)
  return readResult(payload.landings.map(pr => `#${pr.number} ${pr.title} by ${pr.author} (touches ${(pr.files ?? []).join(", ")})`).join("\n"))
}


export const savedPracticeIssue = (ctx: SeamContext, number: number) => {
  const saved = ctx.store.collections.practiceIssues.get(`${ctx.store.session().guide?.playthrough ?? 0}:${number}`)
  return saved?.card.kind === "issue" ? saved.card.payload : undefined
}

export const mutatePracticeIssue = async (ctx: SeamContext, number: number, edit: (payload: NonNullable<ReturnType<typeof practiceIssue>>) => NonNullable<ReturnType<typeof practiceIssue>>): Promise<string | void> => {
  const payload = savedPracticeIssue(ctx, number) ?? practiceIssue(number)
  if (!payload) return `No issue #${number} in ${PRACTICE_NAME}.`
  const card = { id: PRACTICE_CARD.issue(number), kind: "issue" as const, title: `#${number} ${payload.title}`, status: "active" as const, createdAt: Date.now(), ordinal: ctx.nextOrdinal(), payload: edit(payload) }
  await ctx.dispatch({ type: "practice.issue.updated", actor: ctx.actor(), id: `${ctx.store.session().guide?.playthrough ?? 0}:${number}`, card }).isPersisted.promise
  await publishIssueView(ctx, card)
}

/** issues.view on the practice repository: the bundled issue, then the lesson's `issue.opened`. */
export async function practiceViewIssue(ctx: SeamContext, number: number): Promise<string | void | { readonly value: string }> {
  const payload = savedPracticeIssue(ctx, number) ?? practiceIssue(number)
  if (payload === undefined) return `No issue #${number} in ${PRACTICE_NAME}.`
  const playthrough = ctx.store.session().guide?.playthrough
  await publishIssueView(ctx, {
    id: PRACTICE_CARD.issue(number), kind: "issue", title: `#${number} ${payload.title}`, status: "active",
    createdAt: Date.now(), ordinal: ctx.nextOrdinal(), payload
  })
  if (number === 3) await finishLesson(ctx, "issue.opened", playthrough)
  return readResult(`#${number} ${payload.title}\n${payload.issueBody}`)
}

/** prs.view on the practice repository: the bundled PR with its branch, commits and per-file patches. No lesson waits on it. */
export async function practiceViewLanding(ctx: SeamContext, number: number): Promise<string | void | { readonly value: string }> {
  const payload = practicePr(number)
  if (payload === undefined) return `No pull request #${number} in ${PRACTICE_NAME}.`
  await publishRepoView(ctx, {
    id: `practice-pr-${number}`, kind: "pr", title: `#${number} ${payload.title}`, status: "active",
    createdAt: Date.now(), ordinal: ctx.nextOrdinal(), payload
  })
  return readResult(`#${number} ${payload.title} by ${payload.author}\n${payload.prBody}`)
}

/** Emitted by a hosted issues.view after its card persists: the lesson key, not a step number. */
export const finishIssueLesson = (ctx: SeamContext, playthrough: number | undefined) => finishLesson(ctx, "issue.opened", playthrough)

/** A list receipt is scoped to the selection and playthrough that requested it. */
export async function tutorialRepositoryRead(
  ctx: SeamContext,
  kind: "issues" | "prs",
  explicit: string | undefined,
  filter: "open" | "closed" | "all",
  renderForm: RepositoryForm | undefined,
  read: (repo: string) => Promise<string | void | { readonly value: string }>,
): Promise<string | void | { readonly value: string }> {
  if (isPracticeRepo(explicit)) return practiceRead(ctx, kind, filter)
  const session = ctx.store.session()
  const key = session.activeRepoKey
  const guide = session.guide
  const actor = ctx.actor()
  const identity = ctx.store.collections.identitySessions.get("identity")
  const local = !explicit && key?.startsWith("local:") && activeRepositoryId(ctx.store) === null
    ? resolveOpenRepo(ctx.store) : undefined
  if (local && "error" in local) return local.error
  const target = local && "repo" in local ? { repo: local.repo.path } : resolveTargetRepo(ctx.store, explicit)
  if ("error" in target) {
    if (!explicit && renderForm) {
      renderForm({ name: `${kind}.list`, args: kind === "issues" ? filter : "", via: actor === "smithers" ? "agent" : "user",
        hints: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text", required: true } } } })
      return readResult("Rendered a form for repo.")
    }
    return target.error
  }
  const { repo } = target
  let result: string | void | { readonly value: string }
  if (local && "repo" in local) {
    const body = `This local-only repository has no hosted ${kind === "issues" ? "issue tracker" : "pull requests"}.`
    const common = { id: `${kind}-${repo}`, title: `${kind === "issues" ? "Issues" : "Pull requests"} · ${local.repo.name}`, body,
      status: "active" as const, createdAt: Date.now(), ordinal: ctx.nextOrdinal() }
    await ctx.dispatch({ type: "card.upsert", actor, card: kind === "issues"
      ? { ...common, kind: "issue-list", payload: { repo, filter, issues: [] } }
      : { ...common, kind: "pr-list", payload: { repo, landings: [] } } }).isPersisted.promise
    result = readResult(body)
  } else {
    try {
      result = await read(repo)
    } catch (error) {
      if (!(error instanceof RepositorySignInRequired)) throw error
      if (ctx.promptSignIn === undefined) return error.message
      ctx.promptSignIn(`read ${kind === "issues" ? "issues" : "pull requests"} on ${repo}`)
      return readResult("The sign-in step is rendered in the chat.")
    }
  }
  const current = ctx.store.session()
  const currentIdentity = ctx.store.collections.identitySessions.get("identity")
  /* The list may be the repository pane's current location rather than a card of its own. */
  const pane = repoPaneCard(ctx, repo)
  const card = ctx.store.collections.cards.get(`${kind}-${repo}`) ??
    (pane !== undefined && pane.kind === (kind === "issues" ? "issue-list" : "pr-list") ? pane : undefined)
  const refused = card?.kind === "issue-list" && (card.payload.github?.refusal || card.payload.github?.syncError || card.payload.github?.stale)
  const selected = local && "repo" in local ? local.repo.path : activeRepositoryId(ctx.store)
  if (result !== undefined && typeof result !== "string" && !refused && card && selected === repo && current.activeRepoKey === key &&
    identity?.login === currentIdentity?.login && identity?.state === currentIdentity?.state &&
    guide?.step === current.guide?.step) {
    await finishLesson(ctx, signalOf(kind), guide?.playthrough)
  }
  return result
}
