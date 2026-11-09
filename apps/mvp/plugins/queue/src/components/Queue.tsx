import { EmptyState } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import type { QueueTab } from "#vibelang/source/plugins/queue/src/tab"
import "./queue.css"

// The queue's view (decision 0022, slice 1): the oldest open wait fills the screen, with its place in the queue. The
// host's action strip under it draws its options, Approve and Changes, and the note box, and owns their keys; `j` and
// `k` move through the queue. With nothing waiting, it says so.
export function Queue({ tab }: { readonly tab: QueueTab }) {
  const { current } = tab.queries
  const { item, index, total } = useSyncExternalStore(current.subscribe, current.current)
  if (item === undefined) return <EmptyState className="queue-empty" title="Nothing needs you" />
  return (
    <article className="queue-item" aria-label="Item" data-run={item.runId} data-kind={item.kind}>
      <p className="queue-place">{index + 1} of {total}</p>
      <h2 className="queue-prompt">{item.prompt}</h2>
    </article>
  )
}
