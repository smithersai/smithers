// Benchmark CLI boundary. Host IO is provided by the Node host's Effect services.
import { Flow, FlowRuntime } from '@smthrs/flow'
import { Node } from '@smthrs/plan'
import { NodeHost, NodeRuntime } from '@smthrs/platform-node'
import { Auth, Model, ModelError, OpenAIChatGPT, Pricing, RequestExecutor, Route } from '@smthrs/model'
import { Config, Effect, FileSystem, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { measure, prompts, tools } from './measure.mjs'
import { analyze, render } from './analysis.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const taskBytes = await Effect.runPromise(Effect.flatMap(FileSystem.FileSystem, fs => fs.readFileString(`${directory}tasks.json`)).pipe(Effect.provide(NodeHost.layer)))
const allTasks = JSON.parse(taskBytes).tasks
const probe = process.argv.includes('--probe')
const tasks = probe ? allTasks.slice(0,1) : allTasks
const out = process.argv[2]
if (!out?.startsWith(directory)) throw new Error('Output must be a fresh absolute directory under this benchmark directory')
const metadata = await Effect.runPromise(Effect.gen(function*() {
  const model = yield* Config.String('CELL_BENCH_MODEL').pipe(Config.withDefault('gpt-6-luna'))
  const cohort = yield* Config.String('CELL_BENCH_COHORT').pipe(Config.withDefault('configured-subscription'))
  const file = yield* Config.String('CELL_BENCH_CREDENTIAL_FILE').pipe(Config.withDefault(''))
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(out)
  yield* fs.makeDirectory(`${out}/sources`)
  const sources = {}
  for (const name of ['run.mjs','measure.mjs','analysis.mjs','verify.mjs','tasks.json']) {
    const bytes = yield* fs.readFileString(`${directory}${name}`)
    sources[name] = sha(bytes)
    yield* fs.writeFile(`${out}/sources/${name}.gz`, gzipSync(bytes), { flag: 'wx' })
  }
  const catalog = yield* fs.readFileString(file.replace(/[^/]+$/, 'models_cache.json')).pipe(Effect.map(text => { const c = JSON.parse(text); return { fetchedAt: c.fetched_at, models: c.models.map(m => m.slug) } }), Effect.catch(() => Effect.succeed(null)))
  return { model, cohort, file, sources, catalog }
}).pipe(Effect.provide(NodeHost.layer)))
const signedAuth = {
  credentialHeaders: ['Authorization', 'chatgpt-account-id'],
  sign: headers => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(metadata.file).pipe(Effect.mapError(() => new ModelError.ModelError({ code: 'authentication', message: 'Named credential file is unavailable.' })))
    const auth = yield* Effect.try({ try: () => JSON.parse(text), catch: () => new ModelError.ModelError({ code: 'authentication', message: 'Named credential file is invalid JSON.' }) })
    if (typeof auth.tokens?.access_token !== 'string' || typeof auth.tokens?.account_id !== 'string') return yield* Effect.fail(new ModelError.ModelError({ code: 'authentication', message: 'Named credential has no subscription access token/account.' }))
    const bearer = Auth.bearer(Redacted.make(auth.tokens.access_token))
    return { ...(yield* bearer.sign(headers)), 'chatgpt-account-id': auth.tokens.account_id }
  }).pipe(Effect.provide(NodeHost.layer))
}
const route = Result.getOrThrow(OpenAIChatGPT.make({ auth: signedAuth }))
const modelLayer = Route.layer(route).pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))
const manifest = {
  version: 1, createdAt: new Date().toISOString(), issue: 1846, probe, taskHash: sha(taskBytes),
  corpus: tasks, tasks: tasks.map(t => t.id), model: metadata.model, cohort: metadata.cohort,
  credentialSource: 'CELL_BENCH_CREDENTIAL_FILE (read at sign time; value excluded)',
  modelCatalogObservation: metadata.catalog, endpoint: 'ChatGPT subscription Responses', requestedReasoning: 'low', providerSeed: null, fixtureSeeds: tasks.map(t => t.seed),
  maxTurns: 6, attemptsPerCall: 1, order: 'sequential tasks; alternating cell/tool first',
  sourceHashes: metadata.sources, prompts, tools, priceCard: Pricing.lookup(metadata.model) ?? null,
  costBasis: 'SDK table estimate if available; subscription invoice unavailable', runtime: process.version,
  sourceRevision: process.env.CELL_BENCH_SOURCE_REVISION ?? 'unrecorded',
  limitations: ['fixed synthetic convenience corpus', 'one model/cohort', 'one sample per task-arm', 'provider sampling seed unavailable', 'requested model alias; immutable server snapshot not exposed']
}
const flow = Flow.make('cell-comparison/measure', {
  description: 'Measure one immutable task/arm with recorded model calls and records reads.',
  capabilities: ['model:call:*'], effects: [],
  payload: { task: Schema.String, arm: Schema.Literals(['cell','tool']) }, success: Schema.Json,
  body: Node.capture({ implementationVersion: 'cell-comparison/v1' }, () => Node.succeed(null))
})
const registration = Layer.effectDiscard(Effect.gen(function*() {
  const engine = yield* FlowRuntime.FlowRuntime
  const model = yield* Model.Model
  yield* engine.register(flow, (payload, executionId) => measure(tasks.find(t => t.id === payload.task), payload.arm, { ...manifest, route, executionId }).pipe(Effect.provideService(Model.Model, model)))
})).pipe(Layer.provide(modelLayer))
const runtime = ManagedRuntime.make(NodeRuntime.layerHost({ filename: `${out}/engine.sqlite`, workspaceRoot: directory, owner: { hostId: 'cell-comparison-sm-b30' } }, registration))
const write = (name, value) => Effect.runPromise(Effect.flatMap(FileSystem.FileSystem, fs => fs.writeFileString(`${out}/${name}`, typeof value === 'string' ? value : `${JSON.stringify(value,null,2)}\n`, { flag: 'wx' })).pipe(Effect.provide(NodeHost.layer)))
await write('manifest.json', manifest)
const rows = []
try {
  for (const [index, task] of tasks.entries()) {
    for (const arm of index % 2 ? ['tool','cell'] : ['cell','tool']) {
      const executionId = `cell-comparison/${manifest.taskHash}/${index}/${arm}/${manifest.createdAt}`
      const row = await runtime.runPromise(flow.execute({ task: task.id, arm }, { executionId }))
      await write(`${task.id}-${arm}.json`, row)
      rows.push(row)
      console.log(`${rows.length}/${tasks.length*2} ${task.id} ${arm}: ${row.outcome} (${row.turns.length} turns)`)
    }
  }
  await write('summary.json', analyze(manifest, rows))
  await write('report.html', render(manifest, rows))
  const hashes = {}
  for (const row of rows) {
    const name = `${row.task}-${row.arm}.json`
    hashes[name] = sha(`${JSON.stringify(row,null,2)}\n`)
  }
  await write('receipts.sha256.json', hashes)
  console.log('MEASURED', rows.length, 'task-arm receipts; report written')
} finally { await runtime.dispose() }
