import { TodoDraftCard } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate } from "@tanstack/react-router"
import type { Draft } from "../schema"
import { useTodos } from "./TodosContext"
import { useEngineStopped } from "../../chat/components/useEngineStopped"
import { COMMIT_UNAVAILABLE, COPY_DRAFT } from "../../chat/engineAvailability"

// One private draft (decision 0016 §3): its title and prompt as the person edits them, Commit and Discard. Commit
// opens the stack it goes to, where it shows `T–` and Requested until the stack numbers it.
export function DraftCard({ draft }: { readonly draft: Draft }) {
  const stopped = useEngineStopped()
  const { queries, actions } = useTodos()
  const { data: view } = useLiveQuery(queries.view)
  const navigate = useNavigate()
  return (
    <>
    {stopped ? <p role="alert">{COMMIT_UNAVAILABLE} {COPY_DRAFT}</p> : null}
    <TodoDraftCard
      id={`todo:${draft.id}`}
      data-draft={draft.id}
      repo={draft.repo}
      {...(draft.issue === undefined ? {} : { source: `#${draft.issue}` })}
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
