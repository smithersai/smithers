/** @jsxImportSource react */
import {
  useEffect,
  useRef,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "../button";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

/** Mirrors the PromptInput lifecycle (minus "error"): busy is submitted|streaming. */
export type ChatComposerStatus = "ready" | "streaming" | "submitted";

/** Matches the 160px max-height on .sui-chat-composer-input in uiCss. */
const COMPOSER_INPUT_MAX_HEIGHT = 160;

/** Mirrors PromptInput's `submit-failed`: `onSubmit` threw or its promise rejected. */
export type ChatComposerError = { code: "submit-failed"; cause: unknown; };

export type ChatComposerProps = Omit<ComponentProps<"form">, "onSubmit" | "onError"> & {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (value: string) => void | Promise<void>;
  /** Receives a thrown or rejected `onSubmit`. Without it the cause goes to `globalThis.reportError`. The draft is never touched. */
  onError?: (error: ChatComposerError) => void;
  placeholder?: string;
  /** Lifecycle state, mirroring PromptInput: while submitted|streaming the composer is busy, submission is blocked, and a Stop button appears when `onStop` is set. */
  lifecycleStatus?: ChatComposerStatus;
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
   * pass-through prop exists to prevent (LIBRARY-CHANGE-REQUESTS §3).
   * Anything set here wins over this component's own attribute of the same
   * name, so a host can also correct one.
   */
  /** Extra attributes for the Send button. */
  submitProps?: ComponentProps<"button">;
  /** Extra attributes for the Stop button. */
  stopProps?: ComponentProps<"button">;
  textareaProps?: Omit<ComponentProps<"textarea">, "value" | "onChange" | "disabled" | "placeholder">;
};

/** Controlled glass chat composer. Enter submits and Shift+Enter inserts a line. */
export function ChatComposer({
  value,
  onValueChange,
  onSubmit,
  onError,
  placeholder = "Message Smithers…",
  lifecycleStatus = "ready",
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
  className,
  ...props
}: ChatComposerProps) {
  useInjectUiCss();
  const busy = lifecycleStatus === "submitted" || lifecycleStatus === "streaming";
  const canSubmit = !disabled && !busy && value.trim().length > 0;
  const stopAccessibleLabel = typeof stopLabel === "string" && stopLabel !== "■" ? stopLabel : "Stop generating";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
    if (!nextValue || disabled || busy) return;
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
    if (event.key === "Escape" && busy && onStop) {
      onStop();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <form
      data-slot="chat-composer"
      data-docked={docked ? "true" : "false"}
      data-status={lifecycleStatus}
      className={cn("sui-chat-composer", className)}
      onSubmit={submit}
      {...props}
    >
      <textarea
        {...textareaProps}
        ref={setTextareaRef}
        className={cn("sui-chat-composer-input", textareaProps?.className)}
        aria-label={textareaProps?.["aria-label"] ?? inputAriaLabel}
        rows={textareaProps?.rows ?? 1}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          autogrow(event.currentTarget);
          onValueChange(event.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
      />
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
        </div>
      </div>
    </form>
  );
}
