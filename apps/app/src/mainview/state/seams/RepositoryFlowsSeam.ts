/*
 * The repository-flows seam: the flow catalog of the active repository, as
 * `.smithers/factory.json` declares it (the `flows` rows of the factory
 * projection), held in the `repositoryFlows` collection so the registry can
 * derive one slash leaf per row synchronously (flows/entries/flow.ts
 * `repositoryFlowLeaves`). The Home pane says "Try first /review"; this seam
 * is why typing `/review` finds a flow.
 *
 * The read is the public contents route the Dispatcher card and the palette's
 * target search already use (TriggersSeam.readFactoryProjection), allowlisted
 * signed out, so a visitor sees the repository's flows before signing in. The
 * leaves themselves defer through sign-in when run: that door is flow.run's.
 *
 * Data-driven end to end: the collection holds what the mirror answered and
 * nothing else. A mirror without a projection, or an unreadable one, leaves
 * no row and therefore no leaves; a repository that stops being the target
 * keeps its row, and the leaves follow the target (AppController
 * `repositoryFlows`). Each repository is read once per session, in the
 * background, the first time it becomes the target; `load` re-reads on demand.
 * No flow name is written in this app.
 *
 * The target is re-resolved after every transition rather than after a
 * hand-kept list of them: the native app makes a checkout the target through
 * `repos.loaded` (ControllerBoot at boot, targets.ts after repo.open), the
 * cloud host through `repositories.loaded` and `repo.selected`, and a list
 * that named some of these once missed the local host entirely (review
 * finding on 9ab275caf5). Resolving is a few collection reads and the
 * per-repository dedup makes a repeat resolution free.
 */
import type { RepositoryFlow } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"
import { readFactoryProjection } from "./TriggersSeam"

export interface RepositoryFlowsSeam {
  /** Read one repository's declared flows into the collection now; an absent or unreadable projection clears its row. */
  readonly load: (repo: string) => Promise<void>
  /** Read the active repository's flows, and every new target's as it becomes one, until disposed. */
  readonly subscribe: (onDispose: (release: () => void) => void) => void
}

/** The projection's flow rows as the collection keeps them, featured first (stable), in catalog order. */
export const repositoryFlowsOf = (
  flows: ReadonlyArray<{
    readonly id: string
    readonly description: string
    readonly summary: string | null
    readonly featured: boolean
    readonly modelInvocable: boolean
  }>
): Array<RepositoryFlow> =>
  [...flows]
    .sort((left, right) => Number(right.featured) - Number(left.featured))
    .map(({ id, description, summary, featured, modelInvocable }) => ({ id, description, summary, featured, modelInvocable }))

export const createRepositoryFlowsSeam = (ctx: SeamContext): RepositoryFlowsSeam => {
  /** Repositories read this session, in flight or landed: one background read each. */
  const read = new Set<string>()
  let disposed = false

  const load: RepositoryFlowsSeam["load"] = async (repo) => {
    read.add(repo)
    const answer = await readFactoryProjection(ctx, repo)
    if (disposed) return
    const flows = "error" in answer || answer.absent ? [] : repositoryFlowsOf(answer.projection.flows ?? [])
    if (flows.length === 0 && ctx.store.collections.repositoryFlows.get(repo) === undefined) return
    ctx.dispatch({ type: "repository-flows.loaded", actor: "system", repo, flows })
  }

  const loadTarget = (): void => {
    if (disposed) return
    const target = resolveTargetRepo(ctx.store, undefined)
    if ("error" in target || read.has(target.repo)) return
    void load(target.repo)
  }

  const subscribe: RepositoryFlowsSeam["subscribe"] = (onDispose) => {
    loadTarget()
    const subscription = ctx.store.collections.transitions.subscribeChanges((changes) => {
      /*
       * After the commit, not inside it: the target of a local checkout is
       * read through the `workingCopies` live view (WorkspaceViews.ts), which
       * settles after the transitions subscribers of the same dispatch have
       * run, so resolving synchronously here saw repos.loaded's activeRepoKey
       * with no copy behind it and answered "no repository is loaded".
       */
      if (changes.some((change) => change.type === "insert")) queueMicrotask(loadTarget)
    })
    onDispose(() => {
      disposed = true
      subscription.unsubscribe()
    })
  }

  return { load, subscribe }
}
