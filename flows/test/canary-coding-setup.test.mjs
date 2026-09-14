import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

test('canary setup installs self-contained coding declarations and checks real documentation requirements', { timeout: 120_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'canary-coding-setup-test-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const output = join(temporary, 'artifact'), root = join(temporary, 'repo')
  execFileSync(process.execPath, [fileURLToPath(new URL('./canary-coding-setup.mjs', import.meta.url)), output], { stdio: 'pipe' })
  await mkdir(root)
  const initial = '# canary-sandbox\n\nSmithers Cloud canary fixture repo.\n'
  await writeFile(join(root, 'README.md'), initial)
  execFileSync('bash', [join(output, 'setup.sh')], { cwd: root, stdio: 'pipe' })
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), initial, 'setup never edits the task file')
  for (const [path, delegate] of [['flow.ts', 'coding/RunPlan'], ['implementation/flow.ts', 'coding/Implement'], ['request/flow.ts', 'coding/RunRequest']]) {
    const declaration = (await import(pathToFileURL(join(root, 'flows/coding', path)).href)).default
    assert.deepEqual(declaration.flows, [delegate])
    assert.ok(declaration.input && declaration.output)
  }
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
