/** Pure retained-scope inventory and evidence rules. No test execution or inferred passes. */
import { createHash } from 'node:crypto'

export const sha256 = text => createHash('sha256').update(text).digest('hex')
const stable = value => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const removed = path => ['apps/app', 'apps/server', 'apps/backend', 'packages/backend', 'packages/smithers-machined'].some(dir => path === dir || path.startsWith(dir + '/'))
const code = /\.(?:[cm]?[jt]sx?|vibe|rs|c|cpp|h)$/
const testFile = /(?:^|\/)(?:test|tests|e2e|evals|fixtures|__tests__)(?:\/|\.)|\.(?:test|spec|property)\./i
const configFile = /(?:config\.[^.]+|PACKAGE\.(?:ts|vibe)|WORKSPACE\.(?:ts|vibe)|Cargo\.toml|package\.json)$/
const benchFile = /(?:^|\/)(?:bench|benchmarks)(?:\/|\.)|\.bench\./i
const declaredPaths = value => typeof value === 'string' ? [value] : Object.values(value ?? {}).flatMap(declaredPaths)
const testSuffix = /\.(?:test|spec|property)\./
const browserSurface = dir => dir.startsWith('packages/smithers/ui') || dir.endsWith('/platform-browser')
const tiers = [ ['unit', 'node'], ['integration', 'node'], ['e2e', 'local'], ['e2e', 'live'], ['fuzz', 'bounded'], ['fuzz', 'long'], ['benchmark', 'local'], ['benchmark', 'live'] ]
const strings = values => Array.isArray(values) && values.length > 0 && values.every(value => typeof value === 'string' && value.length > 0)
const pathSafe = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(part => part === '..' || part === '')
const dimensions = ['statements', 'branches', 'functions', 'lines']

/** All live workspace members, target-only packages and native packages supplied by discovery. */
export function buildInventory({ members, files, targets }) {
  const retained = members.filter(member => !removed(member.dir)).sort((a, b) => a.dir.localeCompare(b.dir, 'en'))
  const inputs = files.filter(file => !removed(file.path) && !file.path.startsWith('.smithers/flows/test/coverage-campaign/')).sort((a, b) => a.path.localeCompare(b.path, 'en'))
  const roots = retained.map(member => member.dir).sort((a, b) => b.length - a.length)
  const surfaces = retained.map(member => {
    const own = inputs.filter(file => roots.find(dir => file.path === dir || file.path.startsWith(dir + '/')) === member.dir)
    const relative = file => file.path.slice(member.dir.length + 1)
    const declared = [...declaredPaths(member.manifest.exports), ...declaredPaths(member.manifest.bin)].filter(path => path.startsWith('./')).map(path => path.slice(2))
    // Conservatively retain neighboring implementation dependencies of public entry points.
    const shippedRoots = declared.map(path => path.slice(0, path.lastIndexOf('/') + 1))
    const publicSource = path => declared.includes(path) || (!testSuffix.test(path) && (path.startsWith('src/') || shippedRoots.some(root => path.startsWith(root))))
    const production = own.filter(file => code.test(file.path) && (publicSource(relative(file)) || (!testFile.test(relative(file)) && !benchFile.test(relative(file)) && !configFile.test(file.path)))).map(relative)
    const baseBoundaries = member.dir === 'apps/mvp' ? ['browser', 'http-api'] : member.dir === 'apps/tui' ? ['terminal'] : member.dir === 'packages/smithers' ? ['cli', 'installed-consumer', 'public-authoring'] : browserSurface(member.dir) ? ['browser', 'public-authoring'] : ['public-authoring']
    const boundaries = [...new Set([...(declaredPaths(member.manifest.bin).some(path => path.length > 0) ? ['cli', 'installed-consumer'] : []), ...baseBoundaries])]
    const configurations = own.filter(file => configFile.test(file.path)).map(file => ({
      path: file.path,
      sha256: (file.sha256 ?? sha256(file.text)),
      source: file.text,
      // Raw source lines, never evaluated thresholds or an executed denominator.
      coverageDirectives: file.text.split('\n').flatMap((text, index) => /coverage|threshold|include|exclude|ignore|skip|istanbul|c8|v8/i.test(text) ? [{ line: index + 1, text: text.trim() }] : [])
    }))
    return {
      id: member.dir, name: member.name, owner: { declaration: own.find(file => /(?:^|\/)(?:PACKAGE\.ts|Cargo\.toml|package\.json)$/.test(file.path))?.path ?? null, assignedLane: null },
      kind: member.dir === 'apps/mvp' ? 'mvp' : member.dir.startsWith('packages/') ? 'package' : 'retained-tooling',
      scripts: member.manifest.scripts ?? {}, exports: member.manifest.exports ?? null,
      production, tests: own.filter(file => testFile.test(relative(file))).map(file => file.path),
      benchmarks: own.filter(file => benchFile.test(relative(file))).map(file => file.path),
      platformPaths: own.filter(file => /browser|worker|node|bun|windows|darwin|linux|process|native|wasm|opfs/i.test(file.path)).map(file => file.path),
      ignoredCases: own.flatMap(file => file.text.split('\n').flatMap((text, index) => /(?:\.(?:skip|skipIf|todo|fails)\b|(?:istanbul|c8|v8)\s+ignore|coverage\s+ignore)/.test(text) ? [{ path: file.path, line: index + 1, text: text.trim() }] : [])),
      configurations,
      targets: targets.filter(target => target.package === member.dir).map(({ package: dir, label, rule, kinds, exclusive, hosts, inputs, dependencies }) => ({ package: dir, label, rule, kinds, exclusive, hosts, inputs, dependencies })).sort((a, b) => a.label.localeCompare(b.label, 'en')),
      areas: [...new Set(production.map(path => path.split('/').slice(0, path.startsWith('src/features/') ? 3 : 2).join('/')))].sort(),
      boundaries
    }
  })
  const sourceSha256 = sha256(stable({ surfaces, files: inputs.map(file => [file.path, (file.sha256 ?? sha256(file.text))]) }))
  return { schemaVersion: 1, sourceSha256, surfaces, inputFiles: inputs.map(file => ({ path: file.path, sha256: (file.sha256 ?? sha256(file.text)) })) }
}

