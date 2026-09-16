import type { AppStore } from "./AppStore"
import { PRACTICE_REPO } from "./practice/PracticeRepository"

/** Anonymous app entry; explicit repository URLs and retained selections win. */
export function selectFirstRunRepository(store: AppStore): void {
  if (store.collections.identitySessions.get("identity")?.state === "signed-out" && !store.session().activeRepoKey) {
    store.dispatch({ type: "repo.selected", actor: "system", id: PRACTICE_REPO })
  }
}
