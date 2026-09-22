import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NodeServices } from '@effect/platform-node'
import * as Discovery from '@smthrs/registry/Discovery'
import { Effect, Layer } from 'effect'

/** The registry's own scan of an installed canary repository. */
const scan = root =>
  Effect.runPromise(
    Effect.gen(function*() {
      return yield* (yield* Discovery.Discovery).scan({ source: 'project', root: join(root, 'flows'), naming: 'path' })
    }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provideMerge(NodeServices.layer))))
  )

test('canary setup installs self-contained coding declarations and checks real documentation requirements', { timeout: 300_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'canary-coding-setup-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const output = join(temporary, 'artifact'), root = join(temporary, 'repo')
  execFileSync(process.execPath, [fileURLToPath(new URL('./canary-coding-setup.mjs', import.meta.url)), output], { stdio: 'pipe' })
  await mkdir(root)
  const initial = '# canary-sandbox\n\nSmithers Cloud canary fixture repo.\n'
  await writeFile(join(root, 'README.md'), initial)
  execFileSync('bash', [join(output, 'setup.sh')], { cwd: root, stdio: 'pipe' })
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), initial, 'setup never edits the task file')
  // Each installed module IS the flow its door declares: one tagged
  // `@smthrs/flow` declaration carrying its own body, evaluated here from the
  // installed bytes with nothing else on disk to resolve against.
  for (
    const [path, tag] of [['flow.ts', 'coding/ImplementPlan'], ['implementation/flow.ts', 'coding/ImplementAtoms'],
      ['request/flow.ts', 'coding/Request'], ['vibe/flow.ts', 'coding/Vibe']]
  ) {
    const declaration = (await import(pathToFileURL(join(root, 'flows/coding', path)).href)).default
    assert.equal(declaration._tag, tag)
    assert.ok(declaration.payloadSchema && declaration.successSchema, `${tag} states both schemas`)
    assert.equal(typeof declaration.body, 'function', `${tag} carries its own body`)
    assert.equal(declaration.flows, undefined, `${tag} names no delegate`)
  }
  // And the registry reads the same thing from the installed tree: four coding
  // doors that delegate to nothing, and the three checks that still do.
  const found = await scan(root)
  assert.deepEqual(found.entries.map(entry => [entry.name, [...entry.flows]]), [
    ['checks/fast', ['coding/CommandCheck']],
    ['checks/slow', ['coding/CommandCheck']],
    ['checks/wiki', ['coding/WikiCheck']],
    ['coding', []],
    ['coding/implementation', []],
    ['coding/request', []],
    ['coding/vibe', []]
  ])
  assert.deepEqual(found.warnings.map(warning => warning.code), ['unprojectable_authority', 'unprojectable_authority', 'unprojectable_authority'])
  const check = tier => spawnSync('python3', [join(output, tier + '.py')], { cwd: root, encoding: 'utf8' })
  assert.notEqual(check('fast').status, 0, 'unchanged fixture must fail the new task requirement')
  await writeFile(join(root, 'README.md'), initial + '\n## Purpose\n\nA disposable fixture for production testing of Smithers.\n')
  assert.equal(check('fast').status, 0)
  assert.equal(check('slow').status, 0)
  await writeFile(join(root, 'README.md'), initial + '\n[Broken link](missing.md)\n')
  assert.notEqual(check('slow').status, 0, 'broken source links must fail')
  await writeFile(join(root, 'flows/checks/fast/flow.mdx'), 'existing user flow')
  const retry = spawnSync('bash', [join(output, 'setup.sh')], { cwd: root, encoding: 'utf8' })
  assert.notEqual(retry.status, 0, 'setup cannot replace different existing flow source')
  assert.equal(await readFile(join(root, 'flows/checks/fast/flow.mdx'), 'utf8'), 'existing user flow')
})
