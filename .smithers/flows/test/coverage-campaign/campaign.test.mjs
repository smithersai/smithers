import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildInventory, checkReceipt, matrix, summarize, sha256 } from './campaign.mjs'
import { renderReport } from './report.mjs'

const files = [
  { path: 'packages/demo/src/index.ts', text: 'export const answer = 42' },
  { path: 'packages/demo/test/index.test.ts', text: 'test("answer", () => {})' },
  { path: 'packages/demo/vitest.config.ts', text: 'coverage: { include: ["src/**"], thresholds: { lines: 100 } }' },
  { path: 'apps/mvp/src/features/chat/actions.ts', text: 'export const ask = 1' },
  { path: 'apps/mvp/worker/ChatApi.ts', text: 'export const api = 1' },
  { path: 'apps/app/src/old.ts', text: 'removed' },
  { path: 'packages/backend/old.go', text: 'removed' }
]
const members = [
  { dir: 'packages/demo', name: '@smthrs/demo', manifest: { scripts: { test: 'vitest run', check: 'tsc' }, exports: { '.': './src/index.ts' } } },
  { dir: 'apps/mvp', name: '@smthrs/mvp', manifest: { scripts: { test: 'bash db/test.sh', e2e: 'playwright test' } } }
]
const inventory = () => buildInventory({ members, files, targets: [{ package: 'packages/demo', label: '//packages/demo:test', rule: 'Vitest', kinds: ['test'] }] })
const artifact = { path: 'logs/test.txt', sha256: sha256('actual test output'), kind: 'test-report' }
const hashes = { [artifact.path]: artifact.sha256 }
const receipt = (tier = 'unit', environment = 'node') => ({
  id: 'run-1', surface: 'packages/demo', tier, environment,
  commit: 'a'.repeat(40), sourceSha256: inventory().sourceSha256,
  command: { cwd: 'packages/demo', argv: ['pnpm', 'test'] },
  runtime: { version: 'v26.5.0', platform: 'linux', arch: 'x64' },
  startedAt: '2026-11-05T10:00:00Z', finishedAt: '2026-11-05T10:01:00Z',
  exitCode: 0, outcome: 'passed', tests: { passed: 2, failed: 0, skipped: 0, todo: 0 },
  artifacts: [artifact], dependencies: 'real', limitations: ['Linux only'],
  coverage: { metrics: Object.fromEntries(['statements', 'branches', 'functions', 'lines'].map(k => [k, { total: 2, covered: 2 }])), denominator: ['src/index.ts'], exclusions: [], childProcesses: 'none' }
})
const verify = r => checkReceipt(r, inventory(), hashes)

test('retains live packages and every MVP production area while excluding removed architecture', () => {
  const x = inventory()
  assert.deepEqual(x.surfaces.map(x => x.id), ['apps/mvp', 'packages/demo'])
  assert.equal(x.surfaces[0].production.length, 2)
  assert.equal(x.surfaces[1].tests.length, 1)
  assert.equal(x.surfaces[1].configurations.length, 1)
  assert.deepEqual(x.surfaces[1].targets.map(t => t.label), ['//packages/demo:test'])
  assert.deepEqual(x.surfaces[0].boundaries, ['browser', 'http-api'])
  assert.equal(matrix(x).length, 16)
  assert.equal(summarize(x, []).complete, false)
})

test('inventory identity changes with production, test, configuration and target changes; order is irrelevant', () => {
  const base = inventory()
  assert.equal(buildInventory({ members: [...members].reverse(), files: [...files].reverse(), targets: base.surfaces.flatMap(s => s.targets) }).sourceSha256, base.sourceSha256)
  for (const f of files.slice(0, 5)) {
    const changed = files.map(x => x === f ? { ...x, text: x.text + '\n// change' } : x)
    assert.notEqual(buildInventory({ members, files: changed, targets: [] }).sourceSha256, base.sourceSha256)
  }
})

test('accepts a source-bound measured unit receipt and never treats it as whole-campaign success', () => {
  assert.deepEqual(verify(receipt()), [])
  const summary = summarize(inventory(), [receipt()], hashes)
  assert.equal(summary.passed, 1)
  assert.equal(summary.complete, false)
  assert.equal(summary.missing.length, 15)
})

