import type { AppStore } from "./AppStore"

/**
 * Fixture-only receipts for dispatches, including terminal frames and command
 * bookkeeping. A rendered result is not a persistence receipt. Stop producers
 * before settle() when simulating reload; direct collection writes need their
 * own receipts and are deliberately not represented by this helper.
 */
export const trackDispatchCommits = (opened: AppStore) => {
  const commits: Array<Promise<unknown>> = []
  const store: AppStore = {
    ...opened,
    dispatch: (transition) => {
      const transaction = opened.dispatch(transition)
      commits.push(transaction.isPersisted.promise)
      return transaction
    }
  }
  const settle = async (): Promise<void> => {
    let seen = 0
    while (seen < commits.length) {
      const pending = commits.slice(seen)
      seen = commits.length
      await Promise.all(pending)
    }
  }
  return { store, settle }
}
