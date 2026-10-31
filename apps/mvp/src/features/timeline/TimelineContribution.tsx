import { ChatTimeline } from "@smthrs/ui"
import { railEntries, railMarkers, type RailMessage, type RailDraft, type RailStatus, type RailTodo } from "./view"

/** Compiled first-party chat.rail contribution. Data is supplied by the host, never acquired privately. */
export function TimelineContribution({ messages, statuses, drafts = [], todos = [], unavailable, onJump, onActivate }: {
  readonly messages: readonly RailMessage[]
  readonly statuses: readonly RailStatus[]
  readonly drafts?: readonly RailDraft[]
  readonly todos?: readonly RailTodo[]
  /** Why summaries can't be made now, when they can't: the rail says so on what's missing one. */
  readonly unavailable?: string | undefined
  readonly onJump?: (id: string) => void
  readonly onActivate?: (id: string) => void
}) {
  return <ChatTimeline entries={railEntries(messages, statuses, drafts, todos)} phases={railMarkers(messages, "phase")} arcs={railMarkers(messages, "arc")}
    {...(unavailable === undefined ? {} : { unavailable })} {...(onJump === undefined ? {} : { onJump })} {...(onActivate === undefined ? {} : { onActivate })} />
}
