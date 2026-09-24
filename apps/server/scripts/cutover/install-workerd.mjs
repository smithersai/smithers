// Runs the exact module sets the installer uploaded (original, admission, fence)
// in real workerd and checks HTTP, Durable Object RPC, alarms and the queue
// consumer, then restores the original modules over the same persisted storage.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require=createRequire(import.meta.url), wrangler=createRequire(require.resolve('wrangler/package.json'))
const {Miniflare,convertV4MiniflareOptions}=await import(wrangler.resolve('miniflare'))
let input='';for await(const b of process.stdin)input+=b
const {phases,migrationId}=JSON.parse(input) // phase -> {entry, modules:[{name,source}], bindings:{name:string}}
const state=mkdtempSync(join(tmpdir(),'smithers-install-fence-'))
const old=`export default {async fetch(request,env){const url=new URL(request.url),c=url.searchParams.get('v')??'';const stub=env.CHAT_HISTORY.get(env.CHAT_HISTORY.idFromName('conversation-1'));
 try{if(url.pathname==='/enqueue'){await env.METERING_QUEUE.send({chargeId:c});return new Response('sent');}
  if(url.pathname==='/put')return new Response(await stub.put(c));if(url.pathname==='/get')return new Response(String(await stub.get(c)));
  if(url.pathname==='/arm')return new Response(String(await stub.arm(Number(c))));}catch{return new Response('rpc refused',{status:503});}
 return new Response('nf',{status:404});}};`
const observer=`export default {async fetch(_r,env){return Response.json((await env.SEEN.list()).keys.map(k=>k.name));},async queue(batch,env){for(const m of batch.messages){await env.SEEN.put(m.body.chargeId,'dead-lettered');m.ack();}}};`
const options=phase=>{const p=phases[phase];return convertV4MiniflareOptions({workers:[
 {name:'target',modulesRoot:'/',modules:[p.modules.find(m=>m.name===p.entry),...p.modules.filter(m=>m.name!==p.entry&&m.name.endsWith('.js'))].map(m=>({type:'ESModule',path:m.name,contents:m.source})),compatibilityDate:'2026-08-01',
  durableObjects:{CHAT_HISTORY:{className:'ChatHistory',useSQLite:true},PUSH_SUBSCRIPTIONS:{className:'PushSubscriptions',useSQLite:true}},durableObjectsPersist:state,bindings:p.bindings,
  queueConsumers:{metering:{maxBatchSize:1,maxBatchTimeout:1,maxRetries:2,retryDelay:0,deadLetterQueue:'metering-dlq'}}},
 {name:'old',modules:[{type:'ESModule',path:'old.js',contents:old}],modulesRoot:'/',compatibilityDate:'2026-08-01',queueProducers:{METERING_QUEUE:{queueName:'metering'}},durableObjects:{CHAT_HISTORY:{className:'ChatHistory',scriptName:'target'}}},
 {name:'observer',modules:[{type:'ESModule',path:'observer.js',contents:observer}],modulesRoot:'/',compatibilityDate:'2026-08-01',kvNamespaces:{SEEN:'seen'},queueConsumers:{'metering-dlq':{maxBatchSize:1,maxBatchTimeout:1}}}]})}
const runtime=new Miniflare(options('original'))
const call=async(worker,path)=>{const r=await (await runtime.getWorker(worker)).fetch('https://'+worker+'.test'+path,{method:'POST'});return {status:r.status,text:await r.text()}}
const until=async(check,label)=>{for(let i=0;i<120;i++){if(await check())return;await new Promise(r=>setTimeout(r,250))}throw new Error('timed out: '+label)}
try{
 assert.equal((await call('old','/put?v=kept')).text,'stored')
 console.error('original: RPC write landed')

 await runtime.setOptions(options('admission'))
 const closed=await call('target','/api/chat');assert.equal(closed.status,503);assert.equal(JSON.parse(closed.text).code,'cutover_admission_closed')
 assert.equal((await call('old','/get?v=kept')).text,'yes','admission keeps legacy RPC for admitted work')
 // Admission deliberately keeps legacy alarms, so arm with a lead long enough to land the fence first.
 const alarmAt=Date.now()+8000;assert.equal((await call('old','/arm?v='+alarmAt)).text,String(alarmAt))
 console.error('admission: new chat closed, admitted RPC preserved')

 await runtime.setOptions(options('fence'))
 if(Date.now()>=alarmAt)throw new Error('harness too slow: fence landed after the alarm time; result would say nothing about the fence')
 const fenced=await call('target','/api/chat');assert.equal(fenced.status,503);assert.equal(JSON.parse(fenced.text).code,'cutover_maintenance')
 assert.equal((await call('old','/put?v=late')).status,503,'fenced object refuses legacy RPC')
 await call('old','/enqueue?v=late-usage')
 await until(async()=>JSON.parse((await call('observer','/')).text).includes('late-usage'),'fenced consumer retries without ACK until dead-lettered')
 while(Date.now()<alarmAt+2000)await new Promise(r=>setTimeout(r,250))
 const ns=await runtime.getDurableObjectNamespace('CHAT_HISTORY','target'),objectId=ns.idFromName('conversation-1').toString()
 const exported=await (await runtime.getWorker('target')).fetch('https://target.test/__maintenance/state-export',{method:'POST',headers:{authorization:'Bearer '+phases.fence.bindings.SMITHERS_EXPORT_TOKEN,'content-type':'application/json'},body:JSON.stringify({migrationId,binding:'CHAT_HISTORY',objectId})})
 assert.equal(exported.status,200)
 const sealed=await exported.text()
 console.error('fence: HTTP, RPC and queue ACK refused; sealed state exported after the alarm time')

 await runtime.setOptions(options('original'))
 assert.equal((await call('old','/get?v=kept')).text,'yes','restore sees preserved storage')
 assert.equal((await call('old','/get?v=late')).text,'no','late write never landed')
 console.error('restore: original modules serve the preserved state')
 process.stdout.write(JSON.stringify({sealed,objectId,alarmAt}))
}finally{await runtime.dispose();rmSync(state,{recursive:true,force:true})}
