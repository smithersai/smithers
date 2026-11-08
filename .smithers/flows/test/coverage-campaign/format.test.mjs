import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildInventory } from './campaign.mjs'
import { readJson, writeSnapshot } from './io.mjs'

const root = fileURLToPath(new URL('../../../../', import.meta.url))

test('snapshot generators emit surface and input shards accepted by the owning formatter', () => Effect.runPromise(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'campaign-format-' })
    const inventory = buildInventory({
      members: [{ dir: 'demo', name: 'demo', manifest: {} }],
      files: [{ path: 'demo/src/index.ts', text: 'source' }],
      targets: []
    })
    yield* writeSnapshot(directory, { inventory, commit: 'a'.repeat(40) })
    const saved = yield* readJson(join(directory, 'inventory.json'))
    const paths = [saved.inventory.surfaces[0].artifact, saved.inventory.inputFiles[0].artifact].map(path => join(directory, path))
    const command = ChildProcess.make(process.execPath, [
      join(root, '.smithers/flows/node_modules/dprint/bin.cjs'), 'check',
      '--config', join(root, '.smithers/flows/dprint.json'), ...paths
    ], { cwd: root })
    const handle = yield* spawner.spawn(command)
    assert.equal(yield* handle.exitCode, 0, 'regenerating snapshot JSON must preserve the dprint gate')
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
))
