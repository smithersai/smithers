import { ToastStack } from "@smthrs/ui"
import { useNotices } from "../../features/attention/components/Notices"
import type { Surface } from "../../features/attention/contract"
import { usePersonalModelToasts } from "../../features/personal-model/components/PersonalModelToasts"

// Only current notices reserve space; older and overflow entries stay in the bell.
export function Toasts({ surface = "conversation" }: { readonly surface?: Surface } = {}) {
  const feed = useNotices(surface)
  const personalModel = usePersonalModelToasts()
  return (
    <ToastStack label="Smithers" placement="inline">
      {[...feed.toasts, ...personalModel].slice(0, 3)}
    </ToastStack>
  )
}
