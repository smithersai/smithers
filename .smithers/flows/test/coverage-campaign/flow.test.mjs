import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NodeCrypto } from '@effect/platform-node'
import { FlowEngine } from '@smthrs/engine'
import { Interpreter } from '@smthrs/flow'
import { Effect, Layer } from 'effect'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Campaign, { layer } from './flow.ts'

const runtime = Interpreter.layerWithImplementations(Campaign, layer).pipe(
  Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer)
)

test('real flow records snapshot once per execution and propagates incomplete qualification as failure', async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const payload = { mode: 'snapshot' }
    const options = { executionId: 'b31-campaign-snapshot' }
    yield* Campaign.execute(payload, options)
    const path = fileURLToPath(new URL('./inventory.json', import.meta.url))
    const first = statSync(path).mtimeMs
    yield* Campaign.execute(payload, options)
    assert.equal(statSync(path).mtimeMs, first)
    const failure = yield* Effect.result(Campaign.execute({ mode: 'gate' }, { executionId: 'b31-campaign-gate' }))
    assert.equal(failure._tag, 'Failure')
  }).pipe(Effect.provide(runtime)))
})
