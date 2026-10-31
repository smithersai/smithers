import { useRouterState } from "@tanstack/react-router"
import { floatsBell } from "../contract"
import { Notices } from "./Notices"

// The feed's stack on a page whose own header holds no bell (attention/contract.ts `BELL_ROUTES`): hung under the
// floating bell at the window's top-right, over the page (decision 0137), so a notice never pushes it down. A page
// whose header holds the bell hangs the stack from that header (RepoHeader), and a conversation places its own.
export function PageNotices() {
  const routeId = useRouterState({ select: (state) => state.matches.at(-1)?.routeId })
  return floatsBell(routeId) ? (
    <div className="root-notices">
      <Notices surface="page" />
    </div>
  ) : null
}
