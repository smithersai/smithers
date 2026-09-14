import { Button } from "@smthrs/ui"
import type { KeyboardEvent } from "react"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { flowArgs } from "../flows/FlowArgs"

/*
 * THE FORM LAW (apps/app/AGENTS.md; docs/workbench-lanes/flow-forms.md): the
 * one form card every flow shares. Its fields derive from the flow's input
 * schema, its options come from the seams (controller/forms.ts), and its
 * draft IS the card payload: a field commits through `form.set` on every
 * input event (the DOM keeps in-flight editing and focus, never React
 * state), Submit is `form.submit` (the controller assembles the line
 * and runs the flow as whoever asked for it), Cancel is `card.dismiss`.
 * Every act names its flow through onRunCommand. An option the human cannot
 * pick is disabled and carries its reason.
 */

type FlowFormCard = Extract<Card, { kind: "flow-form" }>
type FlowFormField = FlowFormCard["payload"]["fields"][number]

/** A single-line Enter uses the same submission as the button, without interrupting IME input. */
const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
  if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }
}

const blank = (value: string | number | boolean | undefined): boolean =>
  value === undefined || (typeof value === "string" && value.trim() === "")

/** The required fields the draft has not filled (a boolean is answered either way). */
export const unfilled = (payload: FlowFormCard["payload"]): ReadonlyArray<FlowFormField> =>
  payload.fields.filter((field) => field.required && field.kind !== "boolean" && blank(payload.draft[field.name]))

export const FlowFormCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: FlowFormCard
  readonly onRunCommand: RunCommand
}) => {
  const { flow, fields, draft, error } = card.payload
  const settled = card.status === "acted"
  const busy = card.payload.submitting === true
  const commit = (field: string, value: string): void => onRunCommand("form.set", flowArgs("form.set", { cardId: card.id, field, value }))
  const complete = unfilled(card.payload).length === 0
  return (
    <form className="flow-form" data-flow-name={flow} data-via={card.payload.via} onSubmit={(event) => {
      event.preventDefault()
      if (complete && !busy && !settled) onRunCommand("form.submit", card.id)
    }}>
      {fields.map((field) => {
        const value = draft[field.name]
        const text = value === undefined ? "" : String(value)
        const testId = `flow-form-${field.name}`
        const listId = `flow-form-options-${card.id}-${field.name}`
        const options = field.options ?? []
        return (
          <label key={field.name} className="flow-form-row" data-field={field.name} data-kind={field.kind} data-required={field.required}>
            <span>{field.label}</span>
            {field.kind === "select" && options.length > 0 ?
              (
                <select
                  aria-label={field.label}
                  data-testid={testId}
                  value={text}
                  required={field.required}
                  disabled={settled || busy}
                  onChange={(event) => commit(field.name, event.currentTarget.value)}
                >
                  {/* The unpicked state: a select must be able to say "nothing yet" without inventing a default. */}
                  {options.some((option) => option.value === text) ? null : <option value="">{""}</option>}
                  {options.map((option) => (
                    <option key={option.value} value={option.value} disabled={option.disabled === true} title={option.reason}>
                      {option.disabled === true && option.reason !== undefined ? `${option.label} · ${option.reason}` : option.label}
                    </option>
                  ))}
                </select>
              ) :
              field.kind === "textarea" ?
              <textarea aria-label={field.label}
                data-testid={testId} defaultValue={text} placeholder={field.placeholder} rows={12} required={field.required} disabled={settled || busy}
                onInput={event => commit(field.name, event.currentTarget.value)} /> :
              field.kind === "boolean" ?
              (
                <input
                  type="checkbox"
                  aria-label={field.label}
                  data-testid={testId}
                  checked={value === true}
                  disabled={settled || busy}
                  onChange={(event) => commit(field.name, event.currentTarget.checked ? "true" : "false")}
                />
              ) :
              (
                <>
                  <input
                    type={field.kind === "number" ? "number" : "text"}
                    step={field.kind === "number" ? "any" : undefined}
                    aria-label={field.label}
                    data-testid={testId}
                    defaultValue={text}
                    placeholder={field.placeholder}
                    required={field.required}
                    disabled={settled || busy}
                    list={options.length > 0 ? listId : undefined}
                    onInput={(event) => commit(field.name, event.currentTarget.value)}
                    onKeyDown={submitOnEnter}
                  />
                  {options.length > 0 ?
                    (
                      <datalist id={listId}>
                        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </datalist>
                    ) :
                    null}
                </>
              )}
          </label>
        )
      })}
      {settled ? null : (
        <div className="flow-run-actions">
          <Button variant="ghost" size="sm" data-flow="card.dismiss" data-testid="flow-form-cancel" disabled={busy} onClick={() => onRunCommand("card.dismiss", card.id)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" data-flow="form.submit" data-testid="flow-form-submit" disabled={!complete || busy}>
            {card.payload.submitLabel ?? "Submit"}
          </Button>
        </div>
      )}
      {error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
    </form>
  )
}

export const flowFormCardFamily: CardFamily<"flow-form"> = {
  "flow-form": {
    render: (card, actions) => <FlowFormCardBody card={card} onRunCommand={actions.onRunCommand} />,
    /* A form asks for input; a refusal belongs in its body, never a machine status pill. */
    pill: () => ""
  }
}
