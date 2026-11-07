/** @jsxImportSource react */
import { type ComponentProps, type FormEvent, useId } from "react";
import { Button } from "../button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../card";
import { cn } from "@smthrs/ui-css";
import { Input, Textarea } from "../input";
import { Field, Label } from "../label";
import { useInjectUiCss } from "../styles";
import {
  answersToSend,
  type DraftCheck,
  type DraftFile,
  type DraftQuestion,
  type DraftStatus,
  draftStatusLine,
  isAssumed,
  questionValue,
} from "./flowDraft";

export type FlowDraftViewProps = Omit<ComponentProps<"section">, "children" | "onSubmit"> & {
  /** Where the flow goes: `Mine`, or `owner/repo`. */
  where: string;
  name: string;
  request: string;
  /** `null` before the first round: the form. */
  status: DraftStatus | null;
  round: number;
  questions: ReadonlyArray<DraftQuestion>;
  /** The person's unsent answers by question id; the app keeps them. */
  answers: Readonly<Record<string, string>>;
  files: ReadonlyArray<DraftFile>;
  checks: ReadonlyArray<DraftCheck>;
  /** Why the draft failed, in a few words. */
  failure?: string | null;
  /** Short validation message shown beside an invalid name. */
  nameHint?: string;
  /** Short validation message shown beside an invalid request. */
  requestHint?: string;
  onNameChange?: (name: string) => void;
  onRequestChange?: (request: string) => void;
  /** `Draft`, shown before the first round; off while the request is empty. */
  onStart?: () => void;
  onAnswerChange?: (id: string, value: string) => void;
  /**
   * `Answer`: sends `answersToSend`; on while there is one to send: an answer
   * that changes what the draft holds, or a blocking question's shown value.
   */
  onAnswer?: () => void;
  /** `Draft again`: another round of the same request; hidden without it. */
  onRetry?: () => void;
  /** `Delete`: deletes the draft; hidden without it. */
  onDelete?: () => void;
  /** `Save`; hidden without it. */
  onSave?: () => void;
  saveDisabled?: boolean;
  /** `Try`; hidden without it. */
  onTry?: () => void;
  /** `Propose`; hidden without it. */
  onPropose?: () => void;
};

/**
 * A flow being written: where it goes, its name and what it should do (inputs
 * until the first round starts), the round's status, its questions with the
 * defaults it assumed, the drafted files, the static checks, and Draft,
 * Answer, Draft again, Try, Save, Propose and Delete. Controlled throughout.
 */
