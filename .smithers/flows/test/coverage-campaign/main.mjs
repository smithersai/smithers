/** Standalone bootstrap for the durable test/coverage-campaign flow. */
import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { fileURLToPath } from 'node:url'
import { discover, inspect, readJson, writeSnapshot } from './io.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const mode = process.argv[2] ?? 'status'
const program = Effect.gen(function*() {
  if (!['snapshot', 'status', 'gate'].includes(mode)) return yield* Effect.fail(new Error('mode must be snapshot, status or gate'))
  const snapshot = yield* discover(root)
  if (mode === 'snapshot') {
    yield* writeSnapshot(directory, snapshot)
    console.log(JSON.stringify({ inventory: snapshot.inventory.surfaces.length, sourceSha256: snapshot.inventory.sourceSha256, campaignComplete: false }))
    return
  }
  const saved = yield* readJson(fileURLToPath(new URL('./inventory.json', import.meta.url)))
  const ledger = yield* readJson(fileURLToPath(new URL('./ledger.json', import.meta.url)))
  const summary = yield* inspect(snapshot.inventory, ledger, directory)
  const fresh = saved.inventory.sourceSha256 === snapshot.inventory.sourceSha256
  console.log(JSON.stringify({ ...summary, inventoryFresh: fresh }, null, 2))
  if (!fresh || (mode === 'gate' && !summary.complete)) return yield* Effect.fail(new Error('campaign qualification incomplete'))
})
Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer))).catch(() => {
  console.error('Coverage campaign refused; inspect status, ledger integrity and current source. No pass was recorded.')
  process.exitCode = 1
})
