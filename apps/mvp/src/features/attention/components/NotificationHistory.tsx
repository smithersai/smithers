import { NotificationEntry, NotificationPanel, RelativeTime } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { ComponentProps, ReactElement } from "react"
import { ALERT_WORD, alertDetail } from "../../spend/copy"
import { useSpend } from "../../spend/components/SpendContext"
import { timeOf } from "../entries"

// One chronological panel across the person's feed and the Admin's spend windows. A tie leaves the
// person's entry first. Hiding a spend entry advances only the spend watermark.
export function NotificationHistory({ feed = [], expanded, onExpand, ...panel }: Omit<ComponentProps<typeof NotificationPanel>, "children"> & {
  readonly feed?: ReadonlyArray<{ readonly atMs: number; readonly element: ReactElement }>
  readonly expanded: string | null
  readonly onExpand: (id: string) => void
}): ReactElement {
  const { queries, actions } = useSpend()
  const { data: open } = useLiveQuery(queries.open)
  const spend = open.map(alert => {
    const atMs = timeOf(alert.createdAt)
    return {
      atMs,
      element: (
        <NotificationEntry
          key={`spend:${alert.id}`}
          entryId={alert.id}
          expanded={expanded === alert.id}
          onExpandedChange={() => onExpand(alert.id)}
          onOpen={() => actions.hide(alert.id)}
          openLabel="Mark read"
          unread
          tone="update"
          time={<RelativeTime ts={atMs} />}
          word={ALERT_WORD}
          detail={alertDetail(alert)}
          onHide={() => actions.hide(alert.id)}
          data-alert={alert.id}
        />
      ),
    }
  })
  const chronology = [...feed, ...spend].sort((a, b) => b.atMs - a.atMs)
  return <NotificationPanel {...panel}>{chronology.map(row => row.element)}</NotificationPanel>
}
