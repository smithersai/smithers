// Real workerd control for the billing ledger and metering queue sinks across
// legacy -> admission -> final fence -> exact restore. An "old" Worker stays on
// legacy code throughout, standing in for invocations that outlive a deploy.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require=createRequire(import.meta.url), wrangler=createRequire(require.resolve('wrangler/package.json'))
const {Miniflare,convertV4MiniflareOptions}=await import(wrangler.resolve('miniflare'))
let input='';for await(const b of process.stdin)input+=b
const {billing,chat,admissionHelper,fenceHelper,publicJwk,migrationId}=JSON.parse(input)
const state=mkdtempSync(join(tmpdir(),'smithers-metering-fence-')),token='test-metering-export-token'.repeat(2)
const legacyBilling=`import { DurableObject } from 'cloudflare:workers';
export class AccountDurableObject extends DurableObject {
 async charge(c){const key='chg:'+c.chargeId;if(await this.ctx.storage.get(key))return 'duplicate';await this.ctx.storage.put(key,{id:c.chargeId,createdAt:new Date().toISOString(),amountNanos:c.quantity*10,resource:c.resource,runId:null});return 'charged';}
 async count(){return (await this.ctx.storage.list({prefix:'chg:'})).size;}
 async fetch(request){return Response.json(await this.charge(await request.json()));}
}
export default {async fetch(request,env){const url=new URL(request.url);
 if(request.method==='POST'&&url.pathname==='/api/billing/charges'){const c=await request.clone().json();return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(c.userId)).fetch(request);}
 if(url.pathname==='/api/billing/authorize')return Response.json({allowed:true});
 return new Response('not found',{status:404});}};`
const legacyChat=`export default {
 async fetch(){return new Response('chat');},
 async queue(batch,env){for(const m of batch.messages){const r=await env.BILLING.fetch('https://billing.smithers.sh/api/billing/charges',{method:'POST',body:JSON.stringify(m.body)});if(r.ok)m.ack();else m.retry();}}};`
const old=`export default {async fetch(request,env){const url=new URL(request.url),body=await request.text();
 if(url.pathname==='/enqueue'){await env.METERING_QUEUE.send(JSON.parse(body));return new Response('sent');}
 if(url.pathname==='/charge')return env.BILLING.fetch('https://billing.smithers.sh/api/billing/charges',{method:'POST',body});
 if(url.pathname==='/rpc'){const c=JSON.parse(body);try{return new Response(await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(c.userId)).charge(c));}catch{return new Response('rpc refused',{status:503});}}
 if(url.pathname==='/count'){try{return new Response(String(await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('user-1')).count()));}catch{return new Response('rpc refused',{status:503});}}
 return new Response('not found',{status:404});}};`
const observer=`export default {async fetch(_r,env){return Response.json((await env.SEEN.list()).keys.map(k=>k.name));},async queue(batch,env){for(const m of batch.messages){await env.SEEN.put(m.body.chargeId,'dead-lettered');m.ack();}}};`
const exportSettings=identity=>({SMITHERS_EXPORT_TOKEN:token,SMITHERS_EXPORT_RECIPIENT:JSON.stringify(publicJwk),SMITHERS_EXPORT_EXPIRES_AT:new Date(Date.now()+600000).toISOString(),SMITHERS_EXPORT_SOURCE_REVISION:'sha256:'+identity.sourceArtifactSHA256,SMITHERS_EXPORT_SOURCE_VERSION:identity.sourceVersion})
const modules=(phase,legacy,side)=>phase==='legacy'?[{type:'ESModule',path:'index.js',contents:legacy}]:
 [{type:'ESModule',path:'cutover-entry.js',contents:side[phase]},{type:'ESModule',path:phase==='admission'?'cutover-admission-helper.js':'cutover-fence-helper.js',contents:phase==='admission'?admissionHelper:fenceHelper},...(phase==='admission'?[{type:'ESModule',path:'index.js',contents:legacy}]:[])]
