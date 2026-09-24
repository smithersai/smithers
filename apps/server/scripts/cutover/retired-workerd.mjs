// Real workerd: a legacy object arms an alarm, then the post-cutover retired
// class is deployed over it and the alarm fires into it. A probe version then
// reads what survived: product keys and the reserved maintenance table.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require=createRequire(import.meta.url), wrangler=createRequire(require.resolve('wrangler/package.json'))
const {Miniflare,convertV4MiniflareOptions}=await import(wrangler.resolve('miniflare'))
let input='';for await(const b of process.stdin)input+=b
const {retired}=JSON.parse(input)
const state=mkdtempSync(join(tmpdir(),'smithers-retired-'))
const legacy=`import { DurableObject } from 'cloudflare:workers';
export class TurnCancelRegistry extends DurableObject {
 async arm(at){await this.ctx.storage.put('kept',1);await this.ctx.storage.setAlarm(at);return 'armed';}
 async keys(){return [...(await this.ctx.storage.list()).keys()];}
 async markers(){const t=this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='_smithers_cutover_alarm_v1'").toArray();return t.length?this.ctx.storage.sql.exec('SELECT execution_id, marker FROM _smithers_cutover_alarm_v1').toArray():[];}
 async alarm(){}
}
export default {fetch(){return new Response('legacy');}};`
const options=code=>convertV4MiniflareOptions({modulesRoot:'/',compatibilityDate:'2026-08-01',modules:[{type:'ESModule',path:'index.js',contents:code}],durableObjects:{TURN_CANCELS:{className:'TurnCancelRegistry',useSQLite:true}},durableObjectsPersist:state})
const runtime=new Miniflare(options(legacy))
const stub=async id=>{const ns=await runtime.getDurableObjectNamespace('TURN_CANCELS');return ns.get(ns.idFromString(id))}
try{
 const ns=await runtime.getDurableObjectNamespace('TURN_CANCELS'),objectId=ns.idFromName('turn-1').toString()
 const at=Date.now()+2500;assert.equal(await (await stub(objectId)).arm(at),'armed')
 await runtime.setOptions(options(retired))
 if(Date.now()>=at)throw new Error('harness too slow: retired class landed after the alarm time')
 while(Date.now()<at+2500)await new Promise(r=>setTimeout(r,250))
 await runtime.setOptions(options(legacy))
 const s=await stub(objectId)
 process.stdout.write(JSON.stringify({objectId,keys:await s.keys(),markers:(await s.markers()).map(r=>({key:r.execution_id,marker:JSON.parse(r.marker)}))}))
}finally{await runtime.dispose();rmSync(state,{recursive:true,force:true})}
