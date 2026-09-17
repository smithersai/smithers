import type { AppStore } from "./AppStore"
import { PRACTICE_REPO } from "./practice/PracticeRepository"

/**
 * Anonymous app entry; explicit repository URLs and retained selections win.
 * `settled` runs once the choice is durable — with or without a selection —
 * so a command parked on `first-run-target` resumes against the real target,
 * never against the identity row that arrives before it.
 */
export function selectFirstRunRepository(store: AppStore, settled?: () => void): void {
  if (store.collections.identitySessions.get("identity")?.state === "signed-out" && !store.session().activeRepoKey) {
    const selected = store.dispatch({ type: "repo.selected", actor: "system", id: PRACTICE_REPO })
    if (settled !== undefined) void selected.isPersisted.promise.then(settled, settled)
    return
  }
  settled?.()
}
