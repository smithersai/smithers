// Real workerd: a legacy alarm is interrupted by the final fence and retried
// across a runtime restart until the runtime itself drops it (real local
// exhaustion; nothing simulated). The original code is then restored and the
// object re-fenced. The reserved marker must survive all of it without ever
// entering product key-value storage or running the legacy callback.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require=createRequire(import.meta.url), wrangler=createRequire(require.resolve('wrangler/package.json'))
const {Miniflare,convertV4MiniflareOptions}=await import(wrangler.resolve('miniflare'))
let input='';for await(const b of process.stdin)input+=b
const {helper,entry,identity,publicJwk,privateJwk}=JSON.parse(input) // ephemeral test key pair
const state=mkdtempSync(join(tmpdir(),'smithers-alarm-fence-')),token='alarm-export-token'.repeat(3)
const legacy=`import { DurableObject } from 'cloudflare:workers';
export class TurnCancelRegistry extends DurableObject {
 async arm(at){await this.ctx.storage.put('kept',1);await this.ctx.storage.setAlarm(at);return 'armed';}
 async write(k){await this.ctx.storage.put(k,1);return 'written';}
 async keys(){return [...(await this.ctx.storage.list()).keys()];}
 async alarm(){await this.ctx.storage.put('alarm_ran',true);}
 async fetch(){return new Response('legacy');}
}
export default {fetch(){return new Response('legacy');}};`
const settings={SMITHERS_EXPORT_TOKEN:token,SMITHERS_EXPORT_RECIPIENT:JSON.stringify(publicJwk),SMITHERS_EXPORT_EXPIRES_AT:new Date(Date.now()+3600000).toISOString(),SMITHERS_EXPORT_SOURCE_REVISION:'sha256:'+identity.sourceArtifactSHA256,SMITHERS_EXPORT_SOURCE_VERSION:identity.sourceVersion}
const options=fenced=>convertV4MiniflareOptions({modulesRoot:'/',compatibilityDate:'2026-08-01',durableObjects:{TURN_CANCELS:{className:'TurnCancelRegistry',useSQLite:true}},durableObjectsPersist:state,bindings:settings,
 modules:fenced?[{type:'ESModule',path:'cutover-fence-entry.js',contents:entry},{type:'ESModule',path:'cutover-fence-helper.js',contents:helper}]:[{type:'ESModule',path:'index.js',contents:legacy}]})
const runtime=new Miniflare(options(false)),t0=Date.now()
const note=m=>console.error(`${((Date.now()-t0)/1000).toFixed(1)}s ${m}`)
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const bytes=v=>Uint8Array.from(Buffer.from(v,'base64'))
const key=await crypto.subtle.importKey('jwk',privateJwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['unwrapKey'])
let objectId
const stub=async()=>{const ns=await runtime.getDurableObjectNamespace('TURN_CANCELS');return ns.get(ns.idFromString(objectId))}
const capture=async()=>{
 const r=await (await runtime.getWorker()).fetch('https://x/__maintenance/state-export',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({migrationId:identity.executionID,binding:'TURN_CANCELS',objectId})})
 assert.equal(r.status,200);const text=await r.text(),sealed=JSON.parse(text)
 const aes=await crypto.subtle.unwrapKey('raw',bytes(sealed.wrappedKey),key,{name:'RSA-OAEP'},{name:'AES-GCM',length:256},false,['decrypt'])
 const plain=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(sealed.nonce),additionalData:new TextEncoder().encode(JSON.stringify(sealed.metadata))},aes,bytes(sealed.ciphertext))))
 const markers=(plain.cutoverAlarmMarkers??[]).map(m=>JSON.parse(m))
 return {text,keys:plain.entries.map(e=>e[0]),alarm:plain.alarm,marker:markers.find(m=>m.executionID===identity.executionID)??null,markers:markers.length}
}
try{
 const ns=await runtime.getDurableObjectNamespace('TURN_CANCELS');objectId=ns.idFromName('turn-1').toString()
 const scheduled=Date.now()+2000
 assert.equal(await ns.get(ns.idFromString(objectId)).arm(scheduled),'armed');note('legacy armed alarm')
 await runtime.setOptions(options(true));note('final fence installed')

 // 1. First fenced delivery: marker flushed before the throw; legacy callback never ran.
 let seen;for(let i=0;i<20&&!(seen=await capture()).marker;i++)await sleep(1000)
 assert.ok(seen.marker,'marker after first fenced delivery');assert.deepEqual(seen.keys,['kept']);assert.equal(seen.alarm,scheduled,'alarm retained, not acknowledged')
 assert.ok(Date.parse(seen.marker.scheduledNoLaterThan)>=scheduled-1000,'upper bound is the first observed delivery');note(`marker observations=${seen.marker.observations}`)

 // 2. Restart while retries are pending: the marker keeps counting deliveries.
 await sleep(3000);const beforeRestart=(await capture()).marker.observations
 await runtime.setOptions(options(true));note('runtime restarted with retries pending')

 // 3. Wait for the runtime to exhaust retries and drop the alarm itself.
 let last;const deadline=Date.now()+260000
 for(;;){last=await capture();if(last.alarm===null)break;if(Date.now()>deadline)throw new Error('timed out: runtime never dropped the alarm');await sleep(5000)}
 note(`runtime dropped alarm; marker observations=${last.marker.observations} lastRetryCount=${last.marker.lastRetryCount}`)
 assert.ok(last.marker.observations>beforeRestart,'deliveries after restart were recorded')
 assert.deepEqual(last.keys,['kept'],'no product key written, legacy alarm never ran')

 // 4. Exact restore: legacy code sees only its own keys, never the reserved marker.
 await runtime.setOptions(options(false))
 assert.deepEqual(await (await stub()).keys(),['kept'],'marker invisible to product key-value listing')
 assert.equal(await (await stub()).write('after_restore'),'written');note('restored legacy wrote normally')

 // 5. Re-fence: the marker outlived exhaustion and restore, unchanged.
 await runtime.setOptions(options(true))
 const final=await capture()
 assert.deepEqual(final.keys,['after_restore','kept']);assert.equal(final.alarm,null)
 assert.deepEqual(final.marker,last.marker,'marker preserved byte-for-byte across restore')
 note('re-fenced export still carries the marker')
 process.stdout.write(JSON.stringify({sealed:final.text,objectId,scheduled,marker:final.marker}))
}finally{await runtime.dispose();rmSync(state,{recursive:true,force:true})}
