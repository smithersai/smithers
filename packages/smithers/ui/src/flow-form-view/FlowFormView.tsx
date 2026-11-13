/** @jsxImportSource react */
import { type ComponentProps, type FormEvent, useId, useMemo, useRef, useState } from "react";
import { Button } from "../button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../card";
import { cn } from "@smthrs/ui-css";
import {
  declaredInput,
  humanTaskForm,
  type HumanTaskWait,
  type HumanTaskAnswer,
  type ArrayEncoding,
  draftFrom,
  type FieldValue,
  type FormDraft,
  type FormField,
  type FormHints,
  formFieldsFor,
  missingLabels,
  publicFormPayload,
  submissionPayload,
} from "../flow-form";
import { Input } from "../input";
import { Field, Label } from "../label";

/** One submitted form: the submit label as the question's text, and the values by field name. */
export type FlowFormSubmission = {
  readonly text: string;
  readonly data: Readonly<Record<string, string | number | boolean>>;
  /** The `data` keys that came from write-only fields. Route them as secrets; never store or echo them. */
  readonly writeOnly: ReadonlyArray<string>;
};

type SchemaFormProps = Omit<ComponentProps<"section">, "title" | "onSubmit"> & {
  title: string;
  /** The JSON Schema the agent passed: an object schema, or a `{ schema, definitions }` document. */
  schema: unknown;
  submitLabel: string;
  /** The form was answered: every control is disabled, the submitted values show, and there is no submit button. */
  submitted?: boolean;
  /** What was submitted, shown once `submitted`. Write-only fields never show. */
  values?: Readonly<Record<string, unknown>>;
  /** `inline` sits in a message; `full` is a page. Only the density changes. */
  size?: "inline" | "full";
  onSubmit: (submission: FlowFormSubmission) => void;
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The schema as the `{ schema, definitions }` document `declaredInput` reads. */
const documentOf = (schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  if (record(schema.schema) !== undefined) return schema;
  return { schema, definitions: record(schema.$defs) ?? record(schema.definitions) ?? {} };
};

/** Labels from `title`, and write-only controls from `writeOnly: true` or `format: "password"`. */
const hintsOf = (document: Readonly<Record<string, unknown>>): FormHints => {
  const properties = record(record(document.schema)?.properties) ?? {};
  const fields: Record<string, { label?: string; kind?: "write-only" }> = {};
  for (const [name, value] of Object.entries(properties)) {
    const property = record(value) ?? {};
    fields[name] = {
      ...(typeof property.title === "string" && property.title.trim() !== "" ? { label: property.title } : {}),
      ...(property.writeOnly === true || property.format === "password" ? { kind: "write-only" as const } : {}),
    };
  }
  return { fields };
};

/** The schema's fields, or `undefined` when the schema is not an object schema `declaredInput` can read. */
const formOf = (schema: unknown) => {
  const given = record(schema);
  if (given === undefined) return undefined;
  const document = documentOf(given);
  const input = declaredInput(document);
  if (input === undefined) return undefined;
  const fields = formFieldsFor(input, hintsOf(document));
  return fields.length === 0 ? undefined : { input, fields };
};

const primitive = (value: unknown): string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value);

/**
 * The `form` template: a form derived from the JSON Schema an agent passed,
 * through `declaredInput` and `formFieldsFor`. Submitting calls `onSubmit` once
 * with the submit label and the values; a required field left blank blocks it
 * and names the field. Once `submitted`, the form shows what was sent and
 * cannot be sent again. Write-only fields stay in their inputs until submit,
 * never in React state, and never show again.
 */
