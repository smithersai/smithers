import { actorSharedState } from "../ActorBindings"

/*
 * The fence a run-tracking poll loop shares with the starts that supersede
 * it, held in actor-shared state so a user's and an agent's projection of
 * the same seam fence each other. `start` issues the epoch a new loop runs
 * under and marks it the live one; `isLive` is the loop's stop signal after
 * every await; `settle` retires a loop that reached a terminal hand-off, and
 * `cancel` retires whatever is running for a key when the thing it tracked
 * is gone.
 *
 * The issued counter is per key and never reset. Settling used to DELETE the
 * key outright, so the next start read `(undefined ?? 0) + 1` and handed out
 * epoch 1 again: a loop from an earlier start, parked inside its poll when
 * it was superseded, then passed the fence and kept writing the card the
 * newer start owns (review finding 4). Only the live marker is deleted now;
 * an epoch is never handed out twice for the same key.
 */
export const createRunEpochs = (context: object, name: string) => {
  const state = actorSharedState(context, name, () => ({
    issued: new Map<string, number>(),
    live: new Map<string, number>()
  }))
  return {
    start: (key: string): number => {
      const epoch = (state.issued.get(key) ?? 0) + 1
      state.issued.set(key, epoch)
      state.live.set(key, epoch)
      return epoch
    },
    isLive: (key: string, epoch: number): boolean => state.live.get(key) === epoch,
    settle: (key: string, epoch: number): void => {
      if (state.live.get(key) === epoch) state.live.delete(key)
    },
    cancel: (key: string): void => {
      state.live.delete(key)
    }
  }
}
