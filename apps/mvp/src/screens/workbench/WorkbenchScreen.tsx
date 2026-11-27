import { PageBody } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { exampleForkOf } from "../../features/repo/exampleForks"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { useRepo, useRepoAnswer } from "../../features/repo/components/RepoContext"
import { ROUTE_PATHS } from "../../routePaths"
import type { KeyboardEvent } from "react"
import {
  parseWorkbenchSearch,
  reduceWorkbenchLayout,
  serializeWorkbenchSearch,
  workbenchShortcutAction,
  type WorkbenchAction,
} from "../../features/workbench/layout"
import { effectivePaneSize } from "../../features/workbench/conversationState"
import { branchPath } from "../../features/conversations/contract"
import { roleToAudience } from "../../features/workbench/store.vibe"
import { useWorkbenchOptional } from "../../features/workbench/WorkbenchContext"
import { playgroundPresetFor } from "../../features/workbench/playgroundBridge"
import { WorkbenchShell } from "../../features/workbench/WorkbenchShell"
import "./workbench-screen.css"

const searchRecordFromParams = (params: URLSearchParams): Record<string, string> => {
  const record: Record<string, string> = {}
  for (const [key, value] of params.entries()) {
    record[key] = value
  }
  return record
}

const PLAN_ERROR_COPY: Record<string, string> = {
  sign_in_required: "Sign in to load the plan tree for this repository.",
  forbidden: "Repository members can inspect this plan tree.",
  timeout: "Plan tree request timed out. Reload to try again.",
  unavailable: "Plan tree is unavailable right now.",
}

export function WorkbenchScreen() {
  const { owner, repo } = useParams({ from: ROUTE_PATHS.workbench })
  const search = useSearch({ from: ROUTE_PATHS.workbench }) as Record<string, unknown>
  const navigate = useNavigate()
  const { queries: repoQueries } = useRepo()
  const { data: repoData } = useLiveQuery(repoQueries.view)
  const answer = useRepoAnswer(owner, repo)
  const workbench = useWorkbenchOptional()
  const maxRole = roleToAudience(answer?.role)
  const repoSlug = `${owner}/${repo}`
  const rawLayout = workbench !== null
    ? workbench.actions.restoreConversation(repoSlug, search, maxRole).layout
    : parseWorkbenchSearch(search, maxRole)
  const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth
  const layout = { ...rawLayout, size: effectivePaneSize(rawLayout.size, viewportWidth) }
  const branch = repoData?.repository?.defaultBranch ?? "main"
  const fork = exampleForkOf(owner, repo)
  const playgroundPreset = playgroundPresetFor(repoSlug)

  const handleDispatch = (action: WorkbenchAction) => {
    const next = reduceWorkbenchLayout(layout, action)
    workbench?.actions.saveConversation(repoSlug, next)
    const serialized = serializeWorkbenchSearch(next, maxRole)
    void navigate({
      to: ROUTE_PATHS.workbench,
      params: { owner, repo },
      search: searchRecordFromParams(serialized),
      replace: true,
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>, totalFrames: number) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const action = workbenchShortcutAction(
      {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.nativeEvent.isComposing,
        ...(target !== null ? { targetTag: target.tagName, targetEditable: target.isContentEditable } : {}),
      },
      layout,
      totalFrames,
    )
    if (action !== null) {
      event.preventDefault()
      handleDispatch(action)
    }
  }

  return (
    <main className="workbench-screen" aria-label="Workbench">
      <RepoHeader />
      <PageBody width="wide">
        <div className="workbench-screen-body">
          {workbench === null ? (
            <div onKeyDown={(event) => handleKeyDown(event, 1)}>
            <WorkbenchShell
              repoSlug={`${owner}/${repo}`}
              layout={layout}
              maxRole={maxRole}
              onDispatch={handleDispatch}
              totalFrames={1}
              {...(fork !== undefined ? { fork } : {})}
              planNodes={[]}
              attachHref={branchPath(`${owner}/${repo}`, branch) + "#attach-agent"}
            />
            </div>
          ) : (
            <WorkbenchBound
              owner={owner}
              repo={repo}
              branch={branch}
              maxRole={maxRole}
              layout={layout}
              fork={fork}
              onDispatch={handleDispatch}
              onKeyDown={handleKeyDown}
              workbench={workbench}
            />
          )}
        </div>
      </PageBody>
    </main>
  )
}

function WorkbenchBound({
  owner,
  repo,
  branch,
  maxRole,
  layout,
  fork,
  onDispatch,
  onKeyDown,
  workbench,
}: {
  readonly owner: string
  readonly repo: string
  readonly branch: string
  readonly maxRole: ReturnType<typeof roleToAudience>
  readonly layout: ReturnType<typeof parseWorkbenchSearch>
  readonly fork: ReturnType<typeof exampleForkOf>
  readonly onDispatch: (action: WorkbenchAction) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>, totalFrames: number) => void
  readonly workbench: NonNullable<ReturnType<typeof useWorkbenchOptional>>
}) {
  const { data: plan } = useLiveQuery(workbench.queries.plan)
  const { data: waitlist } = useLiveQuery(workbench.queries.waitlist)
  const planError =
    plan?.status === "failed" && plan.error !== null ? (PLAN_ERROR_COPY[plan.error] ?? PLAN_ERROR_COPY.unavailable) : null

  const totalFrames = plan?.totalFrames ?? 1
  return (
    <div onKeyDown={(event) => onKeyDown(event, totalFrames)}>
      {planError !== null ? (
        <p className="workbench-screen-status" role="status">
          {planError}
        </p>
      ) : null}
      <WorkbenchShell
        repoSlug={`${owner}/${repo}`}
        layout={layout}
        maxRole={maxRole}
        onDispatch={onDispatch}
        totalFrames={totalFrames}
        {...(fork !== undefined ? { fork } : {})}
        {...(playgroundPresetFor(`${owner}/${repo}`) !== undefined ? { playground: { preset: playgroundPresetFor(`${owner}/${repo}`)! } } : {})}
        planNodes={plan?.nodes ?? []}
        attachHref={branchPath(`${owner}/${repo}`, branch) + "#attach-agent"}
        waitlist={{
          repoUrl: waitlist?.repoUrl ?? `https://github.com/${owner}/${repo}`,
          workflowNote: waitlist?.workflowNote ?? "",
          status: waitlist?.status ?? "idle",
          ...(waitlist?.position !== null && waitlist?.position !== undefined ? { position: waitlist.position } : {}),
          ...(waitlist?.errorMessage !== null && waitlist?.errorMessage !== undefined ? { errorMessage: waitlist.errorMessage } : {}),
          onRepoUrlChange: (value) => workbench.actions.setWaitlistRepoUrl(value),
          onWorkflowNoteChange: (value) => workbench.actions.setWaitlistWorkflowNote(value),
          onSubmit: () => void workbench.actions.submitWaitlist(),
        }}
      />
    </div>
  )
}
