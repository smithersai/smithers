/** Repository automation boundary. Host IO is injected through Effect services. */
import { Effect, FileSystem, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { join, resolve, sep } from 'node:path'
import { workspacePackages } from '../../../../packages/repo-targets/scripts/workspace-packages.mjs'
import { buildInventory, matrix, sha256, summarize } from './campaign.mjs'
import { renderReport } from './report.mjs'

const parse = text => Effect.try(() => JSON.parse(text))

export const readJson = path => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* parse(yield* fs.readFileString(path))
})

/** Fixed read-only jj commands, checked for actual process completion. */
export const jjRead = (root, args) => Effect.scoped(Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make('jj', args, { cwd: root, stdin: 'ignore' }))
  const text = yield* Stream.runFold(child.stdout, () => '', (text, bytes) => text + new TextDecoder().decode(bytes))
  const exitCode = yield* child.exitCode
  if (exitCode !== 0) return yield* Effect.fail(new Error('jj discovery failed'))
  return text
}))

/** Inventory all tracked source, binding test/configuration and transitive inputs by digest. */
export const discover = root => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = (yield* jjRead(root, ['file', 'list'])).trim().split('\n')
  const members = yield* Effect.try(() => workspacePackages(root))
  const targets = yield* readJson(join(root, '.smithers/target-index.json'))
  const extra = [...new Set([...targets.map(target => target.package), ...paths.filter(path => path.endsWith('/Cargo.toml') && !/(?:^|\/)(?:test|tests|fixtures)(?:\/|$)/.test(path)).map(path => path.slice(0, -11))])]
  for (const dir of extra) {
    if (dir && !members.some(member => member.dir === dir)) members.push({ dir, name: dir, manifest: {} })
  }
  const files = yield* Effect.forEach(paths.filter(path => !path.startsWith('.smithers/flows/test/coverage-campaign/')), path => Effect.gen(function*() {
    const bytes = yield* fs.readFile(join(root, path))
    const text = /\.(?:[cm]?[jt]sx?|vibe|rs|c|cpp|h|json|toml|yaml|yml)$/.test(path) ? new TextDecoder().decode(bytes) : ''
    return { path, text, sha256: sha256(bytes) }
  }), { concurrency: 8 })
  const inventory = buildInventory({ members, files, targets })
  return { inventory, sourceBaseCommit: (yield* jjRead(root, ['log', '--no-graph', '-r', 'fork_point(@ | main@origin)', '-T', 'commit_id'])).trim() }
})

/** Read real artifacts and reject path traversal or symlink escape from the ledger directory. */
export const readArtifacts = (directory, receipts) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const canonical = yield* fs.realPath(directory)
  const hashes = {}
  for (const receipt of receipts) {
    for (const artifact of receipt.artifacts ?? []) {
      if (typeof artifact.path !== 'string' || artifact.path.startsWith('/') || artifact.path.includes('\\') || artifact.path.split('/').includes('..')) return yield* Effect.fail(new Error('unsafe artifact path'))
      const path = yield* fs.realPath(resolve(canonical, artifact.path))
      if (!path.startsWith(canonical + sep)) return yield* Effect.fail(new Error('artifact escapes ledger directory'))
      hashes[artifact.path] = sha256(yield* fs.readFile(path))
    }
  }
  return hashes
})

/** Status describes gaps; only gate mode asks whether every required cell has passed. */
export const inspect = (inventory, ledger, directory) => Effect.gen(function*() {
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.receipts)) return yield* Effect.fail(new Error('unsupported receipt ledger'))
  const hashes = yield* readArtifacts(directory, ledger.receipts)
  return yield* Effect.try(() => summarize(inventory, ledger.receipts, hashes))
})

export const writeSnapshot = (directory, snapshot) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(join(directory, 'surfaces'), { recursive: true })
  yield* fs.makeDirectory(join(directory, 'inputs'), { recursive: true })
  const surfaces = []
  for (const surface of snapshot.inventory.surfaces) {
    const artifact = 'surfaces/' + encodeURIComponent(surface.id) + '.json'
    yield* fs.writeFileString(join(directory, artifact), JSON.stringify(surface, null, 2) + '\n')
    surfaces.push({ id: surface.id, name: surface.name, artifact })
  }
  const inputFiles = []
  for (let index = 0; index < snapshot.inventory.inputFiles.length; index += 1000) {
    const artifact = 'inputs/' + index + '.json'
    yield* fs.writeFileString(join(directory, artifact), JSON.stringify(snapshot.inventory.inputFiles.slice(index, index + 1000), null, 2) + '\n')
    inputFiles.push({ artifact })
  }
  yield* fs.writeFileString(join(directory, 'report.html'), renderReport(snapshot.inventory))
  const inventory = { ...snapshot.inventory, surfaces, inputFiles }
  yield* fs.writeFileString(join(directory, 'inventory.json'), JSON.stringify({ ...snapshot, inventory }, null, 2) + '\n')
  yield* fs.writeFileString(join(directory, 'matrix.json'), JSON.stringify(matrix(snapshot.inventory), null, 2) + '\n')
})
