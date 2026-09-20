/*
 * The composer for one configured model (the model-call card): the REQUEST is
 * edited, the RESPONSE is read and never typed into. A decision request is
 * one state of typed fields, each drawn by its kind, and a map of typed
 * questions whose kind, wording and options are controls; a generation
 * request is a system prompt, a prompt and two knobs. Every control commits
 * through a flow (state/controller/modelCall.ts), as the flow form does, so
 * the draft is on disk at every keystroke and the agent composes through the
 * same doors. The answer stands beside the question it answered; once the
 * request no longer matches the request it answered, it reads as stale.
 */
import { Button } from "@smthrs/ui"
import { MODEL_CALL_NAME_MAX, MODEL_CALL_STATE_MAX_BYTES, MODEL_CALL_TEXT_MAX, MODEL_FIELD_KINDS, MODEL_QUESTION_TYPES, modelCallProblemOf } from "@smthrs/rpc/ConfiguredModel"
import type { ModelAnswer, ModelCallDraft, ModelQuestion, ModelStateField } from "@smthrs/rpc/ConfiguredModel"
import { flowAction } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"
import type { Card } from "../state/AppState"
import { canonicalStoredJsonValue } from "../state/EventValue"
import { byName, modelCallProblemLine } from "../state/controller/modelCall"
import { modelFailureLine } from "../state/controller/models"
import type { RunCommand } from "./CardFamily"

type ModelCallCard = Extract<Card, { kind: "model-call" }>
type Decision = Extract<ModelCallDraft, { kind: "decision" }>
type Generation = Extract<ModelCallDraft, { kind: "generation" }>
type Answers = Readonly<Record<string, ModelAnswer>>

/** The most a field's text may hold: the wire's bound, so a paste past it is cut where the controller would refuse it. */
const FIELD_MAX = MODEL_CALL_STATE_MAX_BYTES * 4

/** A value as the last edit left it, unless the person is typing in it: replaying a lagging snapshot would drop keystrokes. */
const sync = (text: string) => (node: HTMLInputElement | HTMLTextAreaElement | null): void => {
  if (node === null || node.value === text || node.ownerDocument.activeElement === node) return
  node.value = text
}

/** An answer as its value and its number. No sentence. */
export const modelAnswerLine = (answer: ModelAnswer): string => {
  switch (answer.type) {
    case "boolean": return `${answer.value ? "yes" : "no"} · ${answer.probability.toFixed(2)}`
    case "choice": return `${answer.value} · ${answer.confidence.toFixed(2)}`
    case "score": return `${answer.label} · ${answer.value}`
  }
}

