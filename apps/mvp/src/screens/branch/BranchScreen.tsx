import { useTodos } from "../../features/todos/components/TodosContext"
import { repoId } from "../../features/repo/contract"
import { Card, EmptyState } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useSearch } from "@tanstack/react-router"
import { useAuth } from "../../features/auth/components/AuthContext"
import { ComposerGate } from "../../features/auth/components/ComposerGate"
import { BranchCompare } from "../../features/branch/components/BranchCompare"
import { BranchHeader } from "../../features/branch/components/BranchHeader"
import { useBranch } from "../../features/branch/components/BranchContext"
import { comparesOf } from "../../features/branch/publishView"
import { accessNow, deniedTitleOf, writes } from "../../features/branch/view"
import { Composer } from "../../features/chat/components/Composer"
import { SharedFile } from "../../features/coedit/components/SharedFile"
import { FileTabsBar } from "../../features/files/components/FileTabsBar"
import { HomeTabs } from "../../features/home/components/HomeTabs"
import { Conversation } from "../../features/chat/components/Conversation"
import { NO_MESSAGES } from "../../features/chat/contract"
import { selfAccessOf } from "../../features/presence/view"
import { useRepoAnswer } from "../../features/repo/components/RepoContext"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { RepoPage } from "../../features/repo/components/RepoPage"
import { TerminalPanel } from "../../features/terminal/components/TerminalPanel"
import { Toasts } from "../app/Toasts"
import "./branch-screen.css"

// /$owner/$repo/tree/$ref/$ and, as `BlobScreen`, /$owner/$repo/blob/$ref/$: the repository at a branch, and the branch's workspace once the app tracks it and this
// person may open it (decision 0013 §5). The workspace is two columns: the branch's view, Code or Terminal, beside its
// conversation, with the composer at the conversation's foot: on a branch its owner shared, the branch's prompt, typed
// together by those who may edit it and shown read-only to those who may only view it; else the person's own draft
// (docs/features/coedit.md#the-prompt). Under `?edit`, a file of the
// branch's working copy is in the live editor in Code's place; for someone who may write the branch, a Markdown file's
// own page edits it in place (docs/features/repo.md#the-browser); under `?compare`, once it is published, what it adds
// to its base (docs/features/branch-publish.md#the-branch-page). A branch that isn't shared
// with them, or stops being, says No access where the conversation would be; the code stays as GitHub shows it. The
// route's loader opens the location, the branch, its room and its terminal; this screen only renders what the device
// has.
export function BranchScreen({ homeTabs = false }: { readonly homeTabs?: boolean } = {}) {
  const { queries, presence, publishing } = useBranch()
  const { data: current } = useLiveQuery(queries.current)
  const { data: publication } = useLiveQuery(publishing.queries.publication)
  const { data: todos } = useLiveQuery(useTodos().queries.stack(current ? repoId(current.owner, current.repo) : "").todos)
  const { data: room } = useLiveQuery(presence.queries.room)
  const { data: participants } = useLiveQuery(presence.queries.participants)
  const search = useSearch({ strict: false }) as { readonly terminal?: string; readonly edit?: string; readonly compare?: true }
  const { data: session } = useLiveQuery(useAuth().queries.session)
  const answer = useRepoAnswer(current?.owner ?? "", current?.repo ?? "")
  const access = accessNow(current, room, selfAccessOf(participants))
  const open = access !== undefined && access !== "none"
  const savedConversation = current?.status === "offline" && current.conversationId !== null
  const denied = access === "none" || current?.status === "forbidden"
  // This person may change the branch's files: the live editor for a file, and a Markdown file in place on its page.
  const editsFiles = open && writes(access) && current?.mode === "open"
  return (
    <main className="branch-screen" aria-label="Repository" data-workspace={open || denied || savedConversation ? "true" : "false"}>
      <RepoHeader />
      {/* Offline before tracking answered: the pending view's public chrome until the route opens again online. */}
      {open ? <BranchHeader access={access} /> : current?.status === "offline" ? <BranchHeader access={undefined} pending /> : null}
      <div className="branch-screen-notices"><Toasts surface={open ? "conversation" : "page"} /></div>
      <div className="branch-screen-view">
        {homeTabs ? <HomeTabs active="code" /> : null}
        {open && search.terminal !== undefined
          ? <TerminalPanel canOpen={writes(access) && current?.mode === "open"} />
          : open && search.edit !== undefined && current?.conversationId != null
          ? <SharedFile conversationId={current.conversationId} path={search.edit} readOnly={!writes(access)} />
          : search.compare !== undefined && comparesOf(access, publication)
          ? <BranchCompare />
          : (
            <>
              <FileTabsBar />
              <RepoPage
                editFiles={editsFiles}
                liveMarkdown={editsFiles && current?.conversationId != null ? { conversationId: current.conversationId } : undefined}
              />
            </>
          )}
      </div>
      {denied ? (
        <div className="branch-screen-side">
          <Card className="branch-screen-denied">
            <EmptyState title={deniedTitleOf(session?.status === "signed_in", answer)} />
          </Card>
        </div>
      ) : null}
      {open || savedConversation ? (
        <div className="branch-screen-side">
          <Card className="branch-screen-conversation" aria-label="Conversation">
            <Conversation timelineTodos={todos.filter(todo => todo.branch === current?.name)} timelineRepo={current ? { owner: current.owner, name: current.repo } : undefined} readOnly={savedConversation} empty={<EmptyState title={NO_MESSAGES} />} />
          </Card>
          {open ? <div className="branch-screen-composer">
            {writes(access) ? (
              // Writing the branch means a Member or above on its repository: the gate asks only sign-in and a model.
              <ComposerGate member>
                <Composer docked={false} />
              </ComposerGate>
            ) : <Composer docked={false} readOnly />}
          </div> : null}
        </div>
      ) : null}
    </main>
  )
}

// /$owner/$repo/blob/$ref/$: a file at a branch or commit, in the branch's workspace as its directories are, with the
// repository's Home and Code tabs when it declares a home.
export function BlobScreen() {
  return <BranchScreen homeTabs />
}

/** A routed directory keeps the repository home navigation, as a routed file does. */
export function TreeScreen() {
  return <BranchScreen homeTabs />
}