test('rejects configured thresholds, missing artifacts, stale source, zero tests and incomplete measurement', () => {
  for (const patch of [
    { coverage: undefined }, { sourceSha256: 'b'.repeat(64) }, { commit: 'main' },
    { artifacts: [] }, { tests: { passed: 0, failed: 0, skipped: 0, todo: 0 } },
    { tests: { passed: 1, failed: 0, skipped: 1, todo: 0 } },
    { exitCode: 1 }, { outcome: 'red' }, { surface: 'apps/app' }, { tier: 'lint' },
    { environment: 'production' }, { command: { cwd: '.', argv: [] } },
    { runtime: {} }, { startedAt: 'no date' }, { finishedAt: '2026-11-04T00:00:00Z' },
    { limitations: [] }
  ]) assert.ok(verify({ ...receipt(), ...patch }).length > 0, JSON.stringify(patch))
  assert.ok(checkReceipt(receipt(), inventory(), {}).length > 0)
  const r = receipt(); r.artifacts[0] = { ...artifact, path: '../escape' }
  assert.ok(verify(r).length > 0)
})

test('coverage must include every denominator file and all four dimensions at 100%, with exclusions explicit', () => {
  for (const coverage of [
    { ...receipt().coverage, metrics: { lines: { total: 2, covered: 2 } } },
    { ...receipt().coverage, metrics: { ...receipt().coverage.metrics, branches: { total: 2, covered: 1 } } },
    { ...receipt().coverage, denominator: [] },
    { ...receipt().coverage, denominator: ['not-source.ts'] },
    { ...receipt().coverage, exclusions: undefined },
    { ...receipt().coverage, childProcesses: '' }
  ]) assert.ok(verify({ ...receipt(), coverage }).length > 0)
})

test('independent integration and E2E require real dependencies and explicit boundary assertions', () => {
  assert.deepEqual(verify({ ...receipt('integration'), independent: true }), [])
  assert.ok(verify({ ...receipt('integration'), independent: false }).length > 0)
  assert.ok(verify({ ...receipt('integration'), independent: true, dependencies: 'mock' }).length > 0)
  assert.ok(verify(receipt('e2e', 'local')).length > 0)
  assert.deepEqual(verify({ ...receipt('e2e', 'local'), boundaries: ['public-authoring'], recovery: ['failure', 'reload', 'cancellation'] }), [])
})

test('fuzz receipts require seed, shrinking, bounded budget, replay command and retained counterexamples', () => {
  const r = { ...receipt('fuzz', 'bounded'), fuzz: { tool: 'fast-check', seed: 20261105, runs: 1000, budgetMs: 30000, shrinking: true, replay: ['pnpm', 'test'], counterexamples: [] } }
  assert.deepEqual(verify(r), [])
  for (const field of ['tool', 'seed', 'runs', 'budgetMs', 'shrinking', 'replay', 'counterexamples']) {
    const fuzz = { ...r.fuzz }; delete fuzz[field]
    assert.ok(verify({ ...r, fuzz }).length > 0, field)
  }
})

test('benchmark receipts require correctness, raw samples, method and a reviewed baseline without inferring live results', () => {
  const r = { ...receipt('benchmark', 'local'), benchmark: { method: 'one cold, warmup, three warm corpora', correctness: true, samples: [1, 2, 3], baseline: 'baseline.json', baselineReview: 'review-123' } }
  assert.deepEqual(verify(r), [])
  for (const field of ['method', 'correctness', 'samples', 'baseline', 'baselineReview']) {
    const benchmark = { ...r.benchmark }; delete benchmark[field]
    assert.ok(verify({ ...r, benchmark }).length > 0, field)
  }
})

test('duplicate receipt ids, red receipts and corrupt artifacts cannot create campaign completion', () => {
  const r = receipt()
  assert.equal(summarize(inventory(), [r, r], hashes).invalid.length, 1)
  assert.equal(summarize(inventory(), [{ ...r, exitCode: 1 }], hashes).passed, 0)
  assert.equal(summarize(inventory(), [r], { [artifact.path]: 'c'.repeat(64) }).passed, 0)
})

