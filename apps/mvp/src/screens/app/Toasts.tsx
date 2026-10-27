import { ToastStack } from "@smthrs/ui"
import { useNotices } from "../../features/attention/components/Notices"
import type { Surface } from "../../features/attention/contract"

// Only current notices reserve space; older and overflow entries stay in the bell.
export function Toasts({ surface = "conversation" }: { readonly surface?: Surface } = {}) {
  const feed = useNotices(surface)
  return (
    <ToastStack label="Smithers" placement="inline">
      {feed.toasts.slice(0, 3)}
    </ToastStack>
  )
}
