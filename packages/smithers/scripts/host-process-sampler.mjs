import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { appendFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactDiagnostic } from '@smthrs/journal/Redaction'
const exec = promisify(execFile)
// Parallel coding agents can put more than 1 MiB of argv in a ps snapshot.
// Keep a finite bound, but retain the complete inventory on the reference host.
const execute = (file, args) => exec(file, args, { maxBuffer: 16 * 1024 * 1024 })
// A sampled command line carries every argument of the process, a `--token`
// value included, and the evidence outlives the check. Selection reads the
// in-memory rows; only redacted records reach disk, readable by the owner alone.
const evidenceDirectory = { recursive: true, mode: 0o700 }
const evidenceFile = { mode: 0o600 }
const record = value => JSON.stringify(redactDiagnostic(value)) + '\n'
export function descendants(text, rootPid) {
  const rows = text.split('\n').flatMap(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    return m ? [{ pid: +m[1], ppid: +m[2], uid: +m[3], command: m[4] }] : []
  })
  const ids = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true }
  }
  return rows.filter(row => ids.has(row.pid))
}
export async function sample({ rootPid, label, directory, exec = execute, now = () => new Date().toISOString() }) {
  await mkdir(directory, evidenceDirectory)
  await appendFile(join(directory, 'lsof-samples.jsonl'), '', evidenceFile)
  const at = now()
  if (label) {
    const job = await exec('launchctl', ['print', label])
    rootPid = Number(job.stdout.match(/\bpid = (\d+)/)?.[1])
  }
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('sampler: live root PID required')
  const result = await exec('ps', ['-axo', 'pid,ppid,uid,command'])
  const processes = descendants(result.stdout, rootPid)
  await appendFile(join(directory, 'process-samples.jsonl'), record({ at, root: rootPid, processes }), evidenceFile)
  for (const row of processes) {
    const binary = row.command.split(/\s+/)[0].split('/').at(-1)
    if (!/^(node|bun|smithers-.*)$/.test(binary)) continue
    let observation
    try { const result = await exec('lsof', ['-p', String(row.pid), '-Fn']); observation = { stdout: result.stdout, stderr: result.stderr ?? '', exitCode: 0 } }
    catch (error) { observation = { exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr || error.message } }
    await appendFile(join(directory, 'lsof-samples.jsonl'), record({ at, ...row, ...observation }), evidenceFile)
  }
  return { rootPid, processes }
}
export async function monitor(options, { signal, interval = 250, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = Date.now } = {}) {
  while (!signal?.aborted) {
    const start = clock()
    const observation = await sample(options)
    if (!observation.processes.some(row => row.pid === observation.rootPid)) break
    if (!signal?.aborted) await sleep(Math.max(0, interval - (clock() - start)))
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    pid: { type: 'string' }, label: { type: 'string' }, output: { type: 'string' }, interval: { type: 'string', default: '250' }
  } })
  const rootPid = Number(values.pid), interval = Number(values.interval)
  if ((!values.label && (!Number.isSafeInteger(rootPid) || rootPid <= 1)) || (values.label && values.pid) || !values.output || !Number.isSafeInteger(interval) || interval < 25) throw new Error('usage: host-process-sampler.mjs --pid <pid> | --label <launchd domain/label> --output <directory> [--interval 250]')
  const controller = new AbortController()
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => controller.abort())
  await monitor({ rootPid, label: values.label, directory: values.output }, { signal: controller.signal, interval })
}