/** Every retained surface requires every tier. Missing entry points remain required gaps. */
export const matrix = inventory => inventory.surfaces.flatMap(surface => tiers.map(([tier, environment]) => ({ surface: surface.id, tier, environment })))

/** Receipt integrity is necessary; human review of raw artifacts still establishes what they prove. */
export function checkReceipt(receipt, inventory, artifactHashes = {}) {
  const errors = []
  const need = (condition, reason) => { if (!condition) errors.push(reason) }
  const surface = inventory.surfaces.find(surface => surface.id === receipt.surface)
  need(surface !== undefined, 'unknown or removed surface')
  need(tiers.some(([tier, environment]) => tier === receipt.tier && environment === receipt.environment), 'unknown matrix cell')
  need(typeof receipt.id === 'string' && receipt.id.length > 0, 'missing run id')
  need(/^[a-f0-9]{40}$/.test(receipt.commit), 'full jj commit id required')
  need(receipt.sourceSha256 === inventory.sourceSha256, 'stale source fingerprint')
  need(pathSafe(receipt.command?.cwd) && strings(receipt.command?.argv), 'reproducible cwd and argv required')
  need(strings([receipt.runtime?.version, receipt.runtime?.platform, receipt.runtime?.arch]), 'runtime and platform required')
  need(Number.isFinite(Date.parse(receipt.startedAt)) && Number.isFinite(Date.parse(receipt.finishedAt)) && Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt), 'invalid run interval')
  need(receipt.exitCode === 0 && receipt.outcome === 'passed', 'run did not pass')
  need(Number.isSafeInteger(receipt.tests?.passed) && receipt.tests.passed > 0 && receipt.tests.failed === 0 && receipt.tests.skipped === 0 && receipt.tests.todo === 0, 'empty, failed, skipped or todo tests')
  need(strings(receipt.limitations), 'limitations must be explicit')
  need(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0, 'raw artifacts required')
  for (const artifact of receipt.artifacts ?? []) {
    need(pathSafe(artifact.path) && /^[a-f0-9]{64}$/.test(artifact.sha256) && artifactHashes[artifact.path] === artifact.sha256, 'missing or corrupt artifact')
    need(strings([artifact.kind]), 'artifact kind required')
  }
  if (receipt.tier === 'unit') {
    const coverage = receipt.coverage
    for (const dimension of dimensions) {
      const metric = coverage?.metrics?.[dimension]
      need(Number.isSafeInteger(metric?.total) && metric.total >= (['statements', 'lines'].includes(dimension) ? 1 : 0) && metric.covered === metric.total, `unmeasured or incomplete ${dimension}`)
    }
    need(strings(coverage?.denominator) && surface !== undefined && stable([...coverage.denominator].sort()) === stable([...surface.production].sort()), 'coverage denominator differs from production inventory')
    need(Array.isArray(coverage?.exclusions) && coverage.exclusions.length === 0, 'coverage exclusions require owner qualification; no whole-surface pass')
    need(typeof coverage?.childProcesses === 'string' && coverage.childProcesses.length > 0, 'child-process coverage accounting required')
  }
  if (receipt.tier === 'integration') need(receipt.independent === true, 'integration must run independently')
  if (['integration', 'e2e', 'benchmark'].includes(receipt.tier)) need(receipt.dependencies === 'real', 'real dependencies required')
  if (receipt.tier === 'e2e') {
    need(surface !== undefined && strings(receipt.boundaries) && surface.boundaries.every(boundary => receipt.boundaries.includes(boundary)), 'all public boundaries required')
    need(strings(receipt.recovery) && ['failure', 'reload', 'cancellation'].every(item => receipt.recovery.includes(item)), 'failure, reload and cancellation evidence required')
  }
  if (receipt.tier === 'fuzz') {
    const fuzz = receipt.fuzz
    need(strings([fuzz?.tool]) && Number.isSafeInteger(fuzz?.seed) && Number.isSafeInteger(fuzz?.runs) && fuzz.runs >= (receipt.environment === 'long' ? 100000 : 1000) && Number.isSafeInteger(fuzz?.budgetMs) && fuzz.budgetMs > 0 && fuzz.budgetMs <= (receipt.environment === 'long' ? 3600000 : 60000) && fuzz.shrinking === true && strings(fuzz.replay) && Array.isArray(fuzz.counterexamples), 'fuzz seed, budget, shrinking, replay and counterexamples required')
  }
  if (receipt.tier === 'benchmark') {
    const benchmark = receipt.benchmark
    need(strings([benchmark?.method, benchmark?.baseline, benchmark?.baselineReview]) && benchmark.correctness === true && Array.isArray(benchmark.samples) && benchmark.samples.length >= 3 && benchmark.samples.every(value => Number.isFinite(value) && value >= 0), 'benchmark correctness, method, samples and reviewed baseline required')
  }
  return errors
}

/** Failed receipts are retained; duplicate identities and missing cells never count as completion. */
export function summarize(inventory, receipts, artifactHashes = {}) {
  const passed = new Set(), seen = new Set(), invalid = [], latest = new Map()
  let duplicates = 0
  const key = receipt => [receipt.surface, receipt.tier, receipt.environment].join(':')
  for (const receipt of receipts) {
    const errors = checkReceipt(receipt, inventory, artifactHashes)
    if (seen.has(receipt.id)) { errors.push('duplicate receipt id'); duplicates++ }
    seen.add(receipt.id)
    latest.set(key(receipt), receipt.id)
    if (errors.length > 0) {
      invalid.push({ id: receipt.id, cell: key(receipt), errors })
      passed.delete(key(receipt))
    } else passed.add(key(receipt))
  }
  const missing = matrix(inventory).filter(cell => !passed.has(key(cell)))
  const unresolved = invalid.filter(record => latest.get(record.cell) === record.id)
  return { complete: missing.length === 0 && unresolved.length === 0 && duplicates === 0 && inventory.surfaces.length > 0, passed: passed.size, missing, invalid, unresolved }
}
