/** @jsxImportSource react */
import { type ComponentProps, type FormEvent, useEffect, useId, useRef } from "react";
import { Button } from "../button";
import { cn } from "@smthrs/ui-css";
import { type Collaborator, CollaboratorCarets, type FieldSelection, selectionOf, useSharedSelection } from "../collaborators";
import { Input } from "../input";
import { useInjectUiCss } from "../styles";
import { AgentStatusPill } from "./AgentStatusPill";

/** What the agent asks for: an answer in words (or one of `options`), or Approve or Deny. */
export type NeedsYouKind = "question" | "approval";

/** An answer: the words or option for a question, `true` (Approve) or `false` (Deny) for an approval. */
export type NeedsYouAnswer = string | boolean;

export type NeedsYouCardProps = Omit<ComponentProps<"div">, "children" | "onChange"> & {
  kind: NeedsYouKind;
  /** The question, in the agent's own words. */
  prompt: string;
  /** Answers the person can pick with one press, for a question. */
  options?: ReadonlyArray<string>;
  /** The field's text: the app keeps the draft. */
  value: string;
  /** The person typed: the new value, and where their selection is in it. */
  onValueChange: (value: string, selection: FieldSelection) => void;
  onAnswer: (answer: NeedsYouAnswer) => void;
  /** The accepted answer: the card collapses to it. */
  answered?: NeedsYouAnswer | undefined;
  /** While an answer is on its way: the controls are disabled. */
  sending?: boolean;
  /** Focuses the field and scrolls the card into view each time it changes, for a toast's or header's Answer. */
  focusRequest?: number | undefined;
  /**
   * Only the controls: no pill, no box, and the prompt only for screen readers, where the question shows already, such
   * as a notification's row.
   */
  compact?: boolean;
  /**
   * An answer the person's devices type at once: the other devices' carets, drawn over the field. Set it, even empty,
   * to edit together.
   */
  collaborators?: ReadonlyArray<Collaborator>;
  /** Where this person's selection now is, after another device's typing changed `value`. */
  selection?: FieldSelection;
  /** The person moved their caret or selection in the field. */
  onSelectionChange?: (selection: FieldSelection) => void;
};

/** How an accepted answer reads. */
export const answerText = (answer: NeedsYouAnswer): string =>
  answer === true ? "Approved" : answer === false ? "Denied" : answer;

/**
 * What the agent needs from the person: its question with a field and the
 * options as buttons, or an approval with Approve and Deny. Controlled: the
 * draft is `value`, and the card answers through `onAnswer`. Once `answered`
 * is set it collapses to that answer.
 */
export function NeedsYouCard({
  kind,
  prompt,
  options,
  value,
  onValueChange,
  onAnswer,
  answered,
  sending = false,
  focusRequest,
  compact = false,
  collaborators,
  selection,
  onSelectionChange,
  className,
  ...props
}: NeedsYouCardProps) {
  useInjectUiCss();
  const promptId = useId();
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const typed = useSharedSelection(field, value, selection);
  const approve = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusRequest === undefined) return;
    card.current?.scrollIntoView?.({ block: "nearest" });
    const target = field.current ?? approve.current;
    target?.focus();
  }, [focusRequest]);

  if (answered !== undefined) {
    return (
      <div
        data-slot="needs-you"
        data-state="answered"
        className={cn("sui-needs-you-answered", className)}
        aria-label="Answered"
        {...props}
      >
        <span className="sui-needs-you-answered-label">
          <span aria-hidden>✓</span> Answered
        </span>
        <span className="sui-needs-you-answer">{answerText(answered)}</span>
      </div>
    );
  }

  const input = (
    <Input
      ref={field}
      className="sui-needs-you-field"
      value={value}
      placeholder="Your answer"
      aria-label="Your answer"
      disabled={sending}
      onChange={(event) => {
        typed(event.currentTarget.value);
        onValueChange(event.currentTarget.value, selectionOf(event.currentTarget));
      }}
      onSelect={(event) => onSelectionChange?.(selectionOf(event.currentTarget))}
    />
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (text !== "" && !sending) onAnswer(text);
  };

  return (
    <div
      ref={card}
      role="group"
      aria-labelledby={promptId}
      data-slot="needs-you"
      data-state="open"
      data-kind={kind}
      data-compact={compact ? "" : undefined}
      className={cn("sui-needs-you", className)}
      {...props}
    >
      {compact ? null : (
        <div>
          <AgentStatusPill state="needs_you" />
        </div>
      )}
      <p id={promptId} className={compact ? "sui-sr-only" : "sui-needs-you-prompt"}>
        {prompt}
      </p>
      {kind === "approval" ? (
        <div className="sui-needs-you-row">
          <Button ref={approve} disabled={sending} onClick={() => onAnswer(true)}>
            Approve
          </Button>
          <Button variant="outline" disabled={sending} onClick={() => onAnswer(false)}>
            Deny
          </Button>
        </div>
      ) : (
        <>
          {options !== undefined && options.length > 0 ? (
            <div className="sui-needs-you-row">
              {options.map((option) => (
                <Button key={option} variant="outline" disabled={sending} onClick={() => onAnswer(option)}>
                  {option}
                </Button>
              ))}
            </div>
          ) : null}
          <form className="sui-needs-you-row" onSubmit={submit}>
            {collaborators === undefined ? input : (
              <div className="sui-collaborative-field sui-needs-you-field">
                {input}
                <CollaboratorCarets field={field} value={value} collaborators={collaborators} />
              </div>
            )}
            <Button type="submit" disabled={sending || value.trim() === ""}>
              Answer
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
