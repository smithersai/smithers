import { ModelStep, FlowEngineLike } from '@smthrs/agent'
import { Action, RetryPolicy } from '@smthrs/flow'
import { Cell } from '@smthrs/harness'
// This production binding is exposed only as a public subpath, not the root.
import * as QuickJSSandbox from '@smthrs/harness/QuickJSSandbox'
import { Model, ModelEvent, ModelRequest, Pricing } from '@smthrs/model'
import { Clock, Effect, Option, Exit, Cause, Schema } from 'effect'

const once = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 1 })
export const canonical = value => JSON.stringify(normalize(value))
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])]))
  return value
}
const params = ModelRequest.GenerationParams.make({ reasoningEffort: 'low' })
export const prompts = {
  cell: 'Solve the task using JavaScript in a persistent QuickJS realm. Reply only with executable JavaScript, without Markdown. No filesystem, imports, Date or Math.random. Read the input with await ctx.call("records", {}). It returns {records, owners}. Print intermediate data with console.log for the next turn. Submit the requested JSON object with ctx.done(object). Top-level declarations persist across turns. You have at most six turns.',
  tool: 'Solve the task using native function tools. Read the input with records({}); it returns {records, owners}. Submit the requested JSON object with submit({answer: object}). You have at most six turns.'
}
export const tools = [
  ModelRequest.ToolDefinition.make({ name: 'records', description: 'Read the task input: {records, owners}.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }),
  ModelRequest.ToolDefinition.make({ name: 'submit', description: 'Submit the requested JSON object.', parameters: { type: 'object', properties: { answer: { type: 'object', additionalProperties: true } }, required: ['answer'], additionalProperties: false } })
]
export function errorReceipt(error) {
  return { code: typeof error?.code === 'string' ? error.code : 'harness', message: typeof error?.message === 'string' ? error.message : String(error), ...(error?.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) }
}
export function failureOutcome(error) {
  return (error.code === 'invalid_request' && /not supported|not found/i.test(error.message)) || ['authentication', 'permission_denied', 'quota_exceeded', 'rate_limited', 'model_not_found'].includes(error.code) || [401,402,403,404,429].includes(error.httpStatus) ? 'access_failure' : 'model_failure'
}
export const readRecords = (task, arm, ordinal) => Action.make({
  name: 'cell-comparison/records', tier: 'sealed', success: Schema.Json,
  idempotencyKey: `${task.id}/${arm}/records/${ordinal}`, retryPolicy: once,
  execute: Effect.succeed(task.data)
})
export function measure(task, arm, config) {
  return Effect.scoped(Effect.gen(function*() {
    const start = yield* Clock.currentTimeMillis
    const model = yield* Model.Model
    const row = { task: task.id, seed: task.seed, family: task.family, arm, taskHash: config.taskHash, model: config.model, cohort: config.cohort, maxTurns: config.maxTurns, executionId: config.executionId, startedAt: new Date(start).toISOString(), elapsedMs: 0, outcome: 'turn_limit', turns: [], calls: [] }
    const messages = [ModelRequest.Message.user(task.instruction)]
    const realm = arm === 'cell' ? yield* Effect.flatMap(QuickJSSandbox.make, s => s.openRealm({ flows: { records: new Cell.FlowProjection({ name: 'records', description: 'Read task input: {records, owners}. Input: {}.', capabilities: [], tier: 'sealed', placement: Option.none(), input: Option.none() }) } })) : null
    let ordinal = 0
    const read = () => Effect.gen(function*() {
      const callOrdinal = ordinal++
      const value = yield* readRecords(task, arm, callOrdinal)
      row.calls.push({ ordinal: callOrdinal, name: 'records', input: {}, value })
      return value
    })
    for (let turn = 0; turn < config.maxTurns; turn++) {
      const request = ModelRequest.ModelRequest.make({ modelId: config.model, system: [ModelRequest.SystemPart.make({ text: prompts[arm] })], messages: [...messages], tools: arm === 'tool' ? tools : [], params, cacheKey: config.executionId })
      const at = yield* Clock.currentTimeMillis
      const receipt = { turn, request, events: [], usage: {}, cost: null }
      row.turns.push(receipt)
      const result = yield* ModelStep.run({ name: `cell-comparison/${task.id}/${arm}/model/${turn}`, request, model, route: FlowEngineLike.routeResolver(config.route), retryPolicy: once, onEvent: event => Effect.sync(() => { receipt.events.push(event) }) }).pipe(Effect.exit)
      receipt.elapsedMs = (yield* Clock.currentTimeMillis) - at
      if (Exit.isSuccess(result)) receipt.events = result.value.events
      const folded = ModelEvent.settledMessage(receipt.events)
      receipt.usage = folded.usage
      receipt.cost = Pricing.cost(folded.usage, config.model, { at }) ?? null
      if (Exit.isFailure(result)) {
        receipt.error = errorReceipt(Cause.squash(result.cause))
        row.outcome = failureOutcome(receipt.error)
        break
      }
      receipt.replayed = result.value.replayed
      if (result.value.error !== undefined) {
        receipt.error = errorReceipt(result.value.error)
        row.outcome = failureOutcome(receipt.error)
        break
      }
      messages.push(folded.message)
      if (arm === 'cell') {
        const code = folded.message.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
        const frame = yield* realm.evaluate({ cell: Cell.source(code), frame: turn, call: invocation => invocation.flow === 'records' && canonical(invocation.input) === '{}' ? read().pipe(Effect.map(value => new Cell.CallResult({ outcome: 'success', value }))) : Effect.succeed(new Cell.CallResult({ outcome: 'failure', error: { code: 'invalid_input', message: 'Only records({}) is available.', hint: 'Call records with an empty object.' } })) }).pipe(Effect.exit)
        if (Exit.isFailure(frame)) {
          receipt.cellError = errorReceipt(Cause.squash(frame.cause))
          row.outcome = 'cell_failure'
          break
        }
        receipt.frame = frame.value
        const outcome = frame.value.outcome
        if (outcome._tag === 'settled' && outcome.transition._tag === 'complete') {
          row.output = outcome.transition.value ?? JSON.parse(outcome.transition.output)
          row.outcome = canonical(row.output) === canonical(task.expected) ? 'correct' : 'wrong'
          break
        }
        messages.push(ModelRequest.Message.user(`Cell observation: ${JSON.stringify(frame.value)}`))
      } else {
        const calls = folded.message.content.filter(p => p.type === 'tool-call')
        const results = []
        let submitted = false
        for (const call of calls) {
          let value
          try {
            const input = JSON.parse(call.arguments)
            if (call.name === 'records' && canonical(input) === '{}') value = yield* read()
            else if (call.name === 'submit' && input !== null && typeof input === 'object' && Object.keys(input).length === 1 && input.answer !== null && typeof input.answer === 'object' && !Array.isArray(input.answer)) {
              row.output = input.answer
              value = yield* Action.make({ name: 'cell-comparison/submit', tier: 'sealed', success: Schema.Json, idempotencyKey: `${task.id}/${arm}/submit/${ordinal++}`, retryPolicy: once, execute: Effect.succeed(input.answer) })
              row.calls.push({ name: 'submit', input, value })
              row.outcome = canonical(row.output) === canonical(task.expected) ? 'correct' : 'wrong'
              submitted = true
            } else value = { error: 'Use records({}) or submit({answer: object}).' }
          } catch (error) { value = { error: 'Invalid tool arguments: JSON required.' } }
          results.push(ModelRequest.ToolResultPart.make({ toolCallId: call.id, content: JSON.stringify(value) }))
          if (submitted) break
        }
        if (submitted) break
        messages.push(results.length ? ModelRequest.Message.tool(results) : ModelRequest.Message.user('Use the records and submit tools to solve the task.'))
      }
    }
    row.elapsedMs = (yield* Clock.currentTimeMillis) - start
    return JSON.parse(JSON.stringify(row))
  }))
}
