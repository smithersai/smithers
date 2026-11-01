import { PageBody, PageHeader } from "@smthrs/ui"
import { Link } from "@tanstack/react-router"
import { ConversationList } from "../../features/conversations/components/ConversationList"
import "./conversations-screen.css"

// /app/conversations: your conversations, one per branch you opened (docs/features/conversations.md). The root's
// floating bell covers this page (`floatsBell`), so the header carries none of its own.
export function ConversationsScreen() {
  return (
    <main className="conversations-screen" aria-label="Conversations">
      <PageHeader
        className="conversations-screen-header"
        back={<Link to="/app">Back to chat</Link>}
        title="Conversations"
        width="narrow"
      />
      <PageBody width="narrow">
        <ConversationList />
      </PageBody>
    </main>
  )
}