test('nested package ownership, native host paths, ignored cases and tooling boundaries stay explicit', () => {
  const members = [
    { dir: '.smithers/flows', name: 'tooling', manifest: {} },
    { dir: 'packages/smithers', name: 'cli', manifest: {} },
    { dir: 'packages/smithers/child', name: 'child', manifest: {} },
    { dir: 'apps/tui', name: 'terminal', manifest: {} },
    { dir: 'apps/app', name: 'old', manifest: {} }
  ]
  const files = [
    { path: 'packages/smithers/src/main.ts', text: 'main', sha256: sha256('main') },
    { path: 'packages/smithers/child/src/node.ts', text: 'native\nit.skip("known red", () => {})' },
    { path: 'packages/smithers/child/bench/run.mjs', text: 'benchmark' },
    { path: 'packages/smithers/child/PACKAGE.ts', text: 'declare' },
    { path: '.smithers/flows/tool.mjs', text: 'tool' },
    { path: '.smithers/flows/test/coverage-campaign/self.mjs', text: 'excluded self' },
    { path: 'apps/tui/src/main.ts', text: 'tui' }
  ]
  const x = buildInventory({ members, files, targets: [{ package: 'packages/smithers', label: '//packages/smithers:z' }, { package: 'packages/smithers', label: '//packages/smithers:a' }] })
  const child = x.surfaces.find(s => s.id.endsWith('/child'))
  assert.equal(child.production.length, 1)
  assert.equal(child.ignoredCases.length, 1)
  assert.equal(child.benchmarks.length, 1)
  assert.equal(child.platformPaths.length, 1)
  assert.equal(child.owner.declaration, 'packages/smithers/child/PACKAGE.ts')
  assert.deepEqual(x.surfaces.find(s => s.id === 'packages/smithers').boundaries, ['cli', 'installed-consumer', 'public-authoring'])
  assert.deepEqual(x.surfaces.find(s => s.id === 'apps/tui').boundaries, ['terminal'])
  assert.equal(x.surfaces.find(s => s.id === '.smithers/flows').kind, 'retained-tooling')
  assert.equal(x.surfaces.some(s => s.id === 'apps/app'), false)
})

test('artifact and identity validation fails closed on missing optional records', () => {
  assert.ok(checkReceipt({ ...receipt(), id: '', artifacts: undefined }, inventory()).length > 0)
  assert.ok(verify({ ...receipt(), artifacts: [{ ...artifact, kind: '' }] }).length > 0)
})

test('complete means all cells, and an empty inventory is never a completed campaign', () => {
  const receipts = matrix(inventory()).map((cell, i) => {
    const r = { ...receipt(cell.tier, cell.environment), ...cell, id: `run-${i}`, independent: true,
      boundaries: inventory().surfaces.find(s => s.id === cell.surface).boundaries,
      recovery: ['failure', 'reload', 'cancellation'],
      fuzz: { tool: 'fast-check', seed: 1, runs: cell.environment === 'long' ? 100000 : 1000, budgetMs: cell.environment === 'long' ? 3600000 : 60000, shrinking: true, replay: ['test'], counterexamples: [] },
      benchmark: { method: 'method', baseline: 'baseline', baselineReview: 'review', correctness: true, samples: [1, 2, 3] }
    }
    r.coverage.denominator = inventory().surfaces.find(s => s.id === cell.surface).production
    return r
  })
  assert.equal(summarize(inventory(), receipts, hashes).complete, true)
  const failed = { ...receipts[0], id: 'failed-prior', exitCode: 1, outcome: 'failed' }
  const recovered = summarize(inventory(), [failed, ...receipts], hashes)
  assert.equal(recovered.complete, true)
  assert.equal(recovered.invalid.length, 1)
  assert.equal(recovered.unresolved.length, 0)
  assert.equal(summarize(inventory(), [...receipts, failed], hashes).complete, false)
  assert.equal(summarize(inventory(), [...receipts, { ...receipts[0], surface: 'missing', id: 'bad-cell' }], hashes).complete, false)
  assert.equal(summarize({ surfaces: [] }, []).complete, false)
})

