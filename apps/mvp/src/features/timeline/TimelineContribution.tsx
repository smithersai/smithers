import { ChatTimeline } from "@smthrs/ui"
import { railEntries, type RailMessage, type RailDraft, type RailStatus, type RailTodo } from "./view"

/** Compiled first-party chat.rail contribution. Data is supplied by the host, never acquired privately. */
export function TimelineContribution({ messages, statuses, drafts = [], todos = [], onJump, onActivate }: {
  readonly messages: readonly RailMessage[]
  readonly statuses: readonly RailStatus[]
  readonly drafts?: readonly RailDraft[]
  readonly todos?: readonly RailTodo[]
  readonly onJump?: (id: string) => void
  readonly onActivate?: (id: string) => void
}) {
  return <ChatTimeline entries={railEntries(messages, statuses, drafts, todos)} onJump={onJump} onActivate={onActivate} />
}
