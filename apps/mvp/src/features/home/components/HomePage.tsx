import { useRepo } from "../../repo/components/RepoContext"
import { isDeploymentRepository } from "../../repo/scope"
import { mayAsk } from "../../auth/contract"
import { RepositoryHome, type RepositoryHomeLive, SegmentedControl, Skeleton } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useChat } from "../../../AppContext"
import { useAuth } from "../../auth/components/AuthContext"
import { useFlowsUi } from "../../flows-ui/components/FlowsUiContext"
import { ISSUES_STREAM } from "../../issues/contract"
import { ACTION_FAILED, VIEW_AS, VIEW_WORDS } from "../contract"
import { draftFor, filesOf, flowsOf, homePageOf, issuesOf, liveKindsOf, offered, runsOf, stackOf } from "../view"
import { useHome } from "./HomeContext"

// `/$owner/$repo`: the repository's own home, or Smithers' curated one, with only the sections the person may see;
// else `tree`, its file tree, under one line when the declared home can't show. While the home is read a skeleton
// holds its place: the route warms the home before it shows the page, so this shows only when that read outlasts the
// navigation's wait.
// A prompt, app or flow button opens the default branch's workspace with its composer open, starting it with the
// button's command when it has one. An action (New branch) runs its flow and opens what it made. The live blocks draw
// the rows this device synced. A person who may see more than one view switches between their own and the lower ones
// (SCOPE-14); a view above theirs never shows.
export function HomePage({ tree }: { readonly tree: ReactNode }) {
  const { queries, actions } = useHome()
  const auth = useAuth()
  const flows = useFlowsUi()
  const chat = useChat()
  const navigate = useNavigate()
  const { data } = useLiveQuery(queries.home)
  const { data: files } = useLiveQuery(queries.files)
  const { data: items } = useLiveQuery(queries.items)
  const { data: syncs } = useLiveQuery(queries.syncs)
  const { data: runs } = useLiveQuery(queries.runs)
  const { data: mine } = useLiveQuery(flows.queries.flows)
  // The stack `open` opened for a `stack` block: a new collection once it opens, which the hook follows.
  const { data: todos } = useLiveQuery(queries.stack(data?.current.stack ?? ""))
  const { data: access } = useLiveQuery(queries.stackAccess)
  const { data: repository } = useLiveQuery(useRepo().queries.view)
  const { data: session } = useLiveQuery(auth.queries.session)
  // The live query's first read: the same skeleton as a home still being read, so the body is never blank.
  if (data === undefined) return <Skeleton className="repo-page-loading" />
  const { current } = data
  const page = homePageOf(current, data.home, data.curated)
  if (page.kind === "loading") return <Skeleton className="repo-page-loading" />
  if (page.kind === "tree") {
    return (
      <>
        {page.notice === null ? null : <p className="home-notice" role="status">{page.notice}</p>}
        {tree}
      </>
    )
  }
  const kinds = liveKindsOf(page)
  const repoId = current.repoId!
  const synced = (syncs ?? []).some((row) => row.repoId === repoId && row.stream === ISSUES_STREAM && row.complete)
  const live: RepositoryHomeLive = {
    ...(kinds.has("issues") ? { issues: issuesOf(items ?? [], current.owner, current.name, repoId, synced) } : {}),
    ...(kinds.has("stack") && current.stack === repoId
      ? { stack: stackOf(todos ?? [], current.owner, current.name, access?.find((row) => row.id === repoId)?.status) }
      : {}),
    ...(kinds.has("runs") ? { runs: runsOf(runs ?? []) } : {}),
    ...(kinds.has("flows") ? { flows: flowsOf(mine ?? []) } : {}),
  }
  const ask = (flow: string | undefined) => {
    const draft = draftFor(flow)
    void navigate({ href: page.askHref }).then(() => {
      if (draft !== undefined) chat.actions.setDraft(draft)
      chat.actions.openComposer("button")
    })
  }
  const run = (flow: string) =>
    void actions.run(flow, session?.login ?? null).then((href) => href === undefined ? undefined : navigate({ href }))
  return (
    <>
    {page.views.length === 0 ? null : (
      <SegmentedControl
        className="home-views"
        size="sm"
        aria-label={VIEW_AS}
        value={page.audience}
        options={page.views.map((view) => ({ value: view, label: VIEW_WORDS[view] }))}
        onValueChange={(value) => {
          const view = page.views.find((each) => each === value)
          if (view !== undefined) actions.view(view)
        }}
      />
    )}
    {current.failure === null ? null : <p className="home-notice" role="status">{ACTION_FAILED}</p>}
    <RepositoryHome
      className="home-page"
      aria-label="Home"
      data-source={page.source}
      data-audience={page.audience}
      sections={page.sections}
      files={filesOf(files ?? [])}
      askHref={session?.status === "signed_in" && mayAsk(session.role) && isDeploymentRepository(current.owner, current.name, repository?.about) ? page.askHref : undefined}
      onAsk={ask}
      offered={offered}
      live={live}
      onNavigate={(href) => void navigate({ href })}
      onRun={run}
      running={current.running}
    />
    </>
  )
}
