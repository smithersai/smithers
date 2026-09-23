import type { FormsController } from "../controller/forms"
import { activeRepositoryId,resolveOpenRepo,resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage,readResult,RepositorySignInRequired } from "./SeamContext"

/** Stop an unauthorized list before it can publish rows. */
export async function readRepositoryListError(response: Response, fallback: string): Promise<string> {
  const message = await readErrorMessage(response, fallback)
  if (response.status === 401) throw new RepositorySignInRequired(message)
  return message
}

export type RepositoryForm = FormsController["renderFlowForm"]

/**
 * A repository issue/PR list read with its doors: an explicit or selected
 * target, a form for a missing target, and a sign-in prompt for a 401.
 */
export async function repositoryListRead(
  ctx: SeamContext,
  kind: "issues" | "prs",
  explicit: string | undefined,
  filter: "open" | "closed" | "all",
  renderForm: RepositoryForm | undefined,
  read: (repo: string) => Promise<string | void | { readonly value: string }>,
): Promise<string | void | { readonly value: string }> {
  const session = ctx.store.session()
  const key = session.activeRepoKey
  const actor = ctx.actor()
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
  return result
}
