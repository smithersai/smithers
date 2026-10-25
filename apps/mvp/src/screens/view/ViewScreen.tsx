import { Button, DocsPageView, WebPageView } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useSearch } from "@tanstack/react-router"
import { AgentView, previewOf } from "../../features/views/components/ConversationView"
import { useViews } from "../../features/views/components/ViewsContext"
import { BACK_TO_CHAT } from "../../features/views/contract"
import { pageOf } from "../../features/views/rows"
import "./view-screen.css"

// /app/views/$viewId: one view at its full size (decision 0004 §6), from the same synced row the conversation shows
// inline: a framed page, the agent's form, or a generated view, which a person plays here as in the chat. The route's
// loader shows it (`show`); this screen renders it once the device has it, and nothing before.
export function ViewScreen() {
  const { queries } = useViews()
  // A branch conversation's view names its conversation (decision 0013 §1); the home conversation's names none.
  const { conversation } = useSearch({ strict: false }) as { readonly conversation?: string }
  const { data: view } = useLiveQuery(queries.shownIn(conversation))
  return (
    <main className="view-screen" aria-label="View">
      <header className="view-screen-header">
        <Button asChild variant="ghost"><Link to="/app">{BACK_TO_CHAT}</Link></Button>
      </header>
      {view === undefined ? null : view.template === "webpage" ? (
        <WebPageView url={pageOf(view).url} size="full" preview={previewOf(view)} />
      ) : view.template === "docs" ? (
        <DocsPageView url={pageOf(view).url} title={pageOf(view).title ?? ""}
          text={pageOf(view).text ?? ""} truncated={pageOf(view).truncated === true}
          size="full" headingLevel={1} />
      ) : (
        <div className="view-screen-body">
          <AgentView view={view} size="full" conversationId={conversation} />
        </div>
      )}
    </main>
  )
}
