import { Effect, Option } from "effect"
import { CURRENT } from "../branch/schema"
import { BranchStore } from "../branch/store"

// What `/new` in the composer does with its payload (docs/features/conversations.md#new): a new conversation is a new
// branch of the repository the tab shows.

/**
 * `payload` with the repository of the branch this tab's route shows pinned in it, so the new branch is that
 * repository's. On the home conversation, or a payload naming one, it stays as it is: no repository is the
 * deployment's own.
 */
export const pinRepository = (payload: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    if (payload.repo !== undefined) return payload
    const branch = yield* Effect.serviceOption(BranchStore)
    const current = Option.isSome(branch) ? Option.getOrUndefined(yield* branch.value.current.get(CURRENT)) : undefined
    return current === undefined || current.owner === "" || current.repo === ""
      ? payload
      : { ...payload, repo: `${current.owner}/${current.repo}` }
  })

/**
 * `payload` with the branch this tab's route shows pinned in it (its repository and name), as `/publish` and
 * `/branch.update` act on it (docs/features/branch-publish.md). A payload naming a branch, or a tab showing none, stays.
 */
export const pinBranch = (payload: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    if (payload.repo !== undefined && payload.branch !== undefined) return payload
    const branch = yield* Effect.serviceOption(BranchStore)
    const current = Option.isSome(branch) ? Option.getOrUndefined(yield* branch.value.current.get(CURRENT)) : undefined
    return current === undefined || current.owner === "" || current.repo === "" || current.name === ""
      ? payload
      : { ...payload, repo: `${current.owner}/${current.repo}`, branch: current.name }
  })
