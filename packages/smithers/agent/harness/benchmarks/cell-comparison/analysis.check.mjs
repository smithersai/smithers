import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, validate, render } from './analysis.mjs'

const manifest = { taskHash: 'fixed', model: 'sol', cohort: 'one', maxTurns: 6, tasks: ['a', 'b'] }
const row = (task, arm, extra = {}) => ({ task, arm, taskHash: 'fixed', model: 'sol', cohort: 'one', maxTurns: 6, outcome: 'correct', elapsedMs: 100, turns: [{ usage: { inputTokens: 10, outputTokens: 2 }, cost: { costUsd: 0.01, costSource: 'estimated' } }], ...extra })
const pairs = () => manifest.tasks.flatMap(t => ['cell', 'tool'].map(a => row(t, a)))
test('refuses incomplete, duplicate and confounded observations', () => {
  const rows = pairs()
  assert.throws(() => validate(manifest, rows.slice(1)), /missing/)
  assert.throws(() => validate(manifest, [...rows, rows[0]]), /duplicate/)
  for (const key of ['model', 'cohort', 'taskHash', 'maxTurns']) {
    assert.throws(() => validate(manifest, [row('a', 'cell', { [key]: 'changed' }), ...rows.slice(1)]), /matched/)
  }
  assert.throws(() => validate(manifest, [row('a', 'cell', { elapsedMs: NaN }), ...rows.slice(1)]), /elapsed/)
  assert.throws(() => validate(manifest, [row('a', 'cell', { outcome: 'invented' }), ...rows.slice(1)]), /outcome/)
})
test('access failures are attempts with unknown cost, never measured task quality', () => {
  const rows = pairs().map(r => ({ ...r, outcome: 'access_failure', turns: [{ error: { code: 'authentication' }, usage: {}, cost: null }] }))
  const result = analyze(manifest, rows)
  assert.equal(result.cell.attempts, 2)
  assert.equal(result.cell.answered, 0)
  assert.equal(result.cell.costUsd, null)
  assert.equal(result.completedPairs, 0)
  assert.equal(result.qualityDifference, null)
  assert.match(render(manifest, rows), /No paired task-quality conclusion/)
})
test('paired uncertainty uses task differences; unknown cost cannot silently become zero', () => {
  const rows = pairs()
  rows[1] = row('a', 'tool', { outcome: 'wrong' })
  rows[3] = row('b', 'tool', { outcome: 'wrong', turns: [{ usage: {} , cost: null }] })
  const result = analyze(manifest, rows)
  assert.equal(result.qualityDifference.estimate, 1)
  assert.equal(result.cell.costUsd, 0.02)
  assert.equal(result.tool.costUsd, null)
  assert.equal(result.tool.pricedTurns, 1)
  assert.ok(result.qualityDifference.low < 1)
  assert.ok(result.qualityDifference.high <= 1)
  assert.deepEqual(analyze(manifest, rows), result)
})
test('HTML embeds all raw data safely and cannot execute model output', () => {
  const rows = pairs()
  rows[0].output = '</script><img src=x onerror=alert(1)>'
  const html = render(manifest, rows)
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('&lt;/script&gt;'))
  assert.ok(!html.includes('<img src=x'))
  assert.ok(html.includes('Raw receipts'))
})
test('rejects malformed costs, rosters and turns at the report boundary', () => {
  const rows = pairs()
  assert.throws(() => validate(manifest, [row('unknown','cell'), ...rows.slice(1)]), /unexpected/)
  assert.throws(() => validate(manifest, [row('a','cell',{elapsedMs:-1}), ...rows.slice(1)]), /elapsed/)
  for (const turns of [null, new Array(7).fill({}), [{cost:{costUsd:-1}}], [{cost:{costUsd:NaN}}]]) {
    assert.throws(() => validate(manifest, [row('a','cell',{turns}), ...rows.slice(1)]), /turns|cost/)
  }
  assert.equal(analyze(manifest, rows.map(r => ({...r,turns:[]}))).cell.costUsd, null)
  assert.equal(analyze(manifest, rows.map(r => ({...r,turns:[{usage:{},cost:{costUsd:0}}]}))).cell.costUsd, 0)
})
test('renders large observed separation and measured ties with explicit uncertainty', () => {
  const m = {...manifest,tasks:Array.from({length:50},(_,i)=>String(i))}
  const rows = m.tasks.flatMap(t => [row(t,'cell'),row(t,'tool',{outcome:'wrong'})])
  assert.match(render(m,rows), /bound excludes zero/)
  assert.match(render(manifest,pairs()), /interval includes zero/)
})
test('cannot publish a vacuous or duplicated task roster as completed measurements', () => {
  for (const tasks of [[], ['a','a'], null]) assert.throws(() => analyze({...manifest,tasks}, []), /roster/)
  for (const maxTurns of [0, 1.5]) assert.throws(() => analyze({...manifest,maxTurns},pairs()), /turn limit/)
})
