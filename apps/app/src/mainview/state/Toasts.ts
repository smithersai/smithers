import type { GuideState, Toast } from "./AppState"
import { legacyLibrarianFailure, librarianLaunchFor } from "./LibrarianLaunch"

/** Tutorial guidance and inline librarian failures already have a home in the lesson. */
export function visibleToasts(toasts: ReadonlyArray<Toast>, guide?: GuideState): ReadonlyArray<Toast> {
  if (!guide || guide.finished) return toasts
  // Old persisted tutorial tips are superseded by the action-anchored guidance.
  return toasts.filter(toast => {
    if (toast.key.startsWith("guide-tip-")) return false
    if (guide?.step !== 12) return true
    const legacy = legacyLibrarianFailure(guide)
    if (legacy && toast.key === `command.failed.${legacy.kind === "wiki" ? "wiki.create" : "history.bootstrap"}` && toast.detail === legacy.error) return false
    if (legacy && toast.key.startsWith(`flow.provision.${guide.repo}.`) && toast.detail === legacy.error) return false
    const launches = { wiki: librarianLaunchFor(guide, "wiki"), history: librarianLaunchFor(guide, "history") }
    const inlineFailure = toast.key === "command.failed.wiki.create" ? launches?.wiki : toast.key === "command.failed.history.bootstrap" ? launches?.history : undefined
    if (inlineFailure?.phase === "failed" && toast.detail === inlineFailure.reason) return false
    const preparing = Object.values(launches ?? {}).some(launch => launch && launch.repo === guide.repo && (launch.phase === "preparing" || launch.phase === "launching"))
    return !(preparing && toast.key.startsWith(`flow.provision.${guide.repo}.`))
  })
}