test('an eval or benchmark package name does not remove its production source from the denominator', () => {
  const x = buildInventory({ members: [{ dir: 'packages/agent/evals', name: 'evals', manifest: {} }], files: [{ path: 'packages/agent/evals/src/Runner.vibe', text: 'production' }], targets: [] })
  assert.deepEqual(x.surfaces[0].production, ['src/Runner.vibe'])
  assert.deepEqual(x.surfaces[0].tests, [])
})


test('fuzz cannot qualify reduced useful work or an increased budget; empty measurement is not full coverage', () => {
  const r = { ...receipt('fuzz', 'bounded'), fuzz: { tool: 'fast-check', seed: 1, runs: 999, budgetMs: 60000, shrinking: true, replay: ['test'], counterexamples: [] } }
  assert.ok(verify(r).length > 0)
  assert.ok(verify({ ...r, fuzz: { ...r.fuzz, runs: 1000, budgetMs: 60001 } }).length > 0)
  assert.ok(verify({ ...r, environment: 'long', fuzz: { ...r.fuzz, runs: 99999, budgetMs: 3600000 } }).length > 0)
  assert.ok(verify({ ...r, environment: 'long', fuzz: { ...r.fuzz, runs: 100000, budgetMs: 3600001 } }).length > 0)
  const u = receipt(); u.coverage.metrics.lines = { total: 0, covered: 0 }
  assert.ok(verify(u).length > 0)
  const x = buildInventory({ members: [{ dir: 'packages/smithers/ui/views', name: 'views', manifest: {} }], files: [], targets: [] })
  assert.deepEqual(x.surfaces[0].boundaries, ['browser', 'public-authoring'])
})


test('standalone report distinguishes preparation from qualification and escapes source-derived HTML', () => {
  const x = inventory(); x.surfaces[0].name = `<b title="x'">&`
  const html = renderReport(x)
  assert.match(html, /testing campaign is not complete/)
  assert.match(html, /&lt;b title=&quot;x&#39;&quot;&gt;&amp;/)
  assert.ok(!html.includes('<b title='))
  assert.match(renderReport({ surfaces: [], sourceSha256: 'empty' }), /<strong>0<\/strong>retained surfaces/)
})

test('shipped test-support APIs and neighboring implementation dependencies remain in the denominator', () => {
  const x = buildInventory({ members: [{ dir: 'packages/memory', name: 'memory', manifest: { exports: { '.': './src/index.ts', './test': './src/test/TestMemory.ts', './external': './test/support/Public.ts' } } }], files: [
    { path: 'packages/memory/src/index.ts', text: 'export * from "./test/TestMemory.ts"' },
    { path: 'packages/memory/src/test/TestMemory.ts', text: 'export const memory = 1' },
    { path: 'packages/memory/src/test/Support.ts', text: 'export const dependency = 1' },
    { path: 'packages/memory/test/support/Public.ts', text: 'export * from "./Dependency.ts"' },
    { path: 'packages/memory/test/support/Dependency.ts', text: 'export const dependency = 1' },
    { path: 'packages/memory/test/support/Public.test.ts', text: 'test("behavior", () => {})' }
  ], targets: [] })
  assert.deepEqual(x.surfaces[0].production, ['src/index.ts', 'src/test/Support.ts', 'src/test/TestMemory.ts', 'test/support/Dependency.ts', 'test/support/Public.ts'])
})

test('every declared executable requires CLI and installed-consumer E2E, not only the root Smithers package', () => {
  const x = buildInventory({ members: [
    { dir: 'packages/build', name: 'build', manifest: { bin: { 'smithers-build': './src/bin.ts' } } },
    { dir: 'packages/migrate', name: 'migrate', manifest: { bin: './src/bin.ts' } },
    { dir: 'packages/empty', name: 'empty', manifest: { bin: {} } }
  ], files: [], targets: [] })
  for (const id of ['packages/build', 'packages/migrate']) assert.deepEqual(x.surfaces.find(s => s.id === id).boundaries, ['cli', 'installed-consumer', 'public-authoring'])
  assert.deepEqual(x.surfaces.find(s => s.id === 'packages/empty').boundaries, ['public-authoring'])
})
