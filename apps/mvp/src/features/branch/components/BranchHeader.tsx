import { Badge } from "@smthrs/ui"
import { Link, useParams, useRouterState, useSearch } from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { PresenceAvatars } from "../../presence/components/PresenceAvatars"
import { ShareButton } from "../../sharing/components/ShareButton"
import type { Access } from "../contract"
import { COMPARE, comparesOf } from "../publishView"
import { statusOf } from "../view"
import { useBranch } from "./BranchContext"
import { PublishControls } from "./PublishControls"

// The branch's chrome (decision 0013 §5): the branch's name and what this person may do on it (`Owner`, `Can edit`,
// `Can view`), everyone on it (this person first), Share for its owner, Publish and Update branch for those who may edit
// it (PublishControls), and its views, Code and Terminal, and Compare once it is published, as tabs that keep the
// location in the URL (`?terminal` opens the terminal, `?compare` the comparison). Tracking can wait offline: the name
// and links remain, with access and presence only once verified. Missing or refused branches have no chrome.
export function BranchHeader({ access, pending = false }: { readonly access: Access | "none" | undefined; readonly pending?: boolean }) {
  const { queries, publishing } = useBranch()
  const { data: current } = useLiveQuery(queries.current)
  const { data: publication } = useLiveQuery(publishing.queries.publication)
  const params = useParams({ strict: false })
  const search = useSearch({ strict: false }) as { readonly terminal?: string; readonly compare?: true }
  const file = useRouterState({ select: (state) => state.matches.at(-1)?.routeId === "/$owner/$repo/blob/$ref/$" })
  if (!pending && (current === undefined || current.status !== "ready" || access === "none")) return null
  const tree = "/$owner/$repo/tree/$ref/$"
  const routeParams = { owner: params.owner ?? "", repo: params.repo ?? "", ref: params.ref ?? "", _splat: params._splat ?? "" }
  // On a file’s page, Code is the file and Terminal opens at its directory.
  const code = file ? "/$owner/$repo/blob/$ref/$" : tree
  const terminalParams = file ? { ...routeParams, _splat: routeParams._splat.split("/").slice(0, -1).join("/") } : routeParams
  const status = statusOf(pending ? undefined : access)
  return (
    <nav className="branch-header" aria-label="Branch">
      <span className="branch-header-name">{pending ? params.ref : current?.name}</span>
      {status === undefined ? null : <Badge variant="muted">{status}</Badge>}
      <span className="branch-header-presence">
        {!pending && access !== undefined ? <><PresenceAvatars /><ShareButton /></> : null}
      </span>
      {pending ? null : <PublishControls access={access} />}
      <span className="branch-header-views">
        {/* Exact, so the router marks only the view that shows: Code's empty search is part of any terminal's. */}
        <Link to={code} params={routeParams} search={{}} activeOptions={{ exact: true }} aria-current={search.terminal === undefined && search.compare === undefined ? "page" : undefined}>
          Code
        </Link>
        <Link to={tree} params={terminalParams} search={{ terminal: "me" }} activeOptions={{ exact: true }} aria-current={search.terminal !== undefined ? "page" : undefined}>
          Terminal
        </Link>
        {!pending && comparesOf(access, publication) ? (
          <Link to={tree} params={terminalParams} search={{ compare: true }} activeOptions={{ exact: true }} aria-current={search.terminal === undefined && search.compare !== undefined ? "page" : undefined}>
            {COMPARE}
          </Link>
        ) : null}
      </span>
    </nav>
  )
}
