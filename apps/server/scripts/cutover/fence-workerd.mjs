import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require=createRequire(import.meta.url), wrangler=createRequire(require.resolve('wrangler/package.json'))
const {Miniflare,convertV4MiniflareOptions}=await import(wrangler.resolve('miniflare'))
let input='';for await(const b of process.stdin)input+=b
const {helper,entry,identity}=JSON.parse(input)
const keys=generateKeyPairSync('rsa',{modulusLength:2048}),token='test-fence-export-token'.repeat(3),migrationId=randomUUID()
const state=mkdtempSync(join(tmpdir(),'smithers-fence-'))
const legacy=`import { DurableObject } from 'cloudflare:workers';
export class TurnCancelRegistry extends DurableObject {
 async mutate(){await this.ctx.storage.put('preserved',{fixture:'unchanged'}); return 'mutated';}
 async fetch(){await this.ctx.storage.put('unsafe_write',true);return new Response('legacy');}
 async alarm(){await this.ctx.storage.put('unsafe_alarm',true);}
}
export default {fetch(){return new Response('legacy');}};`
const settings={SMITHERS_EXPORT_TOKEN:token,SMITHERS_EXPORT_RECIPIENT:JSON.stringify(keys.publicKey.export({format:'jwk'})),SMITHERS_EXPORT_EXPIRES_AT:new Date(Date.now()+60000).toISOString(),SMITHERS_EXPORT_SOURCE_REVISION:'sha256:'+identity.sourceArtifactSHA256,SMITHERS_EXPORT_SOURCE_VERSION:identity.sourceVersion}
const options=fenced=>convertV4MiniflareOptions({modulesRoot:'/',modules:[{type:'ESModule',path:fenced?'cutover-fence-entry.js':'index.js',contents:fenced?entry:legacy},...(fenced?[{type:'ESModule',path:'cutover-fence-helper.js',contents:helper},{type:'ESModule',path:'index.js',contents:legacy}]:[])],compatibilityDate:'2026-08-01',durableObjects:{TURN_CANCELS:{className:'TurnCancelRegistry',useSQLite:true}},durableObjectsPersist:state,bindings:settings})
const runtime=new Miniflare(options(false))
try{
 let ns=await runtime.getDurableObjectNamespace('TURN_CANCELS'),id=ns.idFromName('fence-fixture'),objectId=id.toString(),stub=ns.get(id)
 assert.equal(await stub.mutate(),'mutated'); console.log('legacy RPC verified')
 await runtime.setOptions(options(true));ns=await runtime.getDurableObjectNamespace('TURN_CANCELS');stub=ns.get(ns.idFromString(objectId))
 assert.equal((await runtime.dispatchFetch('https://canary.smithers.sh/api/chat',{method:'POST',body:'{}'})).status,503)
 assert.equal((await stub.fetch('https://internal/mutate',{method:'POST'})).status,503)
 await assert.rejects(async()=>await stub.mutate())
 const request={method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({migrationId,binding:'TURN_CANCELS',objectId})}
 const exported=await runtime.dispatchFetch('https://canary.smithers.sh/__maintenance/state-export',request)
 assert.equal(exported.status,200)
 const sealed=await exported.json(),bytes=v=>Uint8Array.from(Buffer.from(v,'base64'))
 const privateKey=await crypto.subtle.importKey('jwk',keys.privateKey.export({format:'jwk'}),{name:'RSA-OAEP',hash:'SHA-256'},false,['unwrapKey'])
 const key=await crypto.subtle.unwrapKey('raw',bytes(sealed.wrappedKey),privateKey,{name:'RSA-OAEP'},{name:'AES-GCM',length:256},false,['decrypt'])
 const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(sealed.nonce),additionalData:new TextEncoder().encode(JSON.stringify(sealed.metadata))},key,bytes(sealed.ciphertext))
 const snapshot=JSON.parse(new TextDecoder().decode(plain))
 assert.equal(snapshot.entries.length,1);assert.equal(snapshot.entries[0][0],'preserved')
 settings.SMITHERS_EXPORT_EXPIRES_AT=new Date(0).toISOString();await runtime.setOptions(options(true))
 assert.equal((await runtime.dispatchFetch('https://canary.smithers.sh/__maintenance/state-export',request)).status,404)
 assert.equal((await runtime.dispatchFetch('https://canary.smithers.sh/api/chat',{method:'POST'})).status,503)
 await runtime.setOptions(options(false));ns=await runtime.getDurableObjectNamespace('TURN_CANCELS');stub=ns.get(ns.idFromString(objectId))
 assert.equal(await stub.mutate(),'mutated'); console.log('legacy RPC verified')
 console.log('workerd rejected legacy RPC and external writes, preserved ciphertext storage, stayed fenced after expiry, restored exact legacy RPC')
}finally{await runtime.dispose();rmSync(state,{recursive:true,force:true})}
