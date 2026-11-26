import { PageBody, PageHeader, Wordmark } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import { WaitlistPrompt } from "../../features/waitlist/WaitlistPrompt"
import { useWorkbenchOptional } from "../../features/workbench/WorkbenchContext"
import "./waitlist-screen.css"

export function WaitlistScreen() {
  const workbench = useWorkbenchOptional()
  return (
    <main className="waitlist-screen" aria-label="Host a repository">
      <PageHeader
        back={
          <Link to="/" aria-label="Smithers">
            <Wordmark />
          </Link>
        }
        nav={
          <>
            <Link to="/app">Open app</Link>
            <a href="/docs">Docs</a>
          </>
        }
        navLabel="Site"
      />
      <PageBody width="narrow">
        <div className="waitlist-screen-body">
          {workbench === null ? (
            <WaitlistPrompt repoUrl="" status="idle" onRepoUrlChange={() => {}} onSubmit={() => {}} />
          ) : (
            <WaitlistBound workbench={workbench} />
          )}
          <p className="waitlist-screen-note">
            Self-hosting is open to everyone with the local Smithers node CLI.
          </p>
        </div>
      </PageBody>
    </main>
  )
}

function WaitlistBound({ workbench }: { readonly workbench: NonNullable<ReturnType<typeof useWorkbenchOptional>> }) {
  const { data: waitlist } = useLiveQuery(workbench.queries.waitlist)
  return (
    <WaitlistPrompt
      repoUrl={waitlist?.repoUrl ?? ""}
      workflowNote={waitlist?.workflowNote ?? ""}
      status={waitlist?.status ?? "idle"}
      {...(waitlist?.position !== null && waitlist?.position !== undefined ? { position: waitlist.position } : {})}
      {...(waitlist?.errorMessage !== null && waitlist?.errorMessage !== undefined ? { errorMessage: waitlist.errorMessage } : {})}
      onRepoUrlChange={(value) => workbench.actions.setWaitlistRepoUrl(value)}
      onWorkflowNoteChange={(value) => workbench.actions.setWaitlistWorkflowNote(value)}
      onSubmit={() => void workbench.actions.submitWaitlist()}
    />
  )
}