export function FlowDraftView({
  where,
  name,
  request,
  status,
  round,
  questions,
  answers,
  files,
  checks,
  failure,
  nameHint,
  requestHint,
  onNameChange,
  onRequestChange,
  onStart,
  onAnswerChange,
  onAnswer,
  onRetry,
  onDelete,
  onSave,
  saveDisabled = false,
  onTry,
  onPropose,
  className,
  ...props
}: FlowDraftViewProps) {
  useInjectUiCss();
  const id = useId();
  const editing = status === null;
  const start = (event: FormEvent) => {
    event.preventDefault();
    if (request.trim() !== "") onStart?.();
  };
  const answerable = answersToSend(questions, answers).length > 0;
  return (
    <Card
      data-slot="flow-draft-view"
      data-status={status ?? "new"}
      aria-labelledby={`${id}-title`}
      className={cn("sui-flow-draft", className)}
      {...props}
    >
      <CardHeader className="sui-flow-draft-header">
        <CardTitle id={`${id}-title`}>New flow</CardTitle>
        <span role="status" aria-live="polite" className="sui-flow-draft-status" data-status={status ?? "new"}>
          {status === null ? null : draftStatusLine(status, round)}
        </span>
      </CardHeader>
      <CardContent className="sui-flow-draft-body">
        <form id={`${id}-form`} className="sui-flow-draft-fields" onSubmit={start}>
          <div className="sui-flow-draft-row">
            <span className="sui-flow-draft-key">Where</span>
            <span className="sui-flow-draft-where">{where}</span>
          </div>
          {editing ? (
            <>
              <Field>
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={nameHint === undefined ? undefined : true}
                  aria-describedby={nameHint === undefined ? undefined : `${id}-name-hint`}
                  onChange={(event) => onNameChange?.(event.currentTarget.value)}
                />
                {nameHint === undefined ? null : <span id={`${id}-name-hint`} className="sui-flow-draft-hint">{nameHint}</span>}
              </Field>
              <Field>
                <Label htmlFor={`${id}-request`}>What it should do</Label>
                <Textarea
                  id={`${id}-request`}
                  value={request}
                  aria-invalid={requestHint === undefined ? undefined : true}
                  aria-describedby={requestHint === undefined ? undefined : `${id}-request-hint`}
                  onChange={(event) => onRequestChange?.(event.currentTarget.value)}
                />
                {requestHint === undefined ? null : <span id={`${id}-request-hint`} className="sui-flow-draft-hint">{requestHint}</span>}
              </Field>
            </>
          ) : (
            <>
              <div className="sui-flow-draft-row">
                <span className="sui-flow-draft-key">Name</span>
                <span className="sui-flow-draft-name">{name}</span>
              </div>
              <div className="sui-flow-draft-row">
                <span className="sui-flow-draft-key">What</span>
                <span className="sui-flow-draft-request">{request}</span>
              </div>
            </>
          )}
        </form>
        {questions.length === 0 ? null : (
          <ul className="sui-flow-draft-questions" aria-label="Questions">
            {questions.map((question) => {
              const field = `${id}-q-${question.id}`;
              const assumed = isAssumed(question, answers);
              return (
                <li key={question.id} className="sui-flow-draft-question" data-blocking={question.blocking ? "true" : undefined}>
                  <label htmlFor={field} className="sui-flow-draft-question-text">
                    {question.text}
                  </label>
                  <Input
                    id={field}
                    value={questionValue(question, answers)}
                    onChange={(event) => onAnswerChange?.(question.id, event.currentTarget.value)}
                  />
                  {question.blocking && question.answer === undefined ? (
                    <span className="sui-flow-draft-tag" data-tone="needs_you">
                      Needs you
                    </span>
                  ) : assumed ? (
                    <span className="sui-flow-draft-tag">assumed</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {files.map((file) => (
          <details key={file.path} className="sui-flow-draft-file" data-path={file.path}>
            <summary className="sui-flow-draft-file-path">{file.path}</summary>
            <pre className="sui-flow-draft-file-text">{file.text}</pre>
          </details>
        ))}
        {checks.length === 0 ? null : (
          <ul className="sui-flow-draft-checks" aria-label="Checks">
            {checks.map((check) => (
              <li key={check.check} className="sui-flow-draft-check" data-ok={check.ok ? "true" : "false"}>
                <span aria-hidden>{check.ok ? "✓" : "✕"}</span> {check.check}
                {!check.ok && check.code !== undefined ? <span className="sui-flow-draft-code"> · {check.code}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {failure === undefined || failure === null ? null : (
          <p className="sui-flow-draft-failure">
            <span aria-hidden>✕</span> {failure}
          </p>
        )}
      </CardContent>
      <CardFooter className="sui-flow-draft-actions">
        {editing && onStart !== undefined ? (
          <Button type="submit" form={`${id}-form`} disabled={request.trim() === ""}>
            Draft
          </Button>
        ) : null}
        {!editing && questions.length > 0 && onAnswer !== undefined ? (
          <Button variant="outline" disabled={!answerable} onClick={onAnswer}>
            Answer
          </Button>
        ) : null}
        {onRetry === undefined ? null : (
          <Button variant="outline" onClick={onRetry}>
            Draft again
          </Button>
        )}
        {onTry === undefined ? null : (
          <Button variant="outline" onClick={onTry}>
            Try
          </Button>
        )}
        {onSave === undefined ? null : (
          <Button disabled={saveDisabled} onClick={onSave}>
            Save
          </Button>
        )}
        {onPropose === undefined ? null : (
          <Button variant="outline" onClick={onPropose}>
            Propose
          </Button>
        )}
        {onDelete === undefined ? null : (
          <Button variant="ghost" onClick={onDelete}>
            Delete
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