const options=phase=>convertV4MiniflareOptions({workers:[
 {name:'billing',modulesRoot:'/',modules:modules(phase,legacyBilling,billing),compatibilityDate:'2026-08-01',durableObjects:{ACCOUNTS:{className:'AccountDurableObject',useSQLite:true}},durableObjectsPersist:state,bindings:exportSettings(billing.identity)},
 {name:'chat',modulesRoot:'/',modules:modules(phase,legacyChat,chat),compatibilityDate:'2026-08-01',serviceBindings:{BILLING:'billing'},queueProducers:{METERING_QUEUE:{queueName:'metering'}},
  queueConsumers:{metering:{maxBatchSize:1,maxBatchTimeout:1,maxRetries:2,retryDelay:0,deadLetterQueue:'metering-dlq'}},bindings:exportSettings(chat.identity)},
 {name:'old',modules:[{type:'ESModule',path:'old.js',contents:old}],modulesRoot:'/',compatibilityDate:'2026-08-01',serviceBindings:{BILLING:'billing'},queueProducers:{METERING_QUEUE:{queueName:'metering'}},durableObjects:{ACCOUNTS:{className:'AccountDurableObject',scriptName:'billing'}}},
 {name:'observer',modules:[{type:'ESModule',path:'observer.js',contents:observer}],modulesRoot:'/',compatibilityDate:'2026-08-01',kvNamespaces:{SEEN:'seen'},queueConsumers:{'metering-dlq':{maxBatchSize:1,maxBatchTimeout:1}}}]})
const charge=id=>JSON.stringify({userId:'user-1',chargeId:id,resource:'inference.output_tokens',quantity:3})
const runtime=new Miniflare(options('legacy'))
const call=async(worker,path,body)=>{const w=await runtime.getWorker(worker);const r=await w.fetch('https://'+worker+'.test'+path,{method:'POST',body});return {status:r.status,text:await r.text()}}
const count=async()=>(await call('old','/count','')).text
const until=async(check,label)=>{for(let i=0;i<120;i++){if(await check())return;await new Promise(r=>setTimeout(r,250))}throw new Error('timed out: '+label)}
try{
 assert.equal((await call('old','/charge',charge('legacy-direct'))).status,200)
 await call('old','/enqueue',charge('legacy-queued'));await until(async()=>await count()==='2','legacy queue charge')
 console.error('legacy: direct and queued charges landed')

 await runtime.setOptions(options('admission'))
 assert.equal((await call('old','/charge',charge('admitted-direct'))).status,200,'admission keeps the settlement door')
 await call('old','/enqueue',charge('admitted-queued'));await until(async()=>await count()==='4','admission queue drain')
 const billingWorker=await runtime.getWorker('billing')
 assert.equal((await billingWorker.fetch('https://billing.smithers.sh/api/billing/authorize',{method:'POST'})).status,503,'admission closes new authorizations')
 console.error('admission: new authorization closed, existing usage drained through the original consumer')

 await runtime.setOptions(options('fence'))
 const late=await call('old','/charge',charge('late-direct'))
 assert.equal(late.status,503);assert.equal(JSON.parse(late.text).code,'cutover_maintenance')
 assert.equal((await call('old','/rpc',charge('late-rpc'))).status,503,'fenced object has no legacy RPC')
 assert.equal((await call('old','/count','')).status,503)
 await call('old','/enqueue',charge('late-queued'))
 await until(async()=>JSON.parse((await call('observer','/','')).text).includes('late-queued'),'fenced consumer retries without ACK until dead-lettered')
 console.error('fence: late direct charge, RPC and queued usage refused; queued usage preserved in the DLQ')
 const ns=await runtime.getDurableObjectNamespace('ACCOUNTS','billing'),objectId=ns.idFromName('user-1').toString()
 const exported=await (await runtime.getWorker('billing')).fetch('https://billing.smithers.sh/__maintenance/state-export',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({migrationId,binding:'ACCOUNTS',objectId})})
 assert.equal(exported.status,200)
 const sealed=await exported.text()

 await runtime.setOptions(options('legacy'))
 assert.equal(await count(),'4','restore sees exactly the preserved ledger')
 assert.equal((await call('old','/charge',charge('restored-direct'))).status,200)
 assert.equal(await count(),'5','exact legacy writer authority restored')
 console.error('restore: original ledger preserved and legacy writer restored')
 process.stdout.write(JSON.stringify({sealed,objectId}))
}finally{await runtime.dispose();rmSync(state,{recursive:true,force:true})}
