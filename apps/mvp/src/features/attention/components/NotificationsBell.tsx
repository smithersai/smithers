import { useSpend } from "../../spend/components/SpendContext"
import { NotificationBell } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useAttention } from "./AttentionContext"

// The top bar's one way in to the person's notifications (decision 0009): the unread count, `◆ Needs you` while runs
// wait on them, and the notifications panel it opens and closes (Alt+N), at the newest run waiting on them.
export function NotificationsBell() {
  const spend = useSpend()
  const { data: alerts } = useLiveQuery(spend.queries.open)
  const { queries, actions } = useAttention()
  const { data: unread } = useLiveQuery(queries.unread)
  const { data: needs } = useLiveQuery(queries.needs)
  const { data: panel } = useLiveQuery(queries.panel)
  return (
    <NotificationBell
      unread={unread.length + alerts.length}
      needsYou={needs.length}
      expanded={panel?.open === true}
      onClick={() => actions.togglePanel("bell")}
    />
  )
}
