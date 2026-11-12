import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { expectedCommand, unpackResults, validMapping, verifyCiRun, zeroTests } from './check-evidence.mjs'
import { fixture, zipFixture } from './check-receipts-fixture.mjs'

const digest = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`

test('target receipts preserve observed fields', () => {
  const f = fixture()
  try {
    const before = Date.now(); const paths = ['C-FIX-01','C-FIX-02'].map(id => {
      const result = f.recorded(id); assert.equal(result.status, 0, result.stdout + result.stderr)
      return JSON.parse(result.stdout).receipt
    }); const after = Date.now()
    const r = JSON.parse(readFileSync(join(f.root, paths[0])))
    assert.deepEqual(Object.keys(r).sort(), ['version','check','commit','layer','command','exit','started','ended','log_digest'].sort())
    assert.equal(r.version, 1); assert.equal(r.commit, f.sha); assert.match(r.commit, /^[a-f0-9]{40}$/)
    assert.equal(r.check, 'C-FIX-01'); assert.equal(r.layer, 'integration'); assert.deepEqual(r.command, ['smthrs-ci','//fixture:canary']); assert.equal(r.exit, 0); assert.ok(Number.isInteger(r.exit)); assert.match(r.log_digest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(r.log_digest, digest(readFileSync(join(f.root, paths[0], '..', 'log.txt'))))
    for (const time of [r.started, r.ended]) { assert.match(time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); assert.ok(Date.parse(time) >= before && Date.parse(time) <= after) }
    assert.ok(r.started <= r.ended)
  } finally { f.cleanup() }
})

test('runner refuses absent, unwritten, unparsable and mismatched Automation before CI reads', () => {
  const f = fixture()
  try {
    for (const declaration of ['Automation: unavailable · Runs in: CI','Automation: `smthrs test //fixture:canary` (to write) · Runs in: CI','Automation: prose PASS · Runs in: CI','Automation: `smthrs test //fixture:canary` · Runs in: reference host']) {
      f.put('.specs/engineering/checks/C-FIX-01.md', `Layer: integration\n${declaration}\n`); f.commit()
      const result = f.runner(); assert.equal(result.status,2); assert.equal(JSON.parse(result.stdout).action,'check-refused'); assert.equal(JSON.parse(result.stdout).receipt,undefined)
    }
    assert.equal(f.runner('C-ABS-01').status,2)
  } finally { f.cleanup() }
})
test('inventory covers every check exactly once and executable mappings require approval, target and host', () => {
  const root=new URL('../../../', import.meta.url)
  const mappings=JSON.parse(readFileSync(new URL('.smithers/flows/evidence/check-commands.json',root)))
  const files = `C-ACC-01 C-ACC-02 C-ACC-03 C-ACC-04 C-AGT-01 C-AGT-02 C-APP-01 C-APP-02 C-APP-03 C-APP-04 C-APP-05 C-CAT-01 C-CAT-02 C-CAT-03 C-COL-01 C-COL-02 C-COL-03 C-COL-04 C-COL-05 C-COL-06 C-CUT-01 C-CUT-02 C-DUR-01 C-DUR-02 C-DUR-03 C-DUR-04 C-DUR-05 C-FM-01 C-FM-02 C-GH-01 C-GH-07 C-GH-08 C-GH-09 C-GH-13 C-INS-01 C-INS-03 C-INS-05 C-INS-06 C-J1-01 C-J1-02 C-J1-03 C-J1-04 C-J1-05 C-J1-06 C-J10-01 C-J10-02 C-J10-03 C-J10-04 C-J10-05 C-J10-06 C-J10-07 C-J10-08 C-J10-09 C-J11-01 C-J11-02 C-J11-03 C-J11-04 C-J2-01 C-J2-02 C-J2-03 C-J2-04 C-J2-05 C-J3-01 C-J3-02 C-J3-03 C-J3-04 C-J3-05 C-J3-06 C-J3-08 C-J3-09 C-J3-10 C-J4-01 C-J4-02 C-J4-03 C-J5-01 C-J5-02 C-J5-03 C-J6-01 C-J6-02 C-J7-01 C-J7-02 C-J7-03 C-J8-01 C-J8-02 C-J8-03 C-J8-04 C-J8-05 C-J8-06 C-J9-01 C-MCH-01 C-MCH-02 C-MCH-03 C-MCH-04 C-MCH-05 C-MCH-06 C-MCH-07 C-MCH-08 C-MCH-09 C-MCH-10 C-MCH-11 C-MCH-12 C-MNT-01 C-MNT-02 C-MNT-03 C-MNT-04 C-MNT-05 C-MNT-06 C-PERF-01 C-PERF-02 C-PERF-03 C-PERF-04 C-PERF-05 C-PERF-06 C-PRC-01 C-PRC-02 C-PRC-03 C-REL-01 C-REL-02 C-REL-03 C-REL-04 C-REL-05 C-REL-06 C-RMT-01 C-RMT-02 C-RMT-03 C-RMT-04 C-RMT-05 C-RMT-06 C-SEC-01 C-SEC-02 C-SEC-03 C-SEC-04 C-SEC-05 C-SPK-02 C-SPK-03 C-SPK-05 C-SPK-06 C-SPK-07 C-SPK-08 C-STK-01 C-STK-02 C-STK-03 C-STK-04 C-STK-05 C-STK-06 C-STK-07 C-STK-08 C-STK-13 C-UI-01 C-UI-02 C-UI-03 C-UI-04 C-UI-05 C-UI-06 C-UI-07 C-UI-08 C-UI-09 C-UI-10 C-UI-11 C-UI-12 C-UI-13 C-UI-14`.split(' ')
  assert.deepEqual(Object.keys(mappings.checks).sort(),files)
  assert.deepEqual(readdirSync(new URL(".specs/engineering/checks/", root)).filter(name => /^C-.*\.md$/.test(name)).map(name => name.slice(0, -3)).sort(), files)

  for(const m of Object.values(mappings.checks)) assert.ok(validMapping(m))
  for(const m of [{command:['node'],host:'CI'},{approvedBy:'smithers-22',host:'CI'},{approvedBy:'smithers-22',command:['node']}]) assert.equal(validMapping(m),false)
})

