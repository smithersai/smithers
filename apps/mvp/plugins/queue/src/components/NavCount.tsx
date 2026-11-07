import { Badge, Button } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import type { QueueTab } from "../tab.vibe"

// The queue's place in the header's nav: Queue, with how many items wait on you.
export function NavCount({ tab }: { readonly tab: QueueTab }) {
  const { waits } = tab.queries
  const rows = useSyncExternalStore(waits.subscribe, waits.current)
  return (
    <Button variant="link" className="queue-nav" onClick={tab.actions.open}>
      Queue{rows.length > 0 ? <Badge aria-label={`${rows.length} waiting`}>{rows.length}</Badge> : null}
    </Button>
  )
}
