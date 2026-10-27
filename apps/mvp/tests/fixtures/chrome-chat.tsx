import { ChatMessage, ChatTimeline, ChatTranscript, SmithersUiStyles } from "@smthrs/ui"
import { createRoot } from "react-dom/client"
import { PinnedMessage } from "../../src/features/pins/PinnedMessage"

const entries = Array.from({ length: Number(new URL(location.href).searchParams.get("entries") ?? 120) }, (_, index) => ({
  id: `message-${index}`, kind: "ask" as const, state: "failed" as const,
  label: "What is in this repository? · failed",
}))
createRoot(document.getElementById("app")!).render(<>
  <SmithersUiStyles withTheme />
  <main className="app-shell"><div className="app-shell-conversation"><div className="mvp-conversation">
    <PinnedMessage message={{ id: "pin", role: "user", text: "A pinned question.", status: "done", local: 0 }} collapsed={false} onCollapse={() => {}} onUnpin={() => {}} />
    <ChatTranscript rail={<ChatTimeline entries={entries} />}>
      {entries.slice(-32).map(entry => <ChatMessage key={entry.id} id={entry.id} role="user">{entry.label}</ChatMessage>)}
    </ChatTranscript>
  </div></div></main>
</>)
