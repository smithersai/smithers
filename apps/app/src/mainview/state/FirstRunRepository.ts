import type { AppStore } from "./AppStore"
import { PRACTICE_REPO } from "./practice/PracticeRepository"

/**
 * Anonymous app entry; explicit repository URLs and retained selections win.
 * `settled` runs once the choice is durable — with or without a selection —
 * so a command parked on `first-run-target` resumes against the real target,
 * never against the identity row that arrives before it.
 */
export function selectFirstRunRepository(store: AppStore, settled?: () => void): void {
  /*
   * The park slot is single and persisted, so only the park that waits on THIS
   * choice may be resumed here: a sign-in or repo-read park from an earlier
   * visit keeps waiting for the seam that satisfies it.
   */
  const resume = settled === undefined
    ? undefined
    : () => { if (store.session().pendingCommand?.requirement === "first-run-target") settled() }
  if (store.collections.identitySessions.get("identity")?.state === "signed-out" && !store.session().activeRepoKey) {
    const selected = store.dispatch({ type: "repo.selected", actor: "system", id: PRACTICE_REPO })
    if (resume !== undefined) void selected.isPersisted.promise.then(resume, resume)
    return
  }
  resume?.()
}
