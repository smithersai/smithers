import type { AppStore } from "./AppStore"
import { PRACTICE_REPO } from "./practice/PracticeRepository"

/**
 * Anonymous app entry; explicit repository URLs and retained selections win.
 * `settled` runs once the choice is durable — with or without a selection —
 * so a command parked on `first-run-target` resumes against the real target,
 * never against the identity row that arrives before it.
 */
export function selectFirstRunRepository(store: AppStore, settled?: () => void): void {
  const identity = store.collections.identitySessions.get("identity")?.state
  /*
   * No identity answer yet, so there is no choice to make and none to settle:
   * boot calls this again from the identity `.then()`. Settling here would
   * declare the first-run target decided while it is still being fetched.
   */
  if (identity === undefined || identity === "unknown") return
  if (identity === "signed-out" && !store.session().activeRepoKey) {
    const selected = store.dispatch({ type: "repo.selected", actor: "system", id: PRACTICE_REPO })
    if (settled !== undefined) void selected.isPersisted.promise.then(settled, settled)
    return
  }
  settled?.()
}
