import { Notices } from "./Notices"
import { NotificationsBell } from "./NotificationsBell"

// Pages without a header bell use the floating controls, including a page whose header failed to render.
export function PageNotices() {
  return (
    <>
      <div className="root-notices"><Notices surface="page" /></div>
      <div className="root-bell"><NotificationsBell /></div>
    </>
  )
}