test('an approved mapping cannot drop obligations its pending binding still lists open (4386fc25e review)', () => {
  const approved = { approvedBy: 'smithers-22', host: 'CI', target: '//fixture:canary' }
  assert.equal(validMapping(approved), true)
  assert.equal(validMapping({ ...approved, pendingBinding: { commands: [{ expectedCaseIds: ['a'] }], unboundSubcases: [{ name: 'T-UI-02-copy', reason: 'open' }] } }), false)
  assert.equal(validMapping({ ...approved, pendingBinding: { commands: [{ expectedCaseIds: [] }] } }), false)
  assert.equal(validMapping({ ...approved, pendingBinding: { commands: [{}] } }), false)
  assert.equal(validMapping({ ...approved, pendingBinding: { commands: [{ expectedCaseIds: ['a'] }], unboundSubcases: [] } }), true)
  // A pending entry may keep its open proposal.
  assert.equal(validMapping({ status: 'pending-owner', reason: 'r', ticket: 'T-UI-01', pendingBinding: { unboundSubcases: [{ name: 'x' }] } }), true)
})

test('a run that executed no tests is empty for every reporter, and a run with tests is not', () => {
  for (const log of ['ℹ tests 0\nℹ pass 0', '# tests 0', 'Ran 0 tests across 0 files. [3ms]', 'No test files found, exiting with code 1', 'Error: No tests found', 'ok  \tgithub.com/x/y\t0.01s [no tests to run]', '?   \tgithub.com/x/z\t[no test files]']) assert.equal(zeroTests(log), true, log)
  for (const log of ['ℹ tests 12', 'Ran 3 tests across 1 file.', 'ok  \tgithub.com/x/y\t0.51s', 'ok  \tgithub.com/x/y\t0.51s\nok  \tgithub.com/x/w\t0.01s [no tests to run]', '{"Action":"pass","Package":"p","Test":"TestA","Elapsed":0}\n[no tests to run]', '--- PASS: TestA (0.00s)', 'canary passed']) assert.equal(zeroTests(log), false, log)
})


