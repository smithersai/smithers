import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alive, exited } from '../fixtures/installed-consumer/process-state.mjs'
import { createHash } from 'node:crypto'
import { inventory, compare, config, run } from './host-maintenance-evidence.mjs'

test('independent inventory includes bytes, modes and links without following a retained-home link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-release-'))
  try {
    await mkdir(join(root, 'backups'))
    await writeFile(join(root, 'backups', 'omitted'), 'not authority')
    await writeFile(join(root, 'secret'), 'literal install key', { mode: 0o600 })
    await symlink('/outside/sentinel', join(root, 'home-link'))
    const result = await inventory(root, ['backups'])
    // A link's own mode is 0777 on Linux and follows the umask on macOS; the inventory records the link, not its target.
    const linkMode = (await lstat(join(root, 'home-link'))).mode & 0o777
    assert.deepEqual(result.filter(file => !file.directory), [
      { path: 'home-link', mode: linkMode, link: '/outside/sentinel' },
      { path: 'secret', mode: 0o600, size: 19, sha256: createHash('sha256').update('literal install key').digest('hex') },
    ])
    const before = { at: 'before', tables: [{ name: 'todos', count: 2, sha256: 'literal' }], files: result }
    assert.equal(compare(before, { ...before, at: 'after' }).pass, true)
    for (const changed of [
      { ...before, tables: [{ name: 'todos', count: 3, sha256: 'literal' }] },
      { ...before, files: result.map(file => file.path === 'secret' ? { ...file, mode: 0o644 } : file) },
      { ...before, files: result.map(file => file.path === 'secret' ? { ...file, sha256: 'replaced' } : file) },
      { ...before, files: result.map(file => file.path === 'home-link' ? { ...file, link: '/outside/other' } : file) },
    ]) assert.throws(() => compare(before, changed), /digests differ/)
  } finally { await rm(root, { recursive: true }) }
})

test('Linux recorder refuses before reading configuration or launching installed commands', { skip: process.platform === 'darwin' && process.arch === 'arm64' && process.getuid() !== 0 }, async () => {
  await assert.rejects(config('/missing'), /unprivileged owner on an Apple Silicon Mac/)
})

test('backup recorder checks observed bytes, forbidden trees and secret modes', async () => {
  const { verifyBackup } = await import('./host-maintenance-evidence.mjs')
  const root = await mkdtemp(join(tmpdir(), 'host-manifest-'))
  try {
    await import('node:fs/promises').then(fs => fs.chmod(root, 0o700))
    await mkdir(join(root, 'state', 'config'), { recursive: true })
    await writeFile(join(root, 'state', 'config', 'secrets.json'), 'key', { mode: 0o600 })
    await writeFile(join(root, 'postgres.dump'), 'PGDMP', { mode: 0o600 })
    const files = [
      ['postgres.dump', 'PGDMP'], ['state/config/secrets.json', 'key'],
    ].map(([path, bytes]) => ({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }))
    const m = { version: '1.2.3', postgres_major: 18, schema_version: 2, quiesce_op: 'literal', quiesce_time: '2026-10-07T00:00:00Z', stack: [], branch_heads: {}, machine_disks: [], run_journals: [], files }
    const manifest = join(root, 'MANIFEST.json')
    await writeFile(manifest, JSON.stringify(m))
    assert.equal((await verifyBackup(root)).observed.length, 2)
    await writeFile(join(root, 'postgres.dump'), 'PGDMX')
    await assert.rejects(verifyBackup(root), /backup mismatch: postgres.dump/)
    await writeFile(join(root, 'postgres.dump'), 'PGDMP')
    await import('node:fs/promises').then(fs => fs.chmod(join(root, 'state/config/secrets.json'), 0o644))
    await assert.rejects(verifyBackup(root), /install key must be 0600/)
    await writeFile(manifest, JSON.stringify({ ...m, files: [...files, { path: 'state/postgres/data', size: 0, sha256: 'literal' }] }))
    await assert.rejects(verifyBackup(root), /excluded state authority/)
    await writeFile(manifest, JSON.stringify({ ...m, files: [...files, { path: '../outside', size: 0, sha256: 'literal' }] }))
    await assert.rejects(verifyBackup(root), /unsafe or duplicate/)
  } finally { await rm(root, { recursive: true }) }
})


for (const descendant of [false, true]) test('maintenance deadlines reap a SIGTERM-resistant ' + (descendant ? 'process tree with inherited pipes' : 'child') + ' before rejection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-deadline-')), pidFile = join(root, 'pids')
  t.after(async () => {
    const pids = JSON.parse(await readFile(pidFile, 'utf8'))
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    await rm(root, { recursive: true, force: true })
  })
  const source = [
    'const { spawn } = require("node:child_process")',
    'process.on("SIGTERM", () => {})',
    'const pids = [process.pid]',
    'if (' + descendant + ') pids.push(spawn(process.execPath, ["-e", \'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\'], { stdio: ["ignore", "inherit", "inherit"] }).pid)',
    'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(pids))',
    'setInterval(() => {}, 1000)'
  ].join('\n')
  const began = Date.now()
  await assert.rejects(run(process.execPath, ['-e', source, pidFile], { timeout: 1500 }), /abort|timed out/i)
  const pids = JSON.parse(await readFile(pidFile, 'utf8'))
  assert.equal(alive(pids[0]), false, 'the owned child is reaped before rejection')
  for (const pid of pids.slice(1)) assert.equal(await exited(pid), true, 'the descendant is terminated')
  assert.ok(Date.now() - began < 8000)
})


test('maintenance command receipts retain exit status and separate output streams', async () => {
  const receipt = await run(process.execPath, ['-e', 'console.log("observed"); console.error("diagnostic"); process.exitCode = 7'], { expected: null })
  assert.equal(receipt.status, 7)
  assert.equal(receipt.stdout, 'observed\n')
  assert.equal(receipt.stderr, 'diagnostic\n')
  await assert.rejects(run('/does-not-exist-smithers', []), error => {
    assert.match(error.message, /ENOENT/)
    assert.equal(error.receipt.status, null)
    return true
  })
})

test('maintenance deadline receipts preserve database diagnostic redaction', async () => {
  const database = 'postgresql://owner:synthetic-password@127.0.0.1/example'
  await assert.rejects(run(process.execPath, ['-e', 'console.log("private query output"); setInterval(() => {}, 1000)'], { env: { PGDATABASE: database }, timeout: 500 }), error => {
    assert.equal(error.message, 'database operation failed for 127.0.0.1')
    assert.equal(error.receipt.stdout, '')
    assert.equal(error.receipt.stderr, 'database operation failed for 127.0.0.1')
    assert.equal(error.receipt.status, null)
    assert.ok(!JSON.stringify(error.receipt).includes('synthetic-password'))
    return true
  })
})
