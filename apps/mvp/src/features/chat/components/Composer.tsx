import { Button, ChatComposer } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useChat } from "../../../AppContext"
import { useBranch } from "../../branch/components/BranchContext"
import { promptOf } from "../../coedit/view"
import { useCommands } from "../../commands/components/CommandsContext"
import { MAX_QUESTION_LENGTH } from "../contract"

const SHORTCUT = "Meta+K Control+K"

// The composer when open, docked at the foot of the window unless its page gives it a place (`docked={false}`, a
// branch's conversation column); the Chat ⌘K button when hidden. It always sends: a question asked while an answer
// streams, or offline, queues behind it. Typing `/` lists the slash commands this person may run
// (docs/features/slash-commands.md); the commands layer decides what the line does. The draft is this person's own,
// kept on this device, except on a branch its owner shared, where it is the branch's prompt
// (docs/features/coedit.md#the-prompt): everyone else typing it shows as a caret with their name, and `readOnly`, for
// someone who may only view the branch, shows it without letting them change or send it.
export function Composer({ docked = true, readOnly = false }: { readonly docked?: boolean; readonly readOnly?: boolean } = {}) {
  const { queries, actions } = useChat()
  const commands = useCommands()
  const { coedit } = useBranch()
  const { data: composer } = useLiveQuery(queries.composer)
  const { data: menu } = useLiveQuery(commands.queries.menu)
  const { data: texts } = useLiveQuery(coedit.queries.texts)
  const prompt = promptOf(texts)
  if (readOnly) {
    return (
      <ChatComposer
        docked={docked}
        value={prompt?.text ?? ""}
        onValueChange={() => {}}
        onSubmit={() => {}}
        readOnly
        collaborators={prompt?.collaborators ?? []}
        placeholder="Message Smithers"
        inputAriaLabel="Message Smithers"
      />
    )
  }
  if (composer?.open !== true) {
    return (
      <Button variant="outline" aria-keyshortcuts={SHORTCUT} data-draft={(prompt === undefined ? composer?.saved !== false : prompt.stored) ? "saved" : "unsaved"} onClick={() => actions.openComposer("button")}>
        Chat <kbd>⌘K</kbd>
      </Button>
    )
  }
  return (
    <ChatComposer
      docked={docked}
      value={composer.draft}
      onValueChange={commands.actions.type}
      onSubmit={commands.actions.submit}
      collaborators={prompt?.collaborators ?? []}
      selection={prompt?.selection ?? undefined}
      onSelectionChange={prompt === undefined ? undefined : (selection) => coedit.actions.select(prompt.id, selection)}
      completions={{
        label: menu?.label ?? "",
        items: menu?.items ?? [],
        highlighted: menu?.highlighted ?? 0,
        onHighlight: commands.actions.highlight,
        onChoose: commands.actions.choose,
        onDismiss: commands.actions.dismiss,
      }}
      statusText={menu?.refusal ?? (composer.draft.length === 0 ? null : `${composer.draft.length}/${MAX_QUESTION_LENGTH}`)}
      lifecycleStatus="ready"
      placeholder="Message Smithers"
      inputAriaLabel="Message Smithers"
      textareaProps={{
        onKeyDown: (event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
            !event.nativeEvent.isComposing && menu?.kind === "commands" && menu.items.length > 0) {
            event.preventDefault()
            commands.actions.choose(menu.highlighted, "accept", true)
          }
        },
        ref: (element) => {
          // The opening action owns this request. Remounting a route does not
          // request focus, even when Suspense has left it on the document body.
          if (element !== null && actions.takeComposerFocus()) element.focus()
        },
        "data-draft": (prompt === undefined ? composer.saved : prompt.stored) ? "saved" : "unsaved",
      }}
      actions={
        <Button variant="ghost" size="sm" aria-keyshortcuts={SHORTCUT} onClick={actions.closeComposer}>
          Hide <kbd>⌘K</kbd>
        </Button>
      }
    />
  )
}
