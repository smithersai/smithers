// Read-only verifier of measured artifacts. Invoke with an absolute campaign path.
import { Effect, FileSystem } from 'effect'
import { NodeHost } from '@smthrs/platform-node'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { analyze, render } from './analysis.mjs'
const root = fileURLToPath(new URL('.',import.meta.url))
const out = process.argv[2]
if (!out?.startsWith(root)) throw new Error('Expected campaign path under this benchmark directory')
await Effect.runPromise(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const read = name => fs.readFileString(`${out}/${name}`)
  const manifest = JSON.parse(yield* read('manifest.json'))
  const hashes = JSON.parse(yield* read('receipts.sha256.json'))
  const sha = text => createHash('sha256').update(text).digest('hex')
  if (!manifest.probe && manifest.tasks.length < 50) throw new Error('Campaign requires at least fifty fixed tasks')
  if (sha(yield* fs.readFileString(`${root}tasks.json`)) !== manifest.taskHash) throw new Error('Task corpus changed')
  for (const [name, hash] of Object.entries(manifest.sourceHashes)) {
    if (sha(gunzipSync(yield* fs.readFile(`${out}/sources/${name}.gz`)).toString('utf8')) !== hash) throw new Error(`Source changed: ${name}`)
  }
  const rows = []
  for (const [index, task] of manifest.tasks.entries()) for (const arm of index % 2 ? ['tool','cell'] : ['cell','tool']) {
    const name = `${task}-${arm}.json`
    const bytes = yield* read(name)
    if (sha(bytes) !== hashes[name]) throw new Error(`Receipt changed: ${name}`)
    const row = JSON.parse(bytes)
    if (row.task !== task || row.arm !== arm) throw new Error(`Receipt identity mismatch: ${name}`)
    const definition = manifest.corpus.find(t => t.id === task)
    if (row.seed !== definition.seed || row.family !== definition.family) throw new Error(`Task metadata mismatch: ${name}`)
    for (const turn of row.turns) {
      if (turn.request.modelId !== manifest.model || turn.request.params.reasoningEffort !== manifest.requestedReasoning || turn.request.messages[0].content[0].text !== definition.instruction) throw new Error(`Unmatched model request: ${name}`)
    }
    rows.push(row)
  }
  if (Object.keys(hashes).length !== rows.length) throw new Error('Receipt roster changed')
  if (JSON.stringify(analyze(manifest,rows)) !== JSON.stringify(JSON.parse(yield* read('summary.json')))) throw new Error('Summary differs from observations')
  if (render(manifest,rows) !== (yield* read('report.html'))) throw new Error('Report differs from observations')
  console.log(`VERIFIED ${manifest.tasks.length} matched tasks, ${rows.length} raw receipts, corpus/source hashes, summary and self-contained report`)
}).pipe(Effect.provide(NodeHost.layer)))