// #3663 option B: CI's own record decides a target mapping. Each case forges one input.
const ciFixture = (overrides = {}) => {
  const L = 'a'.repeat(40); const label = '//apps/app:viewStories'
  const latest = Buffer.from('latest'); const earlier = Buffer.from('earlier')
  const files = new Map([
    [latest.toString(), [{ name: 'step.json', text: JSON.stringify({ version: 1, results: [{ label, status: overrides.status ?? 'ran', key: 'k' }, { label: '//other:x', status: 'failed' }] }) }]],
    [earlier.toString(), [{ name: 'step.json', text: JSON.stringify({ version: 1, results: [{ label, status: 'ran', key: 'k' }] }) }]]
  ])
  const api = {
    [`repos/o/r/commits/${L}/check-runs?per_page=100`]: { check_runs: [{ app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', head_sha: L, details_url: 'https://github.com/o/r/actions/runs/7/job/1', ...overrides.check }] },
    'repos/o/r/actions/runs/7': { id: 7, head_sha: L, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', repository: { full_name: 'o/r' }, status: 'completed', run_attempt: 2, html_url: 'https://github.com/o/r/actions/runs/7', ...overrides.run },
    'repos/o/r/actions/runs/7/attempts/2/jobs?per_page=100': { jobs: [{ id: 1, name: overrides.jobName ?? 'workspace graph (coverage gates enforced)', status: 'completed', conclusion: 'success', run_attempt: overrides.testAttempt ?? 2 }, ...(overrides.jobs ?? [])] },
    'repos/o/r/actions/runs/7/artifacts?per_page=100': { artifacts: [
      { id: 10, name: `smthrs-results-${overrides.artifactJob ?? 'test'}-0-2`, workflow_run: { id: 7 }, expired: false, digest: digest(latest), ...overrides.artifact },
      { id: 11, name: `smthrs-results-${overrides.artifactJob ?? 'test'}-0-1`, workflow_run: { id: 7 }, expired: false, digest: digest(earlier) }
    ] }
  }
  const zips = { 'repos/o/r/actions/artifacts/10/zip': overrides.zip ?? latest, 'repos/o/r/actions/artifacts/11/zip': earlier }
  return verifyCiRun({ github: { json: (path) => api[path] ?? (() => { throw new Error(`unexpected ${path}`) })(), bytes: (path) => zips[path] }, unpack: (bytes) => ({ files: files.get(bytes.toString()) ?? [] }), repo: 'o/r', landed: L, label })
}

test('CI receipt passes on the label\'s own status in the latest attempt, when another target failed but the job succeeded', () => {
  const ok = ciFixture()
  assert.equal(ok.pass, true); assert.equal(ok.reason, 'pass')
  assert.deepEqual(ok.evidence.rows.map(row => [row.artifact, row.status]), [['smthrs-results-test-0-2', 'ran']])
  assert.equal(ciFixture({ status: 'hit' }).pass, true)
})

test('shard receipts retain label verdicts and reject mismatched job identities', () => {
  for (let shard = 2; shard <= 9; shard++) {
    for (const [artifactJob, jobName] of [
      [`test-${shard}`, `workspace graph ${shard}/9 (coverage gates enforced)`],
      [`packages-${shard}`, `package suites ${shard}/9 (ubuntu-latest)`]
    ]) {
      assert.equal(ciFixture({ artifactJob, jobName }).pass, true)
      assert.equal(ciFixture({ artifactJob, jobName, status: 'failed' }).pass, false)
      assert.equal(ciFixture({ artifactJob, jobName: 'unrelated job' }).reason, 'label_job')
    }
  }
})

test('CI receipt refuses forged sha, app, branch, event and workflow path', () => {
  for (const [overrides, reason] of [
    [{ check: { head_sha: 'b'.repeat(40) } }, 'commit'],
    [{ check: { app: { slug: 'evil-app' } } }, 'no_run'],
    [{ run: { head_sha: 'b'.repeat(40) } }, 'no_run'],
    [{ run: { event: 'pull_request' } }, 'no_run'],
    [{ run: { head_branch: 'feature' } }, 'no_run'],
    [{ run: { path: '.github/workflows/pr-edited.yml' } }, 'no_run'],
    [{ run: { repository: { full_name: 'fork/r' } } }, 'no_run'],
    [{ run: { status: 'in_progress' } }, 'incomplete']
  ]) assert.equal(ciFixture(overrides).reason, reason, JSON.stringify(overrides))
})

test('CI receipt refuses a rerun that still fails, ignoring the earlier passing attempt', () => {
  const r = ciFixture({ status: 'failed' })
  assert.equal(r.pass, false); assert.equal(r.reason, 'label_failed')
  assert.ok(r.evidence.rows.every(row => row.artifact.endsWith('-2')))
  assert.equal(ciFixture({ status: 'skipped' }).reason, 'label_failed')
})

test('CI receipt refuses foreign or tampered artifacts, stopped jobs and an absent label', () => {
  assert.equal(ciFixture({ artifact: { workflow_run: { id: 8 } } }).reason, 'artifact_foreign')
  assert.equal(ciFixture({ artifact: { expired: true } }).reason, 'artifact_foreign')
  assert.equal(ciFixture({ zip: Buffer.from('tampered') }).reason, 'artifact_digest')
  assert.equal(ciFixture({ jobs: [{ name: 'go', conclusion: 'cancelled' }] }).reason, 'job_stopped')
  assert.equal(ciFixture({ jobs: [{ name: 'go', conclusion: 'timed_out' }] }).reason, 'job_stopped')
  // A leg the latest attempt re-ran must have uploaded at that attempt (b8): its earlier pass never stands in.
  assert.equal(ciFixture({ artifact: { name: 'smthrs-results-test-0-1x' } }).reason, 'artifact_missing')
  // A leg the rerun did not execute keeps its earlier attempt's result.
  const fallback = ciFixture({ artifact: { name: 'smthrs-results-test-0-1x' }, testAttempt: 1 })
  assert.equal(fallback.pass, true); assert.deepEqual(fallback.evidence.rows.map(row => row.artifact), ['smthrs-results-test-0-1'])
})

test('target mappings carry a label and no argv; recorder uses the CI receipt command', () => {
  const target = { approvedBy: 'smithers-22', host: 'CI', target: '//apps/app:viewStories' }
  assert.equal(validMapping(target), true)
  for (const bad of [{ ...target, host: 'reference host' }, { ...target, command: ['node'] }, { ...target, paths: ['x'] }, { ...target, target: 'apps/app:viewStories' }, { ...target, target: '//apps/app' }]) assert.equal(validMapping(bad), false, JSON.stringify(bad))
  assert.deepEqual(expectedCommand(target), ['smthrs-ci', '//apps/app:viewStories'])
})

test('runner requires --landed and refuses argv mappings even with CI=true', () => {
  const f = fixture()
  try {
    const run = args => spawnSync(process.execPath, ['.smithers/flows/evidence/check-run.mjs', ...args], { cwd: f.root, encoding: 'utf8', env: { ...process.env, CI: 'true' } })
    for (const args of [['C-FIX-02'], ['C-FIX-01','--landed'], ['C-FIX-01','--landed','abc']]) {
      const out = run(args); assert.equal(out.status,2); assert.equal(JSON.parse(out.stdout).receipt,undefined)
    }
    const mappings = JSON.parse(readFileSync(join(f.root,'.smithers/flows/evidence/check-commands.json')))
    const { target, ...rest } = mappings.checks['C-FIX-01']
    mappings.checks['C-FIX-01'] = {...rest,command:['node','canary.mjs'],paths:['canary.mjs']}
    f.put('.smithers/flows/evidence/check-commands.json',JSON.stringify(mappings)); f.commit()
    const out = f.runner(); assert.equal(out.status,2)
    assert.equal(JSON.parse(out.stdout).reason,'argv mappings are not executable; map the check to a smthrs target')
    assert.equal(JSON.parse(out.stdout).receipt,undefined); assert.equal(f.writes.length,0)
    assert.equal(validMapping(mappings.checks['C-FIX-01']),false)
  } finally { f.cleanup() }
})
test('artifact unpacking is confined: symlinks, nested paths and oversize zips refuse with fixed reasons (3f, #3663)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unpack-'))
  try {
    const zip = (name, setup) => {
      const work = join(dir, name); mkdirSync(work, { recursive: true }); setup(work)
      zipFixture(work, join(dir, `${name}.zip`))
      return readFileSync(join(dir, `${name}.zip`))
    }
    const good = unpackResults(zip('good', (w) => writeFileSync(join(w, 'step.json'), '{"version":1,"results":[]}')))
    assert.deepEqual(good, { files: [{ name: 'step.json', text: '{"version":1,"results":[]}' }] })
    const secret = join(dir, 'secret.txt'); writeFileSync(secret, '-----BEGIN PRIVATE KEY-----')
    const link = unpackResults(zip('link', (w) => symlinkSync(secret, join(w, 'x.json'))))
    assert.deepEqual(link, { reason: 'artifact_entry' })
    assert.deepEqual(unpackResults(zip('nested', (w) => { mkdirSync(join(w, 'sub')); writeFileSync(join(w, 'sub', 'x.json'), '{}') })), { reason: 'artifact_entry' })
    assert.deepEqual(unpackResults(zip('other', (w) => writeFileSync(join(w, 'x.txt'), '{}'))), { reason: 'artifact_entry' })
    assert.deepEqual(unpackResults(zip('big', (w) => writeFileSync(join(w, 'x.json'), 'x'.repeat(2048))), { maxFile: 1024 }), { reason: 'artifact_size' })
    assert.deepEqual(unpackResults(zip('total', (w) => { writeFileSync(join(w, 'a.json'), 'x'.repeat(600)); writeFileSync(join(w, 'b.json'), 'x'.repeat(600)) }), { maxTotal: 1000 }), { reason: 'artifact_size' })
    assert.deepEqual(unpackResults(Buffer.from('not a zip')), { reason: 'artifact_zip' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unreadable results JSON refuses with a fixed reason and no file contents', () => {
  const L = 'a'.repeat(40); const bytes = Buffer.from('z')
  const api = {
    [`repos/o/r/commits/${L}/check-runs?per_page=100`]: { check_runs: [{ app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', head_sha: L, details_url: 'https://github.com/o/r/actions/runs/7/job/1' }] },
    'repos/o/r/actions/runs/7': { id: 7, head_sha: L, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', repository: { full_name: 'o/r' }, status: 'completed', run_attempt: 1 },
    'repos/o/r/actions/runs/7/attempts/1/jobs?per_page=100': { jobs: [{ id: 1, name: 'workspace graph (coverage gates enforced)', status: 'completed', conclusion: 'success', run_attempt: 1 }] },
    'repos/o/r/actions/runs/7/artifacts?per_page=100': { artifacts: [{ id: 10, name: 'smthrs-results-test-0-1', workflow_run: { id: 7 }, expired: false, digest: digest(bytes) }] }
  }
  const r = verifyCiRun({ github: { json: (p) => api[p], bytes: () => bytes }, unpack: () => ({ files: [{ name: 'x.json', text: '-----BEGIN PRIVATE KEY----- abc' }] }), repo: 'o/r', landed: L, label: '//a:b' })
  assert.equal(r.reason, 'results_unreadable')
  assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'))
})

test('a partial rerun keeps each job leg at its newest attempt, and truncated listings refuse (Fable, #3663)', () => {
  const L = 'a'.repeat(40); const label = '//x:y'
  const bytes = { a1: Buffer.from('a1'), b1: Buffer.from('b1'), a2: Buffer.from('a2') }
  const rows = { a1: 'failed', b1: 'ran', a2: 'ran' }
  const artifact = (id, name, key) => ({ id, name, workflow_run: { id: 7 }, expired: false, digest: digest(bytes[key]) })
  const api = (extra = {}) => ({
    [`repos/o/r/commits/${L}/check-runs?per_page=100`]: { check_runs: [{ app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', head_sha: L, details_url: 'https://github.com/o/r/actions/runs/7/job/1' }, { app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', head_sha: L, details_url: 'https://github.com/o/r/actions/runs/7/job/2' }], ...extra.checks },
    'repos/o/r/actions/runs/7': { id: 7, head_sha: L, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', repository: { full_name: 'o/r' }, status: 'completed', run_attempt: 2 },
    'repos/o/r/actions/runs/7/attempts/2/jobs?per_page=100': { jobs: [{ id: 1, name: 'workspace graph (coverage gates enforced)', status: 'completed', conclusion: 'success', run_attempt: 2 }, { id: 2, name: 'repository flows, apps and evals', status: 'completed', conclusion: 'success', run_attempt: 1 }], ...extra.jobs },
    'repos/o/r/actions/runs/7/attempts/1/jobs?per_page=100': { jobs: [{ id: 2, name: 'repository flows, apps and evals', status: 'completed', conclusion: 'success', run_attempt: 1 }] },
    'repos/o/r/actions/runs/7/artifacts?per_page=100': { artifacts: [artifact(1, 'smthrs-results-test-0-1', 'a1'), artifact(2, 'smthrs-results-repository-0-1', 'b1'), artifact(3, 'smthrs-results-test-0-2', 'a2')], ...extra.artifacts }
  })
  const verify = (extra) => {
    const responses = api(extra); const zips = { 1: bytes.a1, 2: bytes.b1, 3: bytes.a2 }
    return verifyCiRun({ github: { json: (p) => responses[p], bytes: (p) => zips[/artifacts\/(\d+)\/zip/.exec(p)[1]] }, unpack: (b) => ({ files: [{ name: 's.json', text: JSON.stringify({ version: 1, results: [{ label, status: rows[b.toString()] }] }) }] }), repo: 'o/r', landed: L, label })
  }
  const r = verify()
  assert.equal(r.pass, true, JSON.stringify(r))
  assert.deepEqual(r.evidence.rows.map(row => [row.artifact, row.status]), [['smthrs-results-repository-0-1', 'ran'], ['smthrs-results-test-0-2', 'ran']])
  assert.equal(verify({ jobs: { jobs: [{ id: 1, name: 'workspace graph (coverage gates enforced)', status: 'completed', conclusion: 'success', run_attempt: 2 }] } }).pass, true)
  for (const extra of [{ checks: { total_count: 101 } }, { jobs: { total_count: 150 } }, { artifacts: { total_count: 500 } }]) assert.equal(verify(extra).reason, 'truncated', JSON.stringify(extra))
})

test('an empty or non-JSON results file refuses the receipt (38L: a crashed run leaves 0 bytes)', () => {
  const L = 'a'.repeat(40); const bytes = Buffer.from('z')
  const api = {
    [`repos/o/r/commits/${L}/check-runs?per_page=100`]: { check_runs: [{ app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', head_sha: L, details_url: 'https://github.com/o/r/actions/runs/7/job/1' }] },
    'repos/o/r/actions/runs/7': { id: 7, head_sha: L, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', repository: { full_name: 'o/r' }, status: 'completed', run_attempt: 1 },
    'repos/o/r/actions/runs/7/attempts/1/jobs?per_page=100': { jobs: [{ id: 1, name: 'workspace graph (coverage gates enforced)', status: 'completed', conclusion: 'success', run_attempt: 1 }] },
    'repos/o/r/actions/runs/7/artifacts?per_page=100': { artifacts: [{ id: 10, name: 'smthrs-results-test-0-1', workflow_run: { id: 7 }, expired: false, digest: digest(bytes) }] }
  }
  for (const text of ['', 'not json', '{"results":[]}']) {
    const files = [{ name: 'attempt.json', text: '{"version":1,"results":[]}' }, { name: '__run.json', text: JSON.stringify({ version: 1, results: [{ label: '//a:b', status: 'ran' }] }) }, { name: '__run_2.json', text }]
    const r = verifyCiRun({ github: { json: (p) => api[p], bytes: () => bytes }, unpack: () => ({ files }), repo: 'o/r', landed: L, label: '//a:b' })
    assert.equal(r.reason, 'results_unreadable', JSON.stringify(text))
  }
})

test('a crashed latest attempt (empty results) refuses the label; it never inherits the earlier attempt\'s pass (38L)', () => {
  const L = 'a'.repeat(40); const label = '//x:y'
  const earlier = Buffer.from('earlier'); const crashed = Buffer.from('crashed')
  const files = new Map([
    [earlier.toString(), [{ name: '__run.json', text: JSON.stringify({ version: 1, results: [{ label, status: 'ran' }] }) }]],
    [crashed.toString(), [{ name: 'attempt.json', text: '{"version":1,"results":[]}' }, { name: '__run.json', text: '{"results":[],"version":1}' }]]
  ])
  const api = {
    [`repos/o/r/commits/${L}/check-runs?per_page=100`]: { check_runs: [{ app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', head_sha: L, details_url: 'https://github.com/o/r/actions/runs/7/job/1' }] },
    'repos/o/r/actions/runs/7': { id: 7, head_sha: L, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', repository: { full_name: 'o/r' }, status: 'completed', run_attempt: 2 },
    'repos/o/r/actions/runs/7/attempts/2/jobs?per_page=100': { jobs: [{ name: 'test', conclusion: 'failure', run_attempt: 2 }] },
    'repos/o/r/actions/runs/7/artifacts?per_page=100': { artifacts: [
      { id: 1, name: 'smthrs-results-test-0-1', workflow_run: { id: 7 }, expired: false, digest: digest(earlier) },
      { id: 2, name: 'smthrs-results-test-0-2', workflow_run: { id: 7 }, expired: false, digest: digest(crashed) }
    ] }
  }
  const zips = { 'repos/o/r/actions/artifacts/1/zip': earlier, 'repos/o/r/actions/artifacts/2/zip': crashed }
  const r = verifyCiRun({ github: { json: (p) => api[p], bytes: (p) => zips[p] }, unpack: (b) => ({ files: files.get(b.toString()) }), repo: 'o/r', landed: L, label })
  assert.equal(r.pass, false); assert.equal(r.reason, 'label_absent')
  assert.deepEqual(r.evidence.artifacts.map(a => a.name), ['smthrs-results-test-0-2'])
})

test('recorder retains failed CI labels as failed evidence', () => {
  const f = fixture()
  try {
    const out = f.recorded('C-FIX-01', 'failed')
    assert.equal(out.status, 1, out.stdout + out.stderr)
    const path = JSON.parse(out.stdout).receipt
    assert.equal(JSON.parse(readFileSync(join(f.root, path))).exit, 1)
    const log = JSON.parse(readFileSync(join(f.root, path, '..', 'log.txt')))
    assert.equal(log.label, '//fixture:canary')
    assert.equal(log.reason, 'label_failed')
    assert.equal(log.pass, false)
    assert.equal(f.writes.length, 0)
  } finally { f.cleanup() }
})

test('root-check-mapping-validation: markers refuse recorder without dispatch', () => {
  for (const status of ['manual', 'pending-owner']) {
    const f = fixture()
    try {
      f.put('.smithers/flows/evidence/check-commands.json', JSON.stringify({ version: 1, activation: { mappingsApprovedBy: 'smithers-22' }, checks: {
        'C-FIX-01': { status, reason: 'root inputs lack owner-reviewed validation', ticket: 'T-SEC-01' },
        'C-FIX-02': { approvedBy: 'smithers-22', automation: 'smthrs test //fixture:canary', runsIn: 'CI', host: 'CI', target: '//fixture:canary' }
      } }))
      f.commit()
      const out = f.runner()
      assert.equal(out.status, 2)
      assert.deepEqual(JSON.parse(out.stdout), { action: 'check-refused', check: 'C-FIX-01', reason: 'no reviewed executable mapping' })
      assert.equal(f.writes.length, 0)
    } finally { f.cleanup() }
  }
})

test('the host sampler lives with packages/smithers and no duplicate check runner remains', () => {
  assert.equal(existsSync(new URL('./checks/', import.meta.url)), false)
  const sampler = new URL('../../../packages/smithers/scripts/host-process-sampler.mjs', import.meta.url)
  assert.doesNotMatch(readFileSync(sampler, 'utf8'), /check-run|check-evidence|check-commands|host-profile|ops-health-line/)
})


test('duplicate CI artifact identities refuse at recorder boundary', () => {
  const f = fixture()
  try {
    const recorded = f.recorded()
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr)
    const statePath = join(f.root, 'transport.json')
    const state = JSON.parse(readFileSync(statePath))
    const artifacts = state.responses['repos/o/r/actions/runs/7/artifacts?per_page=100'].artifacts
    artifacts.push({ ...artifacts[0], id: 11 })
    f.put('transport.json', JSON.stringify(state))
    const out = spawnSync(process.execPath, ['.smithers/flows/evidence/check-run.mjs', 'C-FIX-01', '--landed', f.sha], {
      cwd: f.root, encoding: 'utf8', env: { ...process.env,
        NODE_OPTIONS: `--import=${join(f.root, 'transport.mjs')}`,
        PRC03_TRANSPORT: statePath, SMITHERS_GITHUB_PROXY: 'http://fixture.test' }
    })
    assert.equal(out.status, 1, out.stdout + out.stderr)
    const receipt = JSON.parse(readFileSync(join(f.root, JSON.parse(out.stdout).receipt)))
    assert.equal(receipt.exit, 1)
    const log = JSON.parse(readFileSync(join(f.root, JSON.parse(out.stdout).receipt, '..', 'log.txt')))
    assert.equal(log.reason, 'artifact_ambiguous')
    assert.deepEqual(JSON.parse(readFileSync(statePath)).writes, [])
  } finally { f.cleanup() }
})

test('reference-host mappings accept only reviewed targets and keep all other rules', () => {
  const mapping = {host: 'reference-host', approvedBy: 'smithers-22', target: '//fixture:canary'}
  assert.equal(validMapping(JSON.parse(JSON.stringify(mapping))), true)
  for (const change of [{host:'other'}, {approvedBy:'other'}, {command:['echo']}, {paths:[]}, {target:'bad'}, {status:'approved'}]) assert.equal(validMapping({...mapping,...change}), false)
})

test('spike-verdict refuses non-spike checks before remote writes', () => {
  const f = fixture()
  try {
    const out = f.close([], ['--reason','spike-verdict','--note','https://github.com/o/r/issues/7#issuecomment-8'])
    assert.equal(out.code,2); assert.equal(out.out.action,'evidence-refused')
    assert.deepEqual(out.out.checks,[{check:'C-FIX-01',reason:'coverage'},{check:'C-FIX-02',reason:'coverage'}])
    assert.equal(f.writes.length,0)
  } finally { f.cleanup() }
})

test('spike-verdict accepts spike evidence only with the committed reviewer approval', () => {
  const f = fixture()
  try {
    f.put('.specs/engineering/tickets/T-FIX-01.md','Issue: https://github.com/o/r/issues/7\nSpike reviewer: reviewer\n## Acceptance\n- C-FIX-01\n')
    f.put('.specs/engineering/checks/C-FIX-01.md','Layer: spike\nAutomation: manual\n')
    f.commit()
    const artifact = '.artifacts/checks/C-FIX-01/UTC/output.txt'
    const path = '.artifacts/checks/C-FIX-01/UTC/verdict.json'
    f.put(artifact,'observed result')
    const verdict = JSON.stringify({version:1,check:'C-FIX-01',commit:f.sha,variant:'B',artifacts:[{path:artifact,digest:digest('observed result')}]})
    f.put(path,verdict)
    const flags = ['--reason','spike-verdict','--note','https://github.com/o/r/issues/7#issuecomment-8']
    const approval = {user:{login:'reviewer'},issue_url:'https://api.github.com/repos/o/r/issues/7',body:`Approved spike-verdict C-FIX-01 ${f.sha} ${digest(verdict)}`}
    f.approval(approval)
    for (const bad of [{...approval,user:{login:'impostor'}},{...approval,body:'Approved'},{...approval,issue_url:'https://api.github.com/repos/o/r/issues/8'}]) {
      f.approval(bad); assert.equal(f.close([path],flags).code,2); assert.equal(f.writes.length,0)
    }
    f.approval(approval)
    f.put(artifact,'tampered'); assert.equal(f.close([path],flags).code,2); assert.equal(f.writes.length,0)
    f.put(artifact,'observed result')
    // Exercise the executable CLI with the same parsed verdict and remote approval.
    f.recorded()
    const transport = JSON.parse(readFileSync(join(f.root,'transport.json')))
    transport.responses['repos/o/r/issues/comments/8'] = approval
    f.put('transport.json',JSON.stringify(transport))
    const cli = f.cliClose([path],flags)
    assert.equal(cli.status,0,cli.stdout + cli.stderr)
    assert.equal(JSON.parse(readFileSync(join(f.root,'transport.json'))).writes.filter(args => args.includes('state_reason=completed')).length,1)
    assert.equal(f.close([path],flags).code,0)
    assert.equal(f.writes.filter(args => args.includes('state_reason=completed')).length,1)
  } finally { f.cleanup() }
})


test('GitHub check success authenticates artifact claims at recorder boundary', () => {
  for (const change of [
    {status: 'in_progress'}, {status: undefined}, {conclusion: 'failure'},
    {conclusion: 'cancelled'}, {conclusion: 'neutral'}, {conclusion: 'skipped'},
    {conclusion: undefined}, {details_url: 'https://github.com/foreign/repo/actions/runs/7/job/1'}
  ]) {
    const f = fixture()
    try {
      // Keep both the artifact bytes and their GitHub digest valid. Only the
      // authenticated check-run record changes; neither boundary may trust it.
      Object.assign(f.ci().responses[`repos/o/r/commits/${f.sha}/check-runs?per_page=100`].check_runs[0], change)
      const recorded = f.recorded()
      assert.equal(recorded.status, 1, recorded.stdout + recorded.stderr)
      const receipt = JSON.parse(recorded.stdout).receipt
      assert.equal(JSON.parse(readFileSync(join(f.root, receipt))).exit, 1)
      const log = JSON.parse(readFileSync(join(f.root, receipt, '..', 'log.txt')))
      assert.equal(log.reason, 'check_not_successful')
      assert.equal(f.writes.length, 0)
    } finally { f.cleanup() }
  }
})

test('mapping activation is required at recorder, including absent or false approval', () => {
  for (const activation of [undefined, {}, { mappingsApprovedBy: null }, { mappingsApprovedBy: 'impostor' }]) {
    const f = fixture()
    try {
      const mappings = JSON.parse(readFileSync(join(f.root, '.smithers/flows/evidence/check-commands.json')))
      mappings.activation = activation; f.put('.smithers/flows/evidence/check-commands.json', JSON.stringify(mappings)); f.commit()
      const out = f.recorded(); assert.equal(out.status, 2, out.stdout + out.stderr)
      assert.equal(JSON.parse(out.stdout).receipt, undefined)
      assert.equal(f.writes.length, 0)
    } finally { f.cleanup() }
  }
})

test('successful unrelated check cannot authenticate the label job at recorder', () => {
  const f = fixture()
  try {
    const data = f.ci().responses
    data[`repos/o/r/commits/${f.sha}/check-runs?per_page=100`].check_runs.push({ app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', head_sha: f.sha, details_url: 'https://github.com/o/r/actions/runs/7/job/2' })
    data[`repos/o/r/actions/runs/7/attempts/1/jobs?per_page=100`].jobs[0].conclusion = 'failure'
    const out = f.recorded(); assert.equal(out.status, 1, out.stdout + out.stderr)
    assert.equal(JSON.parse(readFileSync(join(f.root, JSON.parse(out.stdout).receipt, '..', 'log.txt'))).reason, 'check_not_successful')
    assert.equal(f.writes.length, 0)
  } finally { f.cleanup() }
})

test('reference-host recorder verifies committed UUID, runner identity, labels and workflow', () => {
  for (const variant of ['pass', 'dispatch', 'empty', 'uuid', 'name', 'id', 'labels', 'workflow', 'event', 'branch', 'job', 'missingUuid', 'summaryName', 'uncommitted']) {
    const f = fixture()
    try {
      f.referenceSetup(variant === 'empty' ? [] : undefined)
      const data = f.ci().responses
      const job = data['repos/o/r/actions/runs/7/attempts/1/jobs?per_page=100'].jobs[0]
      const run = data['repos/o/r/actions/runs/7']
      if (variant === 'dispatch') run.event = 'workflow_dispatch'
      if (variant === 'name') job.runner_name = 'other'
      if (variant === 'id') job.runner_id = 43
      if (variant === 'labels') job.labels = ['self-hosted', 'reference-host']
      if (variant === 'workflow') run.path = '.github/workflows/ci.yml'
      if (variant === 'event') run.event = 'pull_request'
      if (variant === 'branch') run.head_branch = 'branch'
      if (variant === 'job') job.name = 'other'
      if (variant === 'uuid' || variant === 'uncommitted') {
        f.put('packages/smithers/test/support/reference-hosts.json', JSON.stringify({ version: 1, hosts: [{ runnerName: 'reference-host-mac-mini', runnerId: 42, ioPlatformUUID: 'ffffffff-1234-1234-1234-123456789abc' }] }))
        if (variant === 'uuid') f.commit()
      }
      if (variant === 'missingUuid' || variant === 'summaryName') {
        const summary = JSON.parse(readFileSync(join(f.root, 'ci/results.json')))
        if (variant === 'missingUuid') delete summary.referenceHost
        else summary.referenceHost.runnerName = 'other'
        f.put('ci/results.json', JSON.stringify(summary))
        zipFixture(join(f.root, 'ci'), join(f.root, 'artifact.zip'))
        const ci = f.ci(); ci.bytes = readFileSync(join(f.root, 'artifact.zip'))
        data['repos/o/r/actions/runs/7/artifacts?per_page=100'].artifacts[0].digest = digest(ci.bytes)
      }
      const out = f.recorded()
      const passing = ['pass', 'dispatch', 'uncommitted'].includes(variant)
      assert.equal(out.status, passing ? 0 : 1, variant + out.stdout + out.stderr)
      const receipt = JSON.parse(out.stdout).receipt
      const log = JSON.parse(readFileSync(join(f.root, receipt, '..', 'log.txt')))
      assert.equal(log.pass, passing, variant)
      if (!['workflow', 'event', 'branch'].includes(variant)) assert.equal(log.evidence.run, 7)
    } finally { f.cleanup() }
  }
})

test('spike evidence cannot become a target receipt at the recorder boundary', () => {
  const f = fixture()
  try {
    f.put('.specs/engineering/checks/C-FIX-01.md', 'Layer: spike\nAutomation: manual recorded\n'); f.commit()
    const out = f.recorded()
    assert.equal(out.status, 2, out.stdout + out.stderr)
    assert.equal(JSON.parse(out.stdout).receipt, undefined)
    assert.equal(f.writes.length, 0)
  } finally { f.cleanup() }
})