function SchemaFormView({
  title,
  schema,
  submitLabel,
  submitted = false,
  values = {},
  size = "inline",
  onSubmit,
  className,
  locked = false,
  arrays = "words",
  onPayload,
  hostProblem,
  ...props
}: Omit<SchemaFormProps, "onSubmit"> & {
  onSubmit?: SchemaFormProps["onSubmit"];
  locked?: boolean;
  arrays?: ArrayEncoding;
  onPayload?: (payload: Readonly<Record<string, unknown>>) => string | undefined;
  hostProblem?: string | undefined;
}) {
  const id = useId();
  const form = useMemo(() => formOf(schema), [schema]);
  const fields = form?.fields ?? [];
  const shown = useMemo(() => draftFrom(fields, publicFormPayload(fields, values), arrays), [fields, values, arrays]);
  const [draft, setDraft] = useState<FormDraft>(shown);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const current = submitted ? shown : draft;

  const set = (name: string, value: FieldValue | undefined) => {
    setProblem(undefined);
    setDraft((previous) => {
      const next = { ...previous };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next;
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitted || locked || form === undefined) return;
    const secrets = fields.filter((field) => field.kind === "write-only");
    const secretValues: Record<string, string> = {};
    for (const field of secrets) {
      const input = event.currentTarget.elements.namedItem(field.name) as HTMLInputElement;
      if (input.value !== "") secretValues[field.name] = input.value;
    }
    const missing = [
      ...missingLabels(fields.filter((field) => field.kind !== "write-only"), draft),
      ...secrets.filter((field) => field.required && secretValues[field.name] === undefined).map((field) => field.label),
    ];
    if (missing.length > 0 && onPayload === undefined) {
      setProblem(`Needs: ${missing.join(", ")}`);
      return;
    }
    const submission = submissionPayload(form.input, fields, {}, draft, arrays);
    if ("error" in submission) {
      setProblem(submission.error);
      return;
    }
    if (onPayload !== undefined) {
      const error = secrets.length > 0 ? `${secrets.map((field) => field.label).join(", ")}: use secret names` : onPayload(submission.payload);
      setProblem(error);
      return;
    }
    for (const field of secrets) (event.currentTarget.elements.namedItem(field.name) as HTMLInputElement).value = "";
    const data: Record<string, string | number | boolean> = {};
    for (const [name, value] of Object.entries(submission.payload)) data[name] = primitive(value);
    onSubmit?.({ text: submitLabel, data: { ...data, ...secretValues }, writeOnly: Object.keys(secretValues) });
  };

  const control = (field: FormField) => {
    const controlId = `${id}-${field.name}`;
    const value = current[field.name];
    const common = { id: controlId, name: field.name, disabled: submitted || locked, required: field.required };
    switch (field.kind) {
      case "boolean":
        return (
          <input
            {...common}
            type="checkbox"
            className="sui-flow-form-check"
            checked={value === true}
            onChange={(event) => set(field.name, event.currentTarget.checked)}
          />
        );
      case "select":
        return (
          <select
            {...common}
            className="sui-input sui-flow-form-select"
            value={value === undefined ? "" : String(value)}
            onChange={(event) => set(field.name, event.currentTarget.value === "" ? undefined : event.currentTarget.value)}
          >
            <option value="" />
            {field.options!.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
        );
      case "write-only":
        return <Input {...common} type="password" autoComplete="new-password" spellCheck={false} data-write-only="" />;
      default:
        return (
          <Input
            {...common}
            type={field.kind === "number" ? "number" : "text"}
            value={value === undefined ? "" : String(value)}
            onChange={(event) => set(field.name, event.currentTarget.value === "" && onPayload === undefined ? undefined : event.currentTarget.value)}
          />
        );
    }
  };

  return (
    <Card
      data-slot="flow-form-view"
      data-size={size}
      data-submitted={submitted ? "" : undefined}
      className={cn("sui-flow-form-view", className)}
      {...props}
    >
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {form === undefined ? (
        <CardContent>
          <p role="alert" className="sui-flow-form-problem">
            Form unavailable
          </p>
        </CardContent>
      ) : (
        <form noValidate aria-label={title} className="sui-flow-form" onSubmit={submit}>
          <CardContent className="sui-flow-form-fields">
            {fields.map((field) => (
              <Field key={field.name} data-field={field.name} data-kind={field.kind}>
                <Label htmlFor={`${id}-${field.name}`}>
                  {field.label}
                  {field.required ? <span aria-hidden="true"> *</span> : null}
                </Label>
                {control(field)}
              </Field>
            ))}
          </CardContent>
          {(problem ?? hostProblem) === undefined ? null : (
            <p role="alert" className="sui-flow-form-problem">
              {problem ?? hostProblem}
            </p>
          )}
          {submitted ? null : (
            <CardFooter>
              <Button type="submit" variant="solid" disabled={locked}>
                {submitLabel}
              </Button>
            </CardFooter>
          )}
        </form>
      )}
    </Card>
  );
}


export type FlowFormViewProps = SchemaFormProps | (
  Omit<SchemaFormProps, "schema" | "submitLabel" | "onSubmit" | "submitted" | "values"> & {
    readonly wait: HumanTaskWait;
    readonly submitLabel?: string;
    readonly onAnswer: (answer: HumanTaskAnswer) => void;
  }
);

/** The host owns authorization, submission effects, and persisted settlement. */
export function FlowFormView(props: FlowFormViewProps) {
  if ("wait" in props) return <HumanTaskFormView key={props.wait.token} {...props} />;
  return <SchemaFormView {...props} />;
}

function HumanTaskFormView({ wait, onAnswer, submitLabel = "Answer", ...props }: Extract<FlowFormViewProps, { wait: HumanTaskWait }>) {
  const form = humanTaskForm(wait);
  const [sent, setSent] = useState(false);
  const dispatch = useRef({ state: wait.state, revision: wait.revision, sent: false });
  if (dispatch.current.state !== wait.state || !Object.is(dispatch.current.revision, wait.revision)) {
    dispatch.current = { state: wait.state, revision: wait.revision, sent: false };
    if (sent) setSent(false);
  }
  const open = wait.state === "requested" || wait.state === "failed-submission";
  const pending = open && sent;
  return <SchemaFormView
    {...props}
    schema={form.schema}
    submitLabel={submitLabel}
    submitted={!open && wait.state !== "submitting"}
    locked={!open || pending || !wait.canAnswer || wait.token === ""}
    values={form.values}
    arrays="json"
    hostProblem={wait.error}
    data-state={pending ? "submitting" : wait.state}
    onPayload={payload => {
      if (!open || !wait.canAnswer || wait.token === "" || dispatch.current.sent) return undefined;
      const answer = form.answer(payload);
      if ("error" in answer) return answer.error;
      dispatch.current.sent = true;
      setSent(true);
      onAnswer({ token: wait.token, value: answer.value });
      return undefined;
    }}
  />;
}
