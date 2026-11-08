import { NotificationsBell } from "../../attention/components/NotificationsBell"
import { ConnectionPill } from "../../chat/components/ConnectionPill"

/** Personal controls shared by readable and refused repository pages; no repository data is read here. */
export function RepoHeaderControls() {
  return <>
    <div role="status" aria-label="Connection" aria-live="polite"><ConnectionPill /></div>
    <span className="repo-header-bell"><NotificationsBell /></span>
  </>
}
