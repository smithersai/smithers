/** @jsxImportSource react */
import { type ComponentProps, type KeyboardEvent, useId } from "react";
import { Button } from "../button";
import { cn } from "../cn";
import { Input, Textarea } from "../input";
import { Field, Label } from "../label";
import { useInjectUiCss } from "../styles";
import { isSubmitChord } from "./ItemConversation";

export type IssueFormProps = Omit<ComponentProps<"form">, "children" | "onSubmit"> & {
  title: string;
  body: string;
  onTitle: (text: string) => void;
  onBody: (text: string) => void;
  /** Called with the event prevented. */
  onSubmit: () => void;
  disabled?: boolean;
  /** A closed reason to show under the form, such as "Title is too long". */
  error?: string;
  /** Submit button text; default "Create issue". */
  submitLabel?: string;
};

/**
 * The new-issue form, controlled: a `Title` input and a `Description`
 * textarea, then the submit button. Submit (the button, Enter in the title,
 * ⌘Enter or Ctrl+Enter in either field) always prevents the browser's
 * submission and calls `onSubmit` only while the trimmed title is non-empty
 * and the form isn't `disabled`. `error` shows under the fields as an alert.
 */
export function IssueForm({
  title,
  body,
  onTitle,
  onBody,
  onSubmit,
  disabled = false,
  error,
  submitLabel = "Create issue",
  className,
  ...props
}: IssueFormProps) {
  useInjectUiCss();
  const titleId = useId();
  const bodyId = useId();
  const errorId = useId();
  const canSubmit = !disabled && title.trim() !== "";
  const submit = () => {
    if (canSubmit) onSubmit();
  };
  const chord = (event: KeyboardEvent<HTMLElement>) => {
    if (!isSubmitChord(event)) return;
    event.preventDefault();
    submit();
  };
  const described = error === undefined || error === "" ? undefined : errorId;
  return (
    <form
      data-slot="issue-form"
      className={cn("sui-issue-form", className)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      {...props}
    >
      <Field>
        <Label htmlFor={titleId}>Title</Label>
        <Input
          id={titleId}
          value={title}
          onChange={(event) => onTitle(event.target.value)}
          onKeyDown={chord}
          aria-describedby={described}
        />
      </Field>
      <Field>
        <Label htmlFor={bodyId}>Description</Label>
        <Textarea
          id={bodyId}
          value={body}
          onChange={(event) => onBody(event.target.value)}
          onKeyDown={chord}
          aria-describedby={described}
        />
      </Field>
      {described === undefined ? null : (
        <p id={errorId} role="alert" className="sui-issue-form-error">
          {error}
        </p>
      )}
      <div className="sui-issue-form-actions">
        <Button type="submit" variant="solid" disabled={!canSubmit}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
