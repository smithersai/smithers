import { Link, useNavigate } from "@tanstack/react-router"
import { BACK_TO_CHAT } from "../contract"
import type { Minimized } from "../minimize"
import { plainClick } from "./ConversationView"
import { useViews } from "./ViewsContext"

// A repository's page and its issues page are the full-screen size of a view in the chat (ruling FE-9): their Back to
// chat minimizes them, as every full-screen page's link goes back to the chat. A plain click returns to the page the
// view was opened from, or leaves `target` in the home conversation and goes to the chat (src/features/views/minimize.ts);
// without a target yet, or with a modifier, it is a plain link to the chat.
export function BackToChat({ target }: { readonly target: Minimized | undefined }) {
  const views = useViews()
  const navigate = useNavigate()
  return (
    <Link
      to="/app"
      className="back-to-chat"
      onClick={(event) => {
        if (target === undefined || !plainClick(event)) return
        event.preventDefault()
        void navigate({ href: views.actions.minimize(target) })
      }}
    >
      {BACK_TO_CHAT}
    </Link>
  )
}