const Field = ({ id, field, onRunCommand }: { readonly id: string; readonly field: ModelStateField; readonly onRunCommand: RunCommand }) => {
  const set = (patch: { kind?: string; value?: string; key?: string }) =>
    onRunCommand("model.state", flowArgs("model.state", { id, key: patch.key ?? field.key, ...(patch.key === undefined ? {} : { was: field.key }), ...(patch.kind === undefined ? {} : { kind: patch.kind }), ...(patch.value === undefined ? {} : { value: patch.value }) }))
  const long = field.kind === "code" || field.kind === "diff" || field.kind === "terminal" || field.kind === "json"
  return (
    <div className="model-call-field" data-field={field.key} data-field-kind={field.kind}>
      <input className="model-call-key" aria-label="Key" defaultValue={field.key} ref={sync(field.key)} spellCheck={false}
        onBlur={(event) => { if (event.currentTarget.value !== field.key) set({ key: event.currentTarget.value }) }} />
      <select aria-label="Kind" value={field.kind} onChange={(event) => set({ kind: event.currentTarget.value })}>
        {MODEL_FIELD_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
      </select>
      {field.kind === "boolean" ?
        <input type="checkbox" aria-label={field.key} checked={field.value === "true"} onChange={(event) => set({ value: event.currentTarget.checked ? "true" : "false" })} /> :
        field.kind === "number" ?
        <input type="number" step="any" aria-label={field.key} defaultValue={field.value} ref={sync(field.value)} onInput={(event) => set({ value: event.currentTarget.value })} /> :
        long ?
        <textarea aria-label={field.key} className="model-call-mono" rows={field.kind === "json" ? 3 : 6} maxLength={FIELD_MAX} defaultValue={field.value} ref={sync(field.value)} spellCheck={false}
          onInput={(event) => set({ value: event.currentTarget.value })} /> :
        <input type="text" aria-label={field.key} className={field.kind === "path" ? "model-call-mono" : undefined} maxLength={FIELD_MAX} defaultValue={field.value} ref={sync(field.value)} spellCheck={field.kind !== "path"}
          onInput={(event) => set({ value: event.currentTarget.value })} />}
      <Button size="sm" variant="ghost" aria-label={`Remove ${field.key}`} {...flowAction(onRunCommand, "model.state", flowArgs("model.state", { id, key: field.key, remove: true }))}>Remove</Button>
    </div>
  )
}

const Criteria = ({ id, question, shape, onRunCommand }: { readonly id: string; readonly question: string; readonly shape: ModelQuestion; readonly onRunCommand: RunCommand }) => {
  if (shape.type === "boolean") {
    const criteria = shape.criteria ?? { true: "", false: "" }
    const set = (side: "true" | "false", text: string) =>
      onRunCommand("model.question", flowArgs("model.question", { id, question, criteria: { ...criteria, [side]: text } }))
    return (
      <div className="model-call-criteria">
        <input type="text" aria-label="True" placeholder="true" maxLength={MODEL_CALL_TEXT_MAX} defaultValue={criteria.true} ref={sync(criteria.true)} onInput={(event) => set("true", event.currentTarget.value)} />
        <input type="text" aria-label="False" placeholder="false" maxLength={MODEL_CALL_TEXT_MAX} defaultValue={criteria.false} ref={sync(criteria.false)} onInput={(event) => set("false", event.currentTarget.value)} />
      </div>
    )
  }
  const names = shape.type === "choice" ? Object.keys(shape.criteria).sort(byName) : shape.criteria
  // The new name is the controller's, never this render's: two quick presses would otherwise name the same option.
  const add = flowArgs("model.option", { id, question })
  return (
    <div className="model-call-criteria" data-options={names.length}>
      {names.map((name) => (
        <div key={name} className="model-call-option" data-option={name}>
          <input type="text" aria-label={shape.type === "choice" ? "Option" : "Rung"} className="model-call-key" maxLength={MODEL_CALL_NAME_MAX} defaultValue={name} ref={sync(name)} spellCheck={false}
            onBlur={(event) => { if (event.currentTarget.value !== name) onRunCommand("model.option", flowArgs("model.option", { id, question, option: event.currentTarget.value, was: name })) }} />
          {shape.type === "choice" ?
            <input type="text" aria-label={`About ${name}`} placeholder="About" maxLength={MODEL_CALL_TEXT_MAX} defaultValue={shape.criteria[name] ?? ""} ref={sync(shape.criteria[name] ?? "")}
              onInput={(event) => onRunCommand("model.option", flowArgs("model.option", { id, question, option: name, about: event.currentTarget.value }))} /> :
            null}
          <Button size="sm" variant="ghost" aria-label={`Remove ${name}`} {...flowAction(onRunCommand, "model.option", flowArgs("model.option", { id, question, option: name, remove: true }))}>Remove</Button>
        </div>
      ))}
      <Button size="sm" variant="outline" data-testid="model-call-option-add" {...flowAction(onRunCommand, "model.option", add)}>{shape.type === "choice" ? "Add option" : "Add rung"}</Button>
    </div>
  )
}

const Question = ({ id, question, shape, answer, onRunCommand }: {
  readonly id: string
  readonly question: string
  readonly shape: ModelQuestion
  readonly answer: ModelAnswer | undefined
  readonly onRunCommand: RunCommand
}) => (
  <div className="model-call-question" data-question={question} data-question-type={shape.type}>
    <div className="model-call-question-head">
      <input className="model-call-key" aria-label="Id" defaultValue={question} ref={sync(question)} spellCheck={false}
        onBlur={(event) => { if (event.currentTarget.value !== question) onRunCommand("model.question", flowArgs("model.question", { id, question: event.currentTarget.value, was: question })) }} />
      <select aria-label={`${question} kind`} value={shape.type} onChange={(event) => onRunCommand("model.question", flowArgs("model.question", { id, question, type: event.currentTarget.value }))}>
        {MODEL_QUESTION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
      </select>
      {answer === undefined ? null : <span className="model-call-answer" data-testid="model-call-answer" data-answer-type={answer.type}>{modelAnswerLine(answer)}</span>}
      <Button size="sm" variant="ghost" aria-label={`Remove ${question}`} {...flowAction(onRunCommand, "model.question", flowArgs("model.question", { id, question, remove: true }))}>Remove</Button>
    </div>
    <textarea aria-label={`${question} question`} placeholder="Question" rows={2} maxLength={MODEL_CALL_TEXT_MAX} defaultValue={shape.instructions} ref={sync(shape.instructions)}
      onInput={(event) => onRunCommand("model.question", flowArgs("model.question", { id, question, instructions: event.currentTarget.value }))} />
    <Criteria id={id} question={question} shape={shape} onRunCommand={onRunCommand} />
  </div>
)

const DecisionBody = ({ id, request, answers, onRunCommand }: { readonly id: string; readonly request: Decision; readonly answers: Answers | undefined; readonly onRunCommand: RunCommand }) => {
  const questions = Object.keys(request.questions).sort(byName)
  return (
    <>
      <section className="model-call-state" aria-label="State" data-testid="model-call-state">
        {request.state.map((field) => <Field key={field.key} id={id} field={field} onRunCommand={onRunCommand} />)}
        <div className="flow-run-actions">
          <Button size="sm" variant="outline" data-testid="model-call-field-add"
            {...flowAction(onRunCommand, "model.state", flowArgs("model.state", { id }))}>Add field</Button>
        </div>
      </section>
      <section className="model-call-questions" aria-label="Questions" data-testid="model-call-questions">
        {questions.map((question) => (
          <Question key={question} id={id} question={question} shape={request.questions[question]!} answer={answers?.[question]} onRunCommand={onRunCommand} />
        ))}
        <div className="flow-run-actions">
          <Button size="sm" variant="outline" data-testid="model-call-question-add" {...flowAction(onRunCommand, "model.question", flowArgs("model.question", { id }))}>Add question</Button>
        </div>
      </section>
    </>
  )
}

const GenerationBody = ({ id, request, text, onRunCommand }: { readonly id: string; readonly request: Generation; readonly text: string | undefined; readonly onRunCommand: RunCommand }) => {
  const set = (patch: Partial<Pick<Generation, "system" | "prompt" | "maxTokens">> & { temperature?: string }) =>
    onRunCommand("model.prompt", flowArgs("model.prompt", { id, ...patch }))
  return (
    <>
      <label className="model-call-row"><span>System</span>
        <textarea aria-label="System" data-testid="model-call-system" rows={3} maxLength={MODEL_CALL_TEXT_MAX} defaultValue={request.system} ref={sync(request.system)} onInput={(event) => set({ system: event.currentTarget.value })} />
      </label>
      <label className="model-call-row"><span>Prompt</span>
        <textarea aria-label="Prompt" data-testid="model-call-prompt" rows={4} maxLength={MODEL_CALL_TEXT_MAX} defaultValue={request.prompt} ref={sync(request.prompt)} onInput={(event) => set({ prompt: event.currentTarget.value })} />
      </label>
      <div className="model-call-knobs">
        <label className="model-call-row"><span>Max tokens</span>
          <input type="number" aria-label="Max tokens" data-testid="model-call-max-tokens" min={1} step={1} defaultValue={String(request.maxTokens)} ref={sync(String(request.maxTokens))}
            onInput={(event) => set({ maxTokens: Number.isInteger(Number(event.currentTarget.value)) && event.currentTarget.value.trim() !== "" ? Number(event.currentTarget.value) : 0 })} />
        </label>
        <label className="model-call-row"><span>Temperature</span>
          <input type="number" aria-label="Temperature" data-testid="model-call-temperature" min={0} max={2} step={0.1} defaultValue={request.temperature === undefined ? "" : String(request.temperature)}
            ref={sync(request.temperature === undefined ? "" : String(request.temperature))}
            onInput={(event) => set({ temperature: event.currentTarget.value })} />
        </label>
      </div>
      {text === undefined ? null : <pre className="model-call-text" data-testid="model-call-text">{text}</pre>}
    </>
  )
}

/** `recall`: the model has a recorded Test to go back to. It is read from the model's live record, never from the card, so a Test after compose shows it without a rewrite. */
export const ModelCallCardBody = ({ card, recall, onRunCommand }: { readonly card: ModelCallCard; readonly recall: boolean; readonly onRunCommand: RunCommand }) => {
  const { model: id, request, response, asking, fixture } = card.payload
  const problem = modelCallProblemOf(request)
  const stale = response !== undefined && canonicalStoredJsonValue(response.request) !== canonicalStoredJsonValue(request)
  const output = response?.result.ok === true ? response.result.output : undefined
  const answers = output?.kind === "decision" ? output.answers : undefined
  return (
    <div className="model-call" data-testid="model-call" data-model={id} data-kind={request.kind} data-stale={stale ? "true" : "false"} data-asking={asking === true ? "true" : undefined}>
      {request.kind === "decision" ?
        <DecisionBody id={id} request={request} answers={answers} onRunCommand={onRunCommand} /> :
        <GenerationBody id={id} request={request} text={output?.kind === "generation" ? output.text : undefined} onRunCommand={onRunCommand} />}
      {problem === undefined ? null : <p className="sui-approval-error model-call-problem" role="alert" data-testid="model-call-problem" data-problem={problem.code}>{modelCallProblemLine(problem)}</p>}
      <div className="model-call-foot">
        <div className="flow-run-actions">
          <Button size="sm" data-testid="model-call-ask" disabled={problem !== undefined || asking === true} {...flowAction(onRunCommand, "model.ask", id)}>{response === undefined ? "Ask" : "Ask again"}</Button>
          {recall ? <Button size="sm" variant="ghost" data-testid="model-call-recall" {...flowAction(onRunCommand, "model.recall", id)}>Last test</Button> : null}
          {answers === undefined ? null : <Button size="sm" variant="ghost" data-testid="model-call-fixture" {...flowAction(onRunCommand, "model.fixture", id)}>Fixture</Button>}
        </div>
        {response === undefined ? null : (
          <span className="model-call-result" data-testid="model-call-result" data-ok={response.result.ok ? "true" : "false"} role={response.result.ok ? undefined : "alert"}>
            <span className="models-dot" aria-hidden="true" />
            {response.result.ok ? `${response.result.latencyMs} ms` : modelFailureLine(response.result.failure)}
          </span>
        )}
      </div>
      {fixture === undefined ? null : (
        <div className="model-call-fixture">
          <pre className="model-call-text" data-testid="model-call-fixture-text">{fixture}</pre>
          <Button size="sm" variant="ghost" aria-label="Copy fixture" {...flowAction(onRunCommand, "chat.copy-message", fixture)}>Copy</Button>
        </div>
      )}
    </div>
  )
}

/** Running while an ask is out; failed while the last answer is a failure; settled otherwise. */
export const modelCallPill = (card: ModelCallCard): string =>
  card.payload.asking === true ? "running" : card.payload.response?.result.ok === false ? "failed" : "done"
