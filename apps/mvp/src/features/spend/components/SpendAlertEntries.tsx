import { NotificationEntry } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { ReactElement } from "react"
import { ALERT_WORD, alertDetail } from "../copy"
import { useSpend } from "./SpendContext"

// Unseen spend alerts live only in the bell's panel. Hide marks this and earlier alerts seen.
export function SpendAlertEntries({ expanded, onExpand }: {
  readonly expanded: string | null
  readonly onExpand: (id: string) => void
}): ReactElement {
  const { queries, actions } = useSpend()
  const { data: open } = useLiveQuery(queries.open)
  return <>{open.map((alert) => (
    <NotificationEntry
      entryId={alert.id}
      expanded={expanded === alert.id}
      onExpandedChange={() => onExpand(alert.id)}
      onOpen={() => actions.hide(alert.id)}
      openLabel="Mark read"
      unread
      key={alert.id}
      tone="needs_you"
      word={ALERT_WORD}
      detail={alertDetail(alert)}
      onHide={() => actions.hide(alert.id)}
      data-alert={alert.id}
    />
  ))}</>
}
