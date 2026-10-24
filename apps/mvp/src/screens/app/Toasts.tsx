import { ToastStack } from "@smthrs/ui"
import { useNotices } from "../../features/attention/components/Notices"
import type { Surface } from "../../features/attention/contract"
import { usePersonalModelToasts } from "../../features/personal-model/components/PersonalModelToasts"
import { useSpendAlertToasts } from "../../features/spend/components/SpendAlertToasts"

// The shell's one toast stack (decision 0009 §4): the person's feed first (questions, failures, live work elsewhere,
// what finished, the repository's updates; docs/features/notifications.md), then the model spend alerts an Admin
// hasn't hidden (docs/features/spend-alerts.md), then the person's own model's failure this device hasn't hidden
// (docs/features/personal-model.md#when-the-key-fails). Three show, and `+N` counts the rest and the person's list and
// opens the notifications panel. The conversation's own runs show in it instead, unless they need the person; a page
// that shows no conversation (a branch's page the person can't open) passes `surface` `page`, so every toast shows and
// opens.
export function Toasts({ surface = "conversation" }: { readonly surface?: Surface } = {}) {
  const feed = useNotices(surface)
  const spend = useSpendAlertToasts()
  const personalModel = usePersonalModelToasts()
  return (
    <ToastStack label="Smithers" placement="inline" moreCount={feed.moreCount} onMore={feed.onMore}>
      {feed.toasts}
      {spend}
      {personalModel}
    </ToastStack>
  )
}
