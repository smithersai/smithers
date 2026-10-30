import { EmptyState, LinkTabs, RelativeTime } from "@smthrs/ui"
import type { ReactNode } from "react"
import { type Status, VIEWS, type ViewId } from "../model"
import { OpenedPanel } from "./Opened"
import { useWatched, ViewLink, type ViewProps } from "./parts"
import "./factory.css"

// Every factory view's frame: the tabs, how old the status is, the view's own content once the feed is there, and the
// document the person opened beside it (a lane's transcript, a commit's diff, a review). Durations count to the
// status's own time (`at`, seconds), so a view shows the factory as of its last push.

/** The frame of view `view`; `children` draws the repository's status once it arrived. */
export function Frame(
  { tab, repository, view, children }: ViewProps & { readonly view: ViewId; readonly children: (status: Status, now: number) => ReactNode },
) {
  if (repository === undefined) return null
  return <Framed tab={tab} repository={repository} view={view}>{children}</Framed>
}

function Framed(
  { tab, repository, view, children }: Required<ViewProps> & { readonly view: ViewId; readonly children: (status: Status, now: number) => ReactNode },
) {
  const feed = useWatched(tab.queries.feed(repository))
  return (
    <div className="factory" data-view={view}>
      <div className="factory-bar">
        <LinkTabs className="factory-tabs" aria-label="Factory">
          {VIEWS.map((entry) => (
            <ViewLink key={entry.id} tab={tab} repository={repository} view={entry.id} current={entry.id === view}>
              {entry.title}
            </ViewLink>
          ))}
        </LinkTabs>
        {feed._tag === "Ready" && feed.status.at !== null
          ? <RelativeTime className="factory-age" aria-label="Updated" ts={feed.status.at * 1000} />
          : null}
      </div>
      {feed._tag === "Loading"
        ? null
        : feed._tag === "Refused" || feed.documents === 0
        ? <EmptyState title="No feed yet" />
        : <div className="factory-grid">{children(feed.status, feed.status.at ?? 0)}</div>}
      <OpenedPanel tab={tab} />
    </div>
  )
}
