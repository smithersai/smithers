import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FlowEngine } from '@smthrs/engine'
import { Flow, FlowRuntime } from '@smthrs/flow'
import { Node } from '@smthrs/plan'
import { NodeHost } from '@smthrs/platform-node'
import { Model, ModelError, Route } from '@smthrs/model'
import { Cell } from '@smthrs/harness'
import * as QuickJSSandbox from '@smthrs/harness/QuickJSSandbox'
import { Effect, Layer, Redacted, Result, Schema, Stream } from 'effect'
import { readFileSync } from 'node:fs'
import { canonical, errorReceipt, failureOutcome, measure, readRecords } from './measure.mjs'

const tasks = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url))).tasks
const route = Result.getOrThrow(Route.openai({ apiKey: Redacted.make('not-used-by-faulty-service') }))
const flow = Flow.make('cell-comparison/fault-test', { payload: {}, success: Schema.Json, body: Node.capture({}, () => Node.succeed(null)) })
const drive = body => Effect.scoped(Effect.gen(function*() {
  const engine = yield* FlowRuntime.FlowRuntime
  yield* engine.register(flow, () => body)
  return yield* flow.execute({}, { executionId: 'fault-test' })
})).pipe(Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeHost.NodeCrypto.layer)), Effect.runPromise)

test('faulty Effect model records authentication and transport failures once in either arm', async () => {
  for (const arm of ['cell','tool']) {
    for (const code of ['authentication','transport']) {
      let calls = 0
      const faulty = { stream: () => { calls++; return Stream.fail(new ModelError.ModelError({ code, message: 'Injected service failure' })) } }
      const row = await drive(measure(tasks[0], arm, { taskHash: 'fixed', model: 'fault-injection', cohort: 'test', maxTurns: 6, route, executionId: 'fault-test' }).pipe(Effect.provideService(Model.Model, faulty)))
      assert.equal(calls, 1)
      assert.equal(row.outcome, code === 'authentication' ? 'access_failure' : 'model_failure')
      assert.equal(row.turns.length, 1)
      assert.equal(row.turns[0].error.code, code)
      assert.equal(row.turns[0].cost, null)
      assert.equal(row.calls.length, 0)
    }
  }
})
test('independent corpus answers agree with production QuickJS execution and recorded reads for all 50 tasks', async () => {
  const programs = {
    filter: 'ctx.done({ids:d.records.filter(r=>r.active && r.value>=40).map(r=>r.id).sort()})',
    group: 'const a={a:0,b:0,c:0}; for(const r of d.records) if(r.active) a[r.group]+=r.value; ctx.done(a)',
    deduplicate: 'const latest={}; for(const r of d.records) if(!latest[r.sku] || latest[r.sku].revision<r.revision) latest[r.sku]=r; ctx.done({ids:Object.values(latest).filter(r=>r.active).map(r=>r.id).sort()})',
    join: 'const a={Ada:0,Bo:0,Cy:0}; for(const r of d.records) if(r.active) a[d.owners[r.group]]+=r.value; ctx.done(a)',
    tags: 'const seen={}; for(const r of d.records) if(r.active) for(const t of r.tags.split(",")) if(t.trim()) seen[t.trim().toLowerCase()]=true; ctx.done({tags:Object.keys(seen).sort()})'
  }
  const result = await drive(Effect.scoped(Effect.gen(function*() {
    const sandbox = yield* QuickJSSandbox.make
    for (const task of tasks) {
      const realm = yield* sandbox.openRealm({ flows: {} })
      const value = yield* readRecords(task, 'cell', 0)
      const frame = yield* realm.evaluate({ cell: Cell.source(`const d=${JSON.stringify(value)}; ${programs[task.family]}`), frame: 0, call: () => Effect.die('No external calls in oracle check') })
      assert.equal(frame.outcome._tag, 'settled')
      assert.equal(frame.outcome.transition._tag, 'complete')
      assert.equal(canonical(frame.outcome.transition.value ?? JSON.parse(frame.outcome.transition.output)), canonical(task.expected))
    }
    return { checked: tasks.length }
  })))
  assert.equal(result.checked, 50)
})
test('canonical objects preserve array ordering; error classification distinguishes unavailable models', () => {
  assert.equal(canonical({ b:2, a:[{z:null,y:true}] }), canonical({ a:[{y:true,z:null}], b:2 }))
  assert.notEqual(canonical([1,2]), canonical([2,1]))
  assert.equal(failureOutcome({code:'invalid_request',message:'Model is not supported'}), 'access_failure')
  assert.equal(failureOutcome({code:'invalid_request',message:'Schema invalid'}), 'model_failure')
  assert.equal(failureOutcome({code:'other',httpStatus:403}), 'access_failure')
  assert.deepEqual(errorReceipt('broken'), { code:'harness',message:'broken' })
  assert.deepEqual(errorReceipt({code:'authentication',message:'denied',httpStatus:401}), {code:'authentication',message:'denied',httpStatus:401})
})
