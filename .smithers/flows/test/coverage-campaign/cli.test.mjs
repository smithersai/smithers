import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const main = fileURLToPath(new URL('./main.mjs', import.meta.url))
const invoke = args => spawnSync(process.execPath, [main, ...args], { encoding: 'utf8' })

test('real bootstrap distinguishes snapshot, default status, gate refusal and invalid mode', () => {
  const snapshot = invoke(['snapshot'])
  assert.equal(snapshot.status, 0, snapshot.stderr)
  assert.equal(JSON.parse(snapshot.stdout).campaignComplete, false)
  const status = invoke([])
  assert.equal(status.status, 0, status.stderr)
  const summary = JSON.parse(status.stdout)
  assert.equal(summary.inventoryFresh, true)
  assert.equal(summary.complete, false)
  assert.equal(summary.passed, 0)
  assert.ok(summary.missing.length > 600)
  const gate = invoke(['gate'])
  assert.equal(gate.status, 1)
  assert.equal(JSON.parse(gate.stdout).complete, false)
  assert.match(gate.stderr, /No pass was recorded/)
  const invalid = invoke(['not-a-mode'])
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /No pass was recorded/)
})
