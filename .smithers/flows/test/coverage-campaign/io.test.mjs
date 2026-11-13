import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Stream } from 'effect'
import { ChildProcessSpawner } from 'effect/process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildInventory, sha256 } from './campaign.mjs'
import { discover, inspect, jjRead, readArtifacts, readJson, writeSnapshot } from './io.mjs'

const run = effect => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
const root = fileURLToPath(new URL('../../../../', import.meta.url))

test('snapshot and ledger use real filesystem services and hash the actual artifact bytes', () => run(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'b31-receipts-' })
  const inventory = buildInventory({ members: [], files: [], targets: [] })
  yield* writeSnapshot(directory, { inventory, commit: 'a'.repeat(40) })
  assert.deepEqual((yield* readJson(join(directory, 'inventory.json'))).inventory, inventory)
  const populated = buildInventory({ members: [{ dir: 'demo', name: 'demo', manifest: {} }], files: [{ path: 'demo/src/index.ts', text: 'source' }], targets: [] })
  yield* writeSnapshot(directory, { inventory: populated, commit: 'a'.repeat(40) })
  const saved = yield* readJson(join(directory, 'inventory.json'))
  assert.deepEqual(yield* readJson(join(directory, saved.inventory.surfaces[0].artifact)), populated.surfaces[0])
  assert.deepEqual(yield* readJson(join(directory, saved.inventory.inputFiles[0].artifact)), populated.inputFiles)
  yield* fs.writeFileString(join(directory, 'report.txt'), 'actual bytes')
  const hashes = yield* readArtifacts(directory, [{ artifacts: [{ path: 'report.txt' }] }, {}])
  assert.deepEqual(hashes, { 'report.txt': sha256('actual bytes') })
  assert.equal((yield* inspect(inventory, { schemaVersion: 1, receipts: [] }, directory)).complete, false)
})))

test('malformed JSON, missing artifacts and unsupported ledgers fail instead of emitting a pass', () => run(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'b31-invalid-' })
  yield* fs.writeFileString(join(directory, 'bad.json'), '{')
  assert.equal((yield* Effect.result(readJson(join(directory, 'bad.json'))))._tag, 'Failure')
  assert.equal((yield* Effect.result(readArtifacts(directory, [{ artifacts: [{ path: 'missing' }] }])))._tag, 'Failure')
  assert.equal((yield* Effect.result(inspect({ surfaces: [] }, { schemaVersion: 2 }, directory)))._tag, 'Failure')
})))

test('rejects traversal, absolute paths, backslashes and a real symlink outside the artifact directory', () => run(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'b31-paths-' })
  const outside = yield* fs.makeTempDirectoryScoped({ prefix: 'b31-outside-' })
  yield* fs.writeFileString(join(outside, 'report'), 'outside')
  yield* fs.symlink(join(outside, 'report'), join(directory, 'link'))
  for (const path of [null, '/etc/passwd', '../escape', 'foo\\bar', 'link']) {
    assert.equal((yield* Effect.result(readArtifacts(directory, [{ artifacts: [{ path }] }])))._tag, 'Failure')
  }
})))

test('a faulty Effect filesystem cannot turn a failed read or write into evidence', () => run(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const faulty = { ...fs, readFileString: () => Effect.fail(new Error('read unavailable')), writeFileString: () => Effect.fail(new Error('disk unavailable')) }
  assert.equal((yield* Effect.result(readJson('/failure').pipe(Effect.provideService(FileSystem.FileSystem, faulty))))._tag, 'Failure')
  assert.equal((yield* Effect.result(writeSnapshot('/failure', { inventory: { surfaces: [], inputFiles: [] } }).pipe(Effect.provideService(FileSystem.FileSystem, faulty))))._tag, 'Failure')
})))

test('jj discovery uses the real command boundary and refuses a faulty Effect process service', () => run(Effect.gen(function*() {
  assert.match(yield* jjRead(root, ['--version']), /^jj /)
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  const failed = { ...real, spawn: () => Effect.fail(new Error('process unavailable')) }
  assert.equal((yield* Effect.result(jjRead(root, ['--version']).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failed))))._tag, 'Failure')
  const exitsNonzero = { ...real, spawn: () => Effect.succeed({ stdout: Stream.empty, exitCode: Effect.succeed(1) }) }
  assert.equal((yield* Effect.result(jjRead(root, ['--version']).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, exitsNonzero))))._tag, 'Failure')
})))

test('jj discovery preserves Unicode paths when stdout splits every UTF-8 character', () => run(Effect.gen(function*() {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  const splitBytes = {
    ...real,
    spawn: command => Effect.map(real.spawn(command), child => ({
      ...child,
      stdout: Stream.flatMap(child.stdout, bytes => Stream.fromIterable(Array.from(bytes, byte => Uint8Array.of(byte))))
    }))
  }
  for (const expected of ['', 'packages/demo/src/café.ts\n', 'packages/日本語/src/€-🚀.ts\npackages/demo/src/naïve.ts\n']) {
    const output = jjRead(root, ['log', '--no-graph', '-r', '@', '-T', JSON.stringify(expected)])
      .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, splitBytes))
    assert.equal(yield* output, expected)
  }
})))

test('real repository discovery retains native crates, excludes fixture crates, and binds the tracked tree', () => run(Effect.gen(function*() {
  const snapshot = yield* discover(root)
  assert.match(snapshot.sourceBaseCommit, /^[a-f0-9]{40}$/)
  assert.ok(snapshot.inventory.surfaces.some(s => s.id === 'packages/smithers-ffi'))
  assert.ok(snapshot.inventory.surfaces.some(s => s.id === 'apps/mvp'))
  assert.ok(!snapshot.inventory.surfaces.some(s => s.id.includes('/fixtures/')))
  assert.ok(snapshot.inventory.inputFiles.length > 10000)
})))
