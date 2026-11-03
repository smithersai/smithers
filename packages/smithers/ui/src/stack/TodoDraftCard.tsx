/** @jsxImportSource react */
import { type ComponentProps, type KeyboardEvent, useId } from "react";
import { Badge } from "../badge";
import { Button } from "../button";
import { cn } from "../cn";
import { Input, Textarea } from "../input";
import { isSubmitChord } from "../item-conversation/ItemConversation";
import { Field, Label } from "../label";
import { useInjectUiCss } from "../styles";

/** A draft's acceptance criteria as a short list named `Acceptance criteria`. */
function AcceptanceList({ items }: { readonly items: ReadonlyArray<string> }) {
  const labelId = useId();
  return (
    <div data-slot="todo-acceptance" className="sui-todo-acceptance">
      <span id={labelId} className="sui-todo-acceptance-label">
        Acceptance criteria
      </span>
      <ul aria-labelledby={labelId} className="sui-todo-acceptance-list">
        {items.map((item, index) => <li key={index}>{item}</li>)}
      </ul>
    </div>
  );
}

export type TodoDraftCardProps = Omit<ComponentProps<"form">, "children" | "onSubmit" | "title"> & {
  /** `owner/name`, shown in the header. */
  repo?: string;
  /** Where the draft came from, such as its issue `#12`: a chip in the header. */
  source?: string;
  title: string;
  prompt: string;
  /** Read-only acceptance criteria the agent drafted, if any. */
  acceptance?: ReadonlyArray<string>;
  onTitleChange: (title: string) => void;
  onPromptChange: (prompt: string) => void;
  onCommit: () => void;
  onDiscard: () => void;
  /** Disables Commit while a commit is on its way. */
  committing?: boolean;
  /** Why the stack refused the last commit, as a short chip, such as "Stack full". */
  refused?: string;
  /** The longest title, in characters. Default 120. */
  maxTitleLength?: number;
  /**
   * The issues the TODO may hang under. Given, the card shows an Issue picker and Commit waits until one is chosen: a
   * TODO hangs under exactly one issue.
   */
  issues?: ReadonlyArray<{ readonly number: number; readonly title: string }>;
  /** The chosen issue's number. */
  issue?: number;
  onIssueChange?: (issue: number) => void;
};

/**
 * A private draft of a TODO that the person edits and commits, controlled:
 * the host owns the title and the prompt. The header reads `Draft` and
 * `Only you`. Commit (the button, Enter in the title, ⌘Enter or Ctrl+Enter in
 * the prompt) always prevents the browser's submission and calls `onCommit`
 * only while no commit is on its way, the trimmed title and prompt are
 * non-empty, the title fits `maxTitleLength`, and, given `issues`, an issue
 * is chosen.
 */
export function TodoDraftCard({
  repo,
  source,
  title,
  prompt,
  acceptance,
  onTitleChange,
  onPromptChange,
  onCommit,
  onDiscard,
  committing = false,
  refused,
  maxTitleLength = 120,
  issues,
  issue,
  onIssueChange,
  className,
  ...props
}: TodoDraftCardProps) {
  useInjectUiCss();
  const titleId = useId();
  const promptId = useId();
  const issueId = useId();
  const canCommit = !committing && title.trim() !== "" && prompt.trim() !== "" && title.length <= maxTitleLength &&
    (issues === undefined || issue !== undefined);
  const commit = () => {
    if (canCommit) onCommit();
  };
  return (
    <form
      aria-label="TODO draft"
      data-slot="todo-draft-card"
      className={cn("sui-todo-draft", className)}
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
      {...props}
    >
      <header className="sui-todo-draft-header">
        <span className="sui-todo-draft-name">Draft</span>
        <Badge variant="muted" className="sui-todo-draft-private">
          Only you
        </Badge>
        {source === undefined || source === "" ? null : (
          <Badge variant="outline" className="sui-todo-draft-source">
            {source}
          </Badge>
        )}
        {repo === undefined ? null : <span className="sui-todo-draft-repo">{repo}</span>}
      </header>
      <Field>
        <Label htmlFor={titleId}>Title</Label>
        <Input
          id={titleId}
          value={title}
          maxLength={maxTitleLength}
          onChange={(event) => onTitleChange(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            commit();
          }}
        />
      </Field>
      {issues === undefined ? null : (
        <Field>
          <Label htmlFor={issueId}>Issue</Label>
          <select
            id={issueId}
            className="sui-input sui-todo-draft-issue"
            value={issue === undefined ? "" : String(issue)}
            onChange={(event) => {
              const chosen = Number(event.currentTarget.value);
              if (Number.isInteger(chosen) && chosen > 0) onIssueChange?.(chosen);
            }}
          >
            <option value="">Choose an issue</option>
            {issue !== undefined && !issues.some((each) => each.number === issue)
              ? <option value={String(issue)}>{`#${issue}`}</option>
              : null}
            {issues.map((each) => (
              <option key={each.number} value={String(each.number)}>{`#${each.number} ${each.title}`}</option>
            ))}
          </select>
        </Field>
      )}
      <Field>
        <Label htmlFor={promptId}>Prompt</Label>
        <Textarea
          id={promptId}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (!isSubmitChord(event)) return;
            event.preventDefault();
            commit();
          }}
        />
      </Field>
      {acceptance === undefined || acceptance.length === 0 ? null : <AcceptanceList items={acceptance} />}
      <div className="sui-todo-draft-actions">
        {refused === undefined || refused === "" ? null : (
          <Badge variant="destructive" role="alert" className="sui-todo-draft-refused">
            {refused}
          </Badge>
        )}
        <Button type="submit" disabled={!canCommit}>
          Commit
        </Button>
        <Button variant="ghost" onClick={() => onDiscard()}>
          Discard
        </Button>
      </div>
    </form>
  );
}
