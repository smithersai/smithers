// Local dress rehearsal of REHEARSAL.md in real workerd: scratch + probe with real
// D1/R2/KV/queue/ratelimit/assets bindings, driven original -> admission -> fence -> original.
// Proves the scratch/probe code and the admission/fence modules work together; it cannot
// prove Cloudflare's own binding re-serialization, which only the isolated remote rehearsal can.
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const here=dirname(fileURLToPath(import.meta.url))
const require=createRequire(import.meta.url), wrangler=createRequire(require.resolve('wrangler/package.json'))
const {Miniflare,convertV4MiniflareOptions}=await import(wrangler.resolve('miniflare'))
let input='';for await(const b of process.stdin)input+=b
const {admission,fence,admissionHelper,fenceHelper}=JSON.parse(input)
const scratch=readFileSync(join(here,'scratch.js'),'utf8'),probe=readFileSync(join(here,'probe.js'),'utf8'),state=mkdtempSync(join(tmpdir(),'rehearsal-local-'))
const modules={original:[{type:'ESModule',path:'index.js',contents:scratch}],
 admission:[{type:'ESModule',path:'cutover-admission-entry.js',contents:admission},{type:'ESModule',path:'cutover-admission-helper.js',contents:admissionHelper},{type:'ESModule',path:'index.js',contents:scratch}],
 fence:[{type:'ESModule',path:'cutover-fence-entry.js',contents:fence},{type:'ESModule',path:'cutover-fence-helper.js',contents:fenceHelper},{type:'ESModule',path:'index.js',contents:scratch}]}
const options=phase=>convertV4MiniflareOptions({workers:[
 {name:'smithers-cutover-rehearsal-r1',modulesRoot:'/',modules:modules[phase],compatibilityDate:'2026-08-01',durableObjects:{TURN_CANCELS:{className:'TurnCancelRegistry',useSQLite:true}},durableObjectsPersist:state,
  d1Databases:{DB:'rehearsal-db'},d1Persist:state,r2Buckets:{BUCKET:'rehearsal-bucket'},r2Persist:state,kvNamespaces:{KV:'rehearsal-kv'},kvPersist:state,
  queueProducers:{QUEUE:{queueName:'rehearsal-queue'}},queueConsumers:{'rehearsal-queue':{maxBatchSize:1,maxBatchTimeout:1,maxRetries:2,deadLetterQueue:'rehearsal-dlq'}},
  ratelimits:{LIMITER:{namespace_id:'97001',simple:{limit:10,period:60}}},assets:{directory:join(here,'assets'),binding:'ASSETS'},
  bindings:{MODE:'rehearsal',REHEARSAL_SECRET:'scratch-only-secret'}},
 {name:'smithers-cutover-rehearsal-p1',modulesRoot:'/',modules:[{type:'ESModule',path:'probe.js',contents:probe}],compatibilityDate:'2026-08-01',durableObjects:{TARGET:{className:'TurnCancelRegistry',scriptName:'smithers-cutover-rehearsal-r1'}}}]})
const runtime=new Miniflare(options('original'))
const selftest=async()=>{const r=await (await runtime.getWorker('smithers-cutover-rehearsal-p1')).fetch('https://probe.test/selftest');return {status:r.status,body:await r.text()}}
const results={}
try{
 const db=await runtime.getD1Database('DB','smithers-cutover-rehearsal-r1')
 await db.exec("CREATE TABLE rehearsal (k TEXT PRIMARY KEY, v TEXT)");await db.exec("INSERT INTO rehearsal VALUES ('probe', 'd1-ok')")
 await (await runtime.getR2Bucket('BUCKET','smithers-cutover-rehearsal-r1')).put('probe.txt','r2-ok\n')
 await (await runtime.getKVNamespace('KV','smithers-cutover-rehearsal-r1')).put('probe','kv-ok')
 results.baseline=await selftest()
 await runtime.setOptions(options('admission'));results.admission=await selftest()
 await runtime.setOptions(options('fence'));results.fenced=await selftest()
 await runtime.setOptions(options('original'));results.restored=await selftest()
 process.stdout.write(JSON.stringify(results))
}finally{await runtime.dispose();rmSync(state,{recursive:true,force:true})}
