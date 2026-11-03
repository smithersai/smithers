import { TodoDraftCard } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import type { Draft } from "../schema"
import { useTodos } from "./TodosContext"
import { useIssues } from "../../issues/components/IssuesContext"
import { useEngineStopped } from "../../chat/components/useEngineStopped"
import { COMMIT_UNAVAILABLE, COPY_DRAFT } from "../../chat/engineAvailability"
import { issueChoices } from "../view"

// One private draft (decision 0016 §3): its title, the issue it hangs under and its prompt as the person edits them,
// Commit and Discard. A TODO hangs under exactly one issue (decision 0153), so Commit waits until one is chosen from
// the repository's open issues, which the card starts syncing. Commit opens the stack it goes to, where it shows `T–`
// and Requested until the stack numbers it.
export function DraftCard({ draft }: { readonly draft: Draft }) {
  const stopped = useEngineStopped()
  const { queries, actions } = useTodos()
  const issues = useIssues()
  const { data: view } = useLiveQuery(queries.view)
  // Redrawn once the repository's issues are open, which then reads its own rows.
  useLiveQuery(issues.queries.opened)
  const { data: rows } = useLiveQuery(issues.queries.summariesOf(draft.repoId))
  const [owner = "", name = ""] = draft.repo.split("/")
  useEffect(() => {
    void issues.actions.warm(owner, name).catch(() => undefined)
  }, [owner, name])
  const navigate = useNavigate()
  return (
    <>
    {stopped ? <p role="alert">{COMMIT_UNAVAILABLE} {COPY_DRAFT}</p> : null}
    <TodoDraftCard
      id={`todo:${draft.id}`}
      data-draft={draft.id}
      repo={draft.repo}
      {...(draft.issue === undefined ? {} : { source: `#${draft.issue}`, issue: draft.issue })}
      issues={issueChoices(draft.repoId, rows ?? [])}
      onIssueChange={(issue) => actions.setIssue(draft.id, issue)}
      title={draft.title}
      prompt={draft.prompt}
      acceptance={draft.acceptance}
      committing={stopped || view?.committing.includes(draft.id) === true}
      onTitleChange={(title) => actions.setTitle(draft.id, title)}
      onPromptChange={(prompt) => actions.setPrompt(draft.id, prompt)}
      onCommit={async () => {
        const to = await actions.commit(draft.id)
        if (to !== undefined) void navigate({ href: to })
      }}
      onDiscard={() => actions.discardDraft(draft.id)}
    />
    </>
  )
}
