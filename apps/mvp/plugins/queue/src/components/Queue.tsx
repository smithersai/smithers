import { Button, EmptyState, Kbd } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import type { QueueTab } from "../tab"
import "./queue.css"

// The queue's view (decision 0022, slice 1): the next open wait fills the screen, with its place in the queue,
// priority sort toggle (`p`), snooze/later (`s`) and restore (`u`). The host's action strip under it draws its options,
// Approve and Changes, and the note box, and owns their keys; `j` and `k` move through the queue.
export function Queue({ tab }: { readonly tab: QueueTab }) {
  const { current } = tab.queries
  const { item, index, total, snoozed, sort, repository } = useSyncExternalStore(current.subscribe, current.current)
  if (item === undefined) {
    return (
      <div className="queue-empty-wrap">
        <EmptyState className="queue-empty" title={snoozed > 0 ? `${snoozed} snoozed for later` : "Nothing needs you"} />
        {snoozed > 0 ? (
          <Button variant="outline" onClick={tab.actions.unsnooze}>
            Restore {snoozed} snoozed <Kbd>u</Kbd>
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <article className="queue-item" aria-label="Item" data-run={item.runId} data-kind={item.kind}>
      <div className="queue-bar">
        <p className="queue-place">{index + 1} of {total}{repository === undefined ? null : ` · ${repository}`}</p>
        <div className="queue-controls">
          <Button variant="ghost" size="sm" onClick={tab.actions.toggleSort}>
            {sort === "approvals" ? "Approvals first" : "Oldest first"} <Kbd>p</Kbd>
          </Button>
          <Button variant="ghost" size="sm" onClick={tab.actions.snooze}>
            Later <Kbd>s</Kbd>
          </Button>
          {snoozed > 0 ? (
            <Button variant="outline" size="sm" onClick={tab.actions.unsnooze}>
              Restore {snoozed} <Kbd>u</Kbd>
            </Button>
          ) : null}
        </div>
      </div>
      <h2 className="queue-prompt">{item.prompt}</h2>
    </article>
  )
}
