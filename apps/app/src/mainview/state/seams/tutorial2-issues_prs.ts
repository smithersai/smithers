import { completeGuide } from "../../onboarding/completion"
import { activeRepositoryId, resolveOpenRepo, resolveTargetRepo } from "../RepoContext"
import type { FormsController } from "../controller/forms"
import type { SeamContext } from "./SeamContext"
import { readResult } from "./SeamContext"

export type RepositoryForm = FormsController["renderFlowForm"]

/** A list receipt is scoped to the selection and playthrough that requested it. */
export async function tutorialRepositoryRead(
  ctx: SeamContext,
  kind: "issues" | "prs",
  explicit: string | undefined,
  filter: "open" | "closed" | "all",
  renderForm: RepositoryForm | undefined,
  read: (repo: string) => Promise<string | { readonly value: string }>,
): Promise<string | { readonly value: string }> {
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
  let result: string | { readonly value: string }
  if (local && "repo" in local) {
    const body = `This local-only repository has no hosted ${kind === "issues" ? "issue tracker" : "pull requests"}.`
    const common = { id: `${kind}-${repo}`, title: `${kind === "issues" ? "Issues" : "Pull requests"} · ${local.repo.name}`, body,
      status: "active" as const, createdAt: Date.now(), ordinal: ctx.nextOrdinal() }
    await ctx.dispatch({ type: "card.upsert", actor, card: kind === "issues"
      ? { ...common, kind: "issue-list", payload: { repo, filter, issues: [] } }
      : { ...common, kind: "pr-list", payload: { repo, landings: [] } } }).isPersisted.promise
    result = readResult(body)
  } else result = await read(repo)
  const current = ctx.store.session()
  const currentIdentity = ctx.store.collections.identitySessions.get("identity")
  const card = ctx.store.collections.cards.get(`${kind}-${repo}`)
  const refused = card?.kind === "issue-list" && (card.payload.github?.refusal || card.payload.github?.syncError || card.payload.github?.stale)
  const selected = local && "repo" in local ? local.repo.path : activeRepositoryId(ctx.store)
  if (typeof result !== "string" && !refused && card && selected === repo && current.activeRepoKey === key &&
    identity?.login === currentIdentity?.login && identity?.state === currentIdentity?.state &&
    guide?.step === 3 && current.guide?.step === 3 && current.guide.playthrough === guide.playthrough) {
    // prs.opened normalizes to issues.opened in the guide's single issues/PR lesson.
    await ctx.dispatch({ type: "guide.changed", actor, guide: completeGuide(current.guide, "issues.opened") }).isPersisted.promise
  }
  return result
}
