/** @jsxImportSource react */
import {
  useEffect,
  useId,
  useRef,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "../button";
import { cn } from "@smthrs/ui-css";
import { type Collaborator, CollaboratorCarets, type FieldSelection, selectionOf, useSharedSelection } from "../collaborators";
import type { DataAttributes } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";
import { type ChatComposerCompletions, clampHighlight, CompletionList, completionOptionId } from "./CompletionList";

/** Mirrors the PromptInput lifecycle (minus "error"): busy is submitted|streaming. */
export type ChatComposerStatus = "ready" | "streaming" | "submitted";

/** Matches the 160px max-height on .sui-chat-composer-input in uiCss. */
const COMPOSER_INPUT_MAX_HEIGHT = 160;

/** Mirrors PromptInput's `submit-failed`: `onSubmit` threw or its promise rejected. */
export type ChatComposerError = { code: "submit-failed"; cause: unknown; };

export type ChatComposerProps = Omit<ComponentProps<"form">, "onSubmit" | "onError" | "onSelect"> & {
  value: string;
  /** The person typed: the new value, and where their selection is in it. */
  onValueChange: (value: string, selection: FieldSelection) => void;
  onSubmit: (value: string) => void | Promise<void>;
  /** Receives a thrown or rejected `onSubmit`. Without it the cause goes to `globalThis.reportError`. The draft is never touched. */
  onError?: (error: ChatComposerError) => void;
  placeholder?: string;
  /** Lifecycle state, mirroring PromptInput: while submitted|streaming the composer is busy, submission is blocked, and a Stop button appears when `onStop` is set. */
  lifecycleStatus?: ChatComposerStatus;
  /** Hosts with live steering can admit input while generation continues. */
  submitWhileBusy?: boolean;
  /** Stop the in-flight generation; renders a Stop button next to Send while busy. */
  onStop?: () => void;
  /** Free-form status line in the composer toolbar (announced via aria-live). */
  statusText?: ReactNode;
  actions?: ReactNode;
  disabled?: boolean;
  /** Fix the glass composer above the viewport bottom, matching Multi chat. */
  docked?: boolean;
  inputAriaLabel?: string;
  submitLabel?: string;
  /** Visible content for the Send button. */
  sendLabel?: ReactNode;
  /** Visible content for the Stop button. Strings also customize its accessible name. */
  stopLabel?: ReactNode;
  /*
   * Pass-through attributes for the two buttons this component renders on the
   * host's behalf.
   *
   * A host whose affordances must name the act behind them — a `data-flow`
   * binding, an analytics id, a test hook — otherwise has to reach into this
   * component's rendered DOM from outside, which is the exact coupling a
   * pass-through prop exists to prevent.
   * Anything set here wins over this component's own attribute of the same
   * name, so a host can also correct one.
   */
  /** Extra attributes for the Send button. */
  submitProps?: ComponentProps<"button"> & DataAttributes;
  /** Extra attributes for the Stop button. */
  stopProps?: ComponentProps<"button"> & DataAttributes;
  textareaProps?: Omit<ComponentProps<"textarea">, "value" | "onChange" | "disabled" | "placeholder"> & DataAttributes;
  /**
   * What to list above the input while typing, such as slash commands. Controlled: the host keeps the rows and the
   * highlight. While it has rows, the input points at the list (`aria-controls`, `aria-activedescendant`),
   * ArrowDown and ArrowUp move the highlight, Enter accepts, Tab completes and Escape dismisses, all before the
   * composer's own Enter and Escape.
   */
  completions?: ChatComposerCompletions;
  /**
   * A draft several people type at once: everyone else's carets, drawn over the input in their colors and flagged with
   * their names. Set it, even empty, to edit together.
   */
  collaborators?: ReadonlyArray<Collaborator>;
  /** Where this person's selection now is, after someone else's typing changed `value`. */
  selection?: FieldSelection;
  /** The person moved their caret or selection. */
  onSelectionChange?: (selection: FieldSelection) => void;
  /** Shows the draft without letting the person change or send it, as for someone who may only view it. */
  readOnly?: boolean;
};

/** Controlled glass chat composer. Enter submits and Shift+Enter inserts a line. */
export function ChatComposer({
  value,
  onValueChange,
  onSubmit,
  onError,
  placeholder = "Message Smithers…",
  lifecycleStatus = "ready",
  submitWhileBusy = false,
  onStop,
  statusText,
  actions,
  disabled = false,
  docked = false,
  inputAriaLabel = "Chat message",
  submitLabel = "Send message",
  sendLabel = "↑",
  stopLabel = "■",
  submitProps,
  stopProps,
  textareaProps,
  completions,
  collaborators,
  selection,
  onSelectionChange,
  readOnly = false,
  className,
  ...props
}: ChatComposerProps) {
  useInjectUiCss();
  const listId = `${useId()}-completions`;
  const listed = !readOnly && completions !== undefined && completions.items.length > 0 ? completions : undefined;
  const highlighted = listed === undefined ? 0 : clampHighlight(listed.highlighted, listed.items.length);
  const busy = lifecycleStatus === "submitted" || lifecycleStatus === "streaming";
  const canSubmit = !disabled && !readOnly && (!busy || submitWhileBusy) && value.trim().length > 0;
  const stopAccessibleLabel = typeof stopLabel === "string" && stopLabel !== "■" ? stopLabel : "Stop generating";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const typed = useSharedSelection(textareaRef, value, selection);

  const autogrow = (element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_INPUT_MAX_HEIGHT)}px`;
  };

  const setTextareaRef = (element: HTMLTextAreaElement | null) => {
    textareaRef.current = element;
    const ref = textareaProps?.ref;
    if (typeof ref === "function") ref(element);
    else if (ref) (ref as RefObject<HTMLTextAreaElement | null>).current = element;
  };

  // External value changes (cleared after submit, restored drafts) resize too.
  useEffect(() => {
    if (textareaRef.current) autogrow(textareaRef.current);
  }, [value]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextValue = value.trim();
    if (!nextValue || disabled || readOnly || (busy && !submitWhileBusy)) return;
    // The host owns the draft, so a failure only reports; it never clears.
    const fail = (cause: unknown) => {
      if (onError) onError({ code: "submit-failed", cause });
      else globalThis.reportError?.(cause);
    };
    try {
      void Promise.resolve(onSubmit(nextValue)).catch(fail);
    } catch (cause) {
      fail(cause);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    textareaProps?.onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (listed !== undefined && completionKey(event, listed, highlighted)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && busy && onStop) {
      onStop();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const input = (
    <textarea
      aria-autocomplete={readOnly || completions === undefined ? undefined : "list"}
      aria-haspopup={readOnly || completions === undefined ? undefined : "listbox"}
      aria-controls={listed === undefined ? undefined : listId}
      aria-activedescendant={listed === undefined ? undefined : completionOptionId(listId, highlighted)}
      {...textareaProps}
      ref={setTextareaRef}
      className={cn("sui-chat-composer-input", textareaProps?.className)}
      aria-label={textareaProps?.["aria-label"] ?? inputAriaLabel}
      rows={textareaProps?.rows ?? 1}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      onChange={(event) => {
        autogrow(event.currentTarget);
        typed(event.currentTarget.value);
        onValueChange(event.currentTarget.value, selectionOf(event.currentTarget));
      }}
      onSelect={(event) => {
        textareaProps?.onSelect?.(event);
        onSelectionChange?.(selectionOf(event.currentTarget));
      }}
      onKeyDown={onKeyDown}
    />
  );

  return (
    <form
      data-slot="chat-composer"
      data-docked={docked ? "true" : "false"}
      data-status={lifecycleStatus}
      className={cn("sui-chat-composer", className)}
      onSubmit={submit}
      {...props}
    >
      {listed === undefined ? null : <CompletionList id={listId} completions={listed} />}
      {collaborators === undefined ? input : (
        <div className="sui-collaborative-field">
          {input}
          <CollaboratorCarets field={textareaRef} value={value} collaborators={collaborators} />
        </div>
      )}
      <div className="sui-chat-composer-toolbar">
        <div className="sui-chat-composer-status" aria-live="polite">
          {statusText}
        </div>
        <div className="sui-chat-composer-actions">
          {actions}
          {busy && onStop ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="sui-chat-composer-stop"
              aria-label={stopAccessibleLabel}
              title={stopAccessibleLabel}
              onClick={onStop}
              {...stopProps}
            >
              <span aria-hidden="true">{stopLabel}</span>
            </Button>
          ) : null}
          {readOnly ? null : (
            <Button
              type="submit"
              variant="solid"
              size="icon"
              className="sui-chat-composer-send"
              aria-label={submitLabel}
              title={submitLabel}
              disabled={!canSubmit}
              {...submitProps}
            >
              <span aria-hidden="true">{sendLabel}</span>
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

/**
 * The keys the listed completions own: ArrowDown and ArrowUp move the highlight (wrapping), Enter accepts the
 * highlighted row, Tab completes it, Escape dismisses the list. Answers whether the key was theirs. Shift+Enter keeps
 * inserting a line, Shift+Tab keeps moving focus back, and a key held with a modifier stays the host's.
 */
const completionKey = (
  event: ReactKeyboardEvent<HTMLTextAreaElement>,
  completions: ChatComposerCompletions,
  highlighted: number,
): boolean => {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  const count = completions.items.length;
  switch (event.key) {
    case "ArrowDown":
      completions.onHighlight((highlighted + 1) % count);
      return true;
    case "ArrowUp":
      completions.onHighlight((highlighted - 1 + count) % count);
      return true;
    case "Enter":
      if (event.shiftKey) return false;
      completions.onChoose(highlighted, "accept");
      return true;
    case "Tab":
      if (event.shiftKey) return false;
      completions.onChoose(highlighted, "complete");
      return true;
    case "Escape":
      completions.onDismiss();
      return true;
    default:
      return false;
  }
};
