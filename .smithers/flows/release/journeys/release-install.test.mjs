import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureProcess } from '../release-process.mjs'
import { alive, exited } from '../fixtures/installed-consumer/process-state.mjs'
import { createServer } from 'node:http'
import { classify, command, connections, readiness, journey, pouredBottle, networkCapture } from './release-install.mjs'

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'release-install-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
test('the brew-info boundary requires the named release and a real bottle pour', async t => {
  const evidence = await directory(t)
  const data = { formulae: [{ full_name: 'smithersai/tap/smithers', installed: [{ version: '1.2.3', poured_from_bottle: true }] }] }
  const result = await command(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', JSON.stringify(data)], evidence, 'brew-info')
  assert.equal(pouredBottle(result.stdout, 'v1.2.3').poured_from_bottle, true)
  for (const installed of [[{ version: '1.2.3', poured_from_bottle: false }], [{ version: '1.2.4', poured_from_bottle: true }], [], [{ version: '1.2.3' }]]) {
    data.formulae[0].installed = installed
    assert.throws(() => pouredBottle(JSON.stringify(data), 'v1.2.3'), /keg|bottle/)
  }
  assert.throws(() => pouredBottle('{}', 'v1.2.3'), /keg/)
})
test('connection classification is exact and cannot approve Smithers hosts', () => {
  const roster = { distribution: ['github.com'], provider: ['api.example.org'], registry: ['registry.npmjs.org'], apple: ['apple.com', 'smithers.sh'] }
  for (const [host, result] of [['GITHUB.COM.', 'distribution'], ['api.example.org', 'provider'], ['registry.npmjs.org', 'registry'], ['apple.com', 'apple'], ['smithers.sh', 'forbidden'], ['a.smithers.sh', 'forbidden'], ['jjhub.tech', 'forbidden'], ['evil.github.com', 'unclassified'], ['github.com.evil.org', 'unclassified']]) assert.equal(classify(host, roster), result)
  assert.throws(() => classify('bad/host', roster), /Invalid hostname/)
})
test('production recorder executes argv without a shell and retains timed stdout/stderr', async t => {
  const evidence = await directory(t)
  const receipt = await command(process.execPath, ['-e', 'console.log(process.argv[1]); console.error("diagnostic")', '$(false); literal'], evidence, 'argv')
  assert.equal(receipt.status, 0)
  assert.match(receipt.stdout, /\$\(false\); literal/)
  assert.match(receipt.stderr, /diagnostic/)
  assert.ok(receipt.durationMs > 0)
  const events = (await readFile(join(evidence, 'argv.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(events[0].uid, process.getuid())
  assert.equal(events.at(-1).event, 'end')
  assert.ok(events.every(event => Number.isFinite(Date.parse(event.at))))
})
test('failed commands, privilege prompts, missing executables and timeouts keep evidence', async t => {
  const evidence = await directory(t)
  for (const [name, program, args, timeout, expected] of [
    ['exit', process.execPath, ['-e', 'process.exit(7)'], 1000, /exited 7/],
    ['prompt', process.execPath, ['-e', 'console.log("Password:")'], 1000, /Privilege prompt/],
    ['missing', '/does-not-exist-smithers', [], 1000, /ENOENT/],
    ['timeout', process.execPath, ['-e', 'setInterval(()=>{},1000)'], 30, /timed out/i]
  ]) {
    await assert.rejects(command(program, args, evidence, name, timeout), expected)
    const rows = (await readFile(join(evidence, `${name}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(rows.at(-1).failure)
  }
})
test('readiness uses real HTTP, retries unhealthy responses, and records the transition', async t => {
  const evidence = await directory(t)
  let calls = 0
  const server = createServer((req, res) => { assert.equal(req.url, '/readyz'); res.writeHead(++calls === 1 ? 503 : 200); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const result = await readiness(`http://127.0.0.1:${server.address().port}/readyz`, evidence, 10000)
  assert.equal(result.ready, true)
  assert.deepEqual(result.attempts.map(row => row.status), [503, 200])
  assert.deepEqual(JSON.parse(await readFile(join(evidence, 'readiness.json'), 'utf8')), result)
})
test('unhealthy HTTP retains failure and external or redirect URLs cannot qualify', async t => {
  const evidence = await directory(t)
  const server = createServer((req, res) => { res.writeHead(302, { location: 'https://smithers.sh' }); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  await assert.rejects(readiness(`http://127.0.0.1:${server.address().port}/readyz`, evidence, 40), /timed out/)
  assert.equal(JSON.parse(await readFile(join(evidence, 'readiness.json'), 'utf8')).ready, false)
  for (const url of ['https://127.0.0.1/readyz', 'http://example.org/readyz', 'http://localhost/other', 'http://localhost/readyz?token=x', 'http://owner:secret@localhost/readyz']) await assert.rejects(readiness(url, evidence), /loopback|credentials/)
})
test('resolver export is retained, bounded by session, and unknown connections fail closed', async t => {
  const evidence = await directory(t), path = join(evidence, 'export')
  const raw = ['2026-10-08T00:00:00Z', '2026-10-08T00:01:00Z', '2026-10-08T00:02:00Z'].map(at => JSON.stringify({ at, hostname: 'github.com' })).join('\n')
  await writeFile(path, raw)
  const rows = await connections(path, { distribution: ['github.com'] }, evidence, '2026-10-08T00:01:00Z', '2026-10-08T00:01:00Z')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].category, 'distribution')
  assert.equal(await readFile(join(evidence, 'dns.jsonl'), 'utf8'), raw)
  for (const host of ['smithers.sh', 'unknown.org']) {
    const target = await directory(t)
    await writeFile(path, JSON.stringify({ at: '2026-10-08T00:01:00Z', hostname: host }))
    await assert.rejects(connections(path, {}, target, '2026-10-08T00:00:00Z', '2026-10-08T00:02:00Z'), /forbidden or unclassified/)
    assert.equal(JSON.parse(await readFile(join(target, 'connections.json'), 'utf8'))[0].hostname, host)
  }
})
test('empty and malformed DNS evidence fail; existing evidence cannot be overwritten', async t => {
  const evidence = await directory(t), path = join(evidence, 'export')
  await writeFile(path, '')
  await assert.rejects(connections(path, {}, evidence, '2026-10-08', '2026-10-09'), /Empty/)
  await assert.rejects(connections(path, {}, evidence, '2026-10-08', '2026-10-09'), /EEXIST/)
  const other = await directory(t)
  await writeFile(path, '{"at":"invalid","hostname":"github.com"}')
  await assert.rejects(connections(path, {}, other, '2026-10-08', '2026-10-09'), /timestamp/)
})
test('Linux execution refuses install qualification before reading config', { skip: process.platform === 'darwin' && process.arch === 'arm64' && process.getuid() !== 0 }, async () => {
  await assert.rejects(journey('/does-not-exist'), /unprivileged Apple Silicon/)
})


test('an exclusive log open fails before its command starts and remains catchable', async t => {
  const evidence = await directory(t), marker = join(evidence, 'started')
  await writeFile(join(evidence, 'existing.jsonl'), 'earlier evidence')
  const source = [
    'import { command } from ' + JSON.stringify(new URL('./release-install.mjs', import.meta.url).href),
    'try {',
    'await command(process.execPath, ["-e", \'require("node:fs").writeFileSync(process.argv[1], "started")\', ' + JSON.stringify(marker) + '], ' + JSON.stringify(evidence) + ', "existing")',
    'process.exitCode = 2',
    '} catch (error) { console.log(JSON.stringify({ failure: error.receipt?.failure, code: error.code })) }'
  ].join('\n')
  const result = await captureProcess(process.execPath, ['--input-type=module', '-e', source], process.cwd())
  assert.equal(result.ok, true, result.output)
  assert.match(result.output, /EEXIST/)
  await assert.rejects(access(marker), /ENOENT/)
  assert.equal(await readFile(join(evidence, 'existing.jsonl'), 'utf8'), 'earlier evidence')
})

for (const descendant of [false, true]) test('a command deadline reaps its SIGTERM-resistant ' + (descendant ? 'process tree with inherited pipes' : 'child') + ' before reporting failure', async t => {
  const evidence = await directory(t), pidFile = join(evidence, 'pids')
  let pids = []
  t.after(() => { for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL') })
  const source = [
    'const { spawn } = require("node:child_process")',
    'process.on("SIGTERM", () => {})',
    'const pids = [process.pid]',
    'if (' + descendant + ') pids.push(spawn(process.execPath, ["-e", \'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\'], { stdio: ["ignore", "inherit", "inherit"] }).pid)',
    'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(pids))',
    'setInterval(() => {}, 1000)'
  ].join('\n')
  const began = Date.now()
  await assert.rejects(command(process.execPath, ['-e', source, pidFile], evidence, 'deadline', 1500), error => {
    assert.match(error.receipt.failure, /abort|timed out/i)
    assert.equal(error.receipt.status, null)
    return true
  })
  pids = JSON.parse(await readFile(pidFile, 'utf8'))
  assert.equal(alive(pids[0]), false, 'the owned child is reaped before rejection')
  for (const pid of pids.slice(1)) assert.equal(await exited(pid), true, 'the descendant is terminated')
  assert.ok(Date.now() - began < 8000, 'inherited pipes cannot hold the recorder open')
  const rows = (await readFile(join(evidence, 'deadline.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.match(rows.at(-1).failure, /abort|timed out/i)
})


test('network capture opens exclusive evidence before starting its process', async t => {
  const evidence = await directory(t), marker = join(evidence, 'started')
  await writeFile(join(evidence, 'nettop.jsonl'), 'earlier capture')
  await assert.rejects(networkCapture(evidence, {
    program: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', marker]
  }), /EEXIST/)
  await assert.rejects(access(marker), /ENOENT/)
  assert.equal(await readFile(join(evidence, 'nettop.jsonl'), 'utf8'), 'earlier capture')
})

test('network startup failure closes its log and remains catchable', async t => {
  const evidence = await directory(t)
  await assert.rejects(networkCapture(evidence, { program: '/does-not-exist-smithers' }), /ENOENT/)
  assert.equal(await readFile(join(evidence, 'nettop.jsonl'), 'utf8'), '')
})

async function until(check) {
  const began = Date.now()
  for (;;) {
    try { if (await check()) return } catch (error) { if (error.code !== 'ENOENT') throw error }
    assert.ok(Date.now() - began < 5000, 'process checkpoint reached within budget')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('network stop drains evidence and reaps a resistant process tree with inherited pipes', async t => {
  const evidence = await directory(t), pidFile = join(evidence, 'pids')
  const source = [
    'process.on("SIGTERM", () => {})',
    'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] })',
    'require("node:fs").writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]))',
    'console.log("route sample"); console.error("capture diagnostic")',
    'setInterval(() => {}, 1000)'
  ].join('\n')
  const capture = await networkCapture(evidence, { program: process.execPath, args: ['-e', source, pidFile] })
  t.after(() => capture.stop())
  await until(async () => (await readFile(join(evidence, 'nettop.jsonl'), 'utf8')).includes('capture diagnostic'))
  const result = await capture.stop()
  assert.equal(result.failure, undefined)
  assert.ok(result.samples > 0)
  const pids = JSON.parse(await readFile(pidFile, 'utf8'))
  assert.equal(alive(pids[0]), false)
  assert.equal(await exited(pids[1]), true)
  assert.deepEqual(await capture.stop(), result)
  const rows = (await readFile(join(evidence, 'nettop.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(rows.some(row => row.stream === 'stdout' && row.text.includes('route sample')))
  assert.ok(rows.some(row => row.stream === 'stderr' && row.text.includes('capture diagnostic')))
})

test('an early network exit retains a failed capture instead of qualifying it', async t => {
  const evidence = await directory(t)
  const capture = await networkCapture(evidence, { program: process.execPath, args: ['-e', 'console.log("partial"); process.exitCode = 7'] })
  const result = await capture.done
  assert.match(result.failure.message, /nettop exited early or failed: 7/)
  assert.ok(result.samples > 0)
  assert.match(await readFile(join(evidence, 'nettop.jsonl'), 'utf8'), /partial/)
})


// Runs in a real file-size-limited process, so both open-success/write-failure
// ordering and cancellation cross the production filesystem/process boundary.
async function limitedRecording({ kind, evidence, pidFile, moduleURL }) {
  const { default: assert } = await import('node:assert/strict')
  const { readFile } = await import('node:fs/promises')
  const { command, networkCapture } = await import(moduleURL)
  process.on('SIGXFSZ', () => {})
  const controller = new AbortController()
  const installPidFile = evidence + '/install-pid'
  try {
    let active
    if (kind === 'network') {
      const args = ['-e', [
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid))',
        'process.on("SIGTERM", () => {})',
        'setInterval(() => {}, 1000)'
      ].join('\n'), installPidFile]
      active = command(process.execPath, args, evidence, 'active-install', 5000, controller.signal)
        .then(receipt => ({ receipt }), error => ({ error }))
      for (let attempt = 0;; attempt++) {
        try { await readFile(installPidFile); break }
        catch (error) { if (error.code !== 'ENOENT' || attempt > 500) throw error }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    const args = ['-e', [
      'process.on("SIGTERM", () => {})',
      'require("node:fs").writeFileSync(process.argv[1], String(process.pid))',
      'process.stdout.write("x".repeat(32768))',
      'setInterval(() => {}, 1000)'
    ].join('\n'), pidFile]
    let failure
    if (kind === 'command') {
      try { await command(process.execPath, args, evidence, 'write-failure', 5000) }
      catch (error) { failure = error.receipt?.failure }
    } else {
      const capture = await networkCapture(evidence, { program: process.execPath, args })
      capture.done.then(result => controller.abort(result.failure))
      failure = (await capture.done).failure?.message
      const stopped = await active
      assert.match(stopped.error.receipt.failure, /EFBIG/)
      const installPid = Number(await readFile(installPidFile, 'utf8'))
      assert.throws(() => process.kill(installPid, 0), { code: 'ESRCH' })
    }
    assert.match(failure, /EFBIG/)
    const pid = Number(await readFile(pidFile, 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    console.log(JSON.stringify({ failure, reaped: true }))
  } finally {
    for (const path of [pidFile, installPidFile]) {
      let pid
      try { pid = Number(await readFile(path, 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      try { process.kill(pid, 'SIGKILL') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
}

for (const kind of ['command', 'network']) test(kind + ' disk-write failure is catchable and reaps its process before returning', { skip: process.platform !== 'linux' }, async t => {
  const evidence = await directory(t), pidFile = join(evidence, 'pid')
  const source = 'await (' + limitedRecording.toString() + ')(' + JSON.stringify({
    kind, evidence, pidFile, moduleURL: new URL('./release-install.mjs', import.meta.url).href
  }) + ')'
  const result = await captureProcess('/bin/bash', ['-c', 'ulimit -f 4; exec "$@"', 'file-limit', process.execPath, '--input-type=module', '-e', source], process.cwd(), { timeoutMs: 10000 })
  assert.equal(result.ok, true, result.output)
  assert.match(result.output, /"reaped":true/)
})
