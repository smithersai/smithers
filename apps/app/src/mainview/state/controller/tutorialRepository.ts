import { hasCapability } from "@smthrs/rpc/AppBootstrap"
import type { AuthorizedLocalRepositoryInspection } from "@smthrs/rpc/NativeRepository"
import { completeGuide } from "../../onboarding/completion"
import { repoKeyOf } from "../AppState"
import { rankTutorialRepositories, type RepositoryRanking } from "../seams/RepositoriesSeam"
import { adoptLocalRepository } from "./adoptLocalRepository"
import type { ControllerContext } from "./context"

export interface RepositoryChoicePayload extends RepositoryRanking {
  readonly selected: string | null
  readonly created: { readonly name: string; readonly path: string } | null
}
export interface TutorialRepositoryActions {
  readonly chooseTutorialRepository: (repo?: string) => Promise<string | void>
  readonly createTutorialRepository: (name: string) => Promise<string | void>
}
export interface TutorialRepositoryPorts {
  /** Root binds card.upsert to the repository-choice schema; the card draft is durable. */
  readonly publish: (payload: RepositoryChoicePayload) => Promise<void>
  readonly localHandoff: () => Promise<string | void>
}

export function createTutorialRepositoryController(ctx: ControllerContext, ports: TutorialRepositoryPorts): TutorialRepositoryActions {
  const identity = () => ctx.store.collections.identitySessions.get("identity")
  const scope = () => ({ playthrough: ctx.store.session().guide?.playthrough ?? 0, account: identity()?.login, epoch: ctx.accountEpoch })
  const current = (before: ReturnType<typeof scope>) => before.playthrough === (ctx.store.session().guide?.playthrough ?? 0) && before.account === identity()?.login && before.epoch === ctx.accountEpoch
  const finish = async (before: ReturnType<typeof scope>, key: string) => {
    const guide = ctx.store.session().guide
    if (!current(before) || guide?.step !== 2 || ctx.store.session().activeRepoKey !== key) return
    await ctx.store.dispatch({ type: "guide.changed", actor: ctx.commandActor, guide: completeGuide(guide, "repository.ready") }).isPersisted.promise
  }
  return {
    chooseTutorialRepository: async (repo) => {
      const before = scope()
      const login = identity()?.state === "signed-in" ? identity()?.login : null
      const ranking = login ? await rankTutorialRepositories(ctx.boundedFetch, ctx.baseUrl, login) : {
        cutoff: new Date(Date.now() - 90 * 86400000).toISOString(), repositories: [], partial: true,
        error: "Sign in to rank GitHub contributions, or Skip to create a local repository."
      }
      if (!current(before)) return "The account or tutorial changed; choose the repository again."
      if (repo === undefined) {
        await ports.publish({ ...ranking, selected: ranking.repositories.find(row => row.count !== null)?.fullName ?? null, created: null })
        return
      }
      if (!ranking.repositories.some(row => row.fullName === repo)) return "That repository is not in the current GitHub inventory. Refresh the repository choice."
      const [org = "", name = ""] = repo.split("/")
      if (!ctx.store.collections.repositories.has(repo)) {
        await ctx.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
          ...ctx.store.collections.repositories.values(), { id: repo, org, name, ownerKind: "user", head: null }
        ] }).isPersisted.promise
      }
      await ctx.store.dispatch({ type: "repo.selected", actor: ctx.commandActor, id: repo }).isPersisted.promise
      await ports.publish({ ...ranking, selected: repo, created: null })
      await finish(before, repo)
    },
    createTutorialRepository: async (name) => {
      if (!ctx.services.bootstrap || !hasCapability(ctx.services.bootstrap, "local.repositories")) return ports.localHandoff()
      const before = scope()
      const response = await ctx.boundedFetch(`${ctx.baseUrl}/api/repo/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })
      if (!response.ok) return ctx.errorMessageOf(response, "Could not create the local repository.")
      const answer = await response.json() as { status?: string; repository?: AuthorizedLocalRepositoryInspection }
      const picked = answer.repository
      if (answer.status !== "connected" || !picked || !picked.root.startsWith("/") || !picked.authorizationId || picked.remoteUrl !== null) return "The host did not return a new local repository."
      if (!current(before)) return `Created ${picked.name} at ${picked.root}. The account or tutorial changed; open it again to continue.`
      const refusal = await adoptLocalRepository(ctx, picked, "read-write")
      if (refusal !== undefined) return refusal
      const key = repoKeyOf(picked.root)
      await ctx.store.dispatch({ type: "repo.selected", actor: ctx.commandActor, id: key }).isPersisted.promise
      await ports.publish({ cutoff: new Date().toISOString(), repositories: [], partial: false, error: null, selected: key, created: { name: picked.name, path: picked.root } })
      await finish(before, key)
    }
  }
}
