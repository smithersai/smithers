import { Effect, Option } from "effect"
import { CURRENT } from "../branch/schema"
import { BranchStore } from "../branch/store"

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
