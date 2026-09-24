import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"
import { admissionWorker, admissionDrainRoute, ALARM_MARKER_TABLE, fencedDurable, fencedWorker, recordInterruptedAlarm, type FenceIdentity } from "../../src/MaintenanceFence"
import { fenceModule } from "./fence-module"
import { validateCloudflareFence, type CloudflareFenceReceipt } from "./fence"
const identity: FenceIdentity = { executionID: randomUUID(), smithersRevision: "a".repeat(40), plueRevision: "b".repeat(40), endpoint: "https://api.jjhub.tech", worker: "smithers-mvp-web", sourceVersion: randomUUID(), sourceArtifactSHA256: "c".repeat(64) }
test("final fence refuses all routes, schedules, queue ack and native alarms", async () => {
 const worker=fencedWorker(identity)
 for(const method of ["GET","POST","DELETE","PATCH"]){const r=await worker.fetch(new Request("https://canary.smithers.sh/api/user",{method}),{} as never);expect(r.status).toBe(503);expect(r.headers.get("cache-control")).toBe("no-store")}
 expect(()=>worker.scheduled()).toThrow("cutover_maintenance")
 let retry=0;expect(()=>worker.queue({retryAll(){retry++}})).toThrow("cutover_maintenance");expect(retry).toBe(1)
 const D=fencedDurable(identity,"TURN_CANCELS"),object=new D({} as never,{} as never)
 await expect(object.alarm!()).rejects.toThrow("cutover_maintenance")
 expect("mutate" in object).toBe(false)
 let closed=0;await(object as unknown as {webSocketMessage(s:{close(c:number,r:string):void}):Promise<void>}).webSocketMessage({close(code,reason){expect(code).toBe(1012);expect(reason).toBe("cutover_maintenance");closed++}});expect(closed).toBe(1)
})
test("module has no legacy import, constructor or re-export and rejects unreviewed classes",()=>{
 const source=fenceModule(identity,[{binding:"TURN_CANCELS",className:"TurnCancelRegistry"}])
 expect(source).not.toContain('"./index.js"');expect(source).not.toContain("export *")
 expect(()=>fenceModule(identity,[{binding:"UNKNOWN",className:"Unknown"}])).toThrow()
 expect(()=>fenceModule({...identity,endpoint:"https://foreign.example"},[])).toThrow()
})
test("a missing durable drain cannot pass by presenting a boolean",()=>{
 const receipt={...identity,schema:"smithers-cloudflare-fence/v1",startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),authorities:[],confirmation:[],queues:[],drain:{state:"verified",globallyQuiescent:true}} as unknown as CloudflareFenceReceipt
 expect(()=>validateCloudflareFence(receipt,identity)).toThrow("CF_FENCE_AUTHORITY_INCOMPLETE")
})
test("real workerd removes legacy RPC authority while retaining storage and restore path",async()=>{
 const built=await Bun.build({entrypoints:[new URL("../../src/MaintenanceFence.ts",import.meta.url).pathname],target:"browser",format:"esm",minify:true})
 expect(built.success).toBe(true)
 const child=Bun.spawn(["node",new URL("./fence-workerd.mjs",import.meta.url).pathname],{stdin:new Blob([JSON.stringify({identity,helper:await built.outputs[0]!.text(),entry:fenceModule(identity,[{binding:"TURN_CANCELS",className:"TurnCancelRegistry"}])})]),stdout:"pipe",stderr:"pipe"})
 const[code,out,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
 expect(error).toBe("");expect(code).toBe(0);expect(out).toContain("restored exact legacy RPC")
},60000)

test("admission closes producers while preserving exact settlement and original queue consumer", async()=>{
 let forwarded=0,consumed=0
 const legacy={fetch(){forwarded++;return new Response("settlement")},queue(){consumed++}}
 const billing=admissionWorker({...identity,worker:"smithers-cloud-billing"},legacy)
 for(const path of ["authorize","topup","admin/grants"]){expect((await billing.fetch(new Request("https://billing.smithers.sh/api/billing/"+path,{method:"POST"}),{} as never,{})).status).toBe(503)}
 expect((await billing.fetch(new Request("https://billing.smithers.sh/api/billing/charges",{method:"POST"}),{} as never,{})).status).toBe(200)
 expect(forwarded).toBe(1)
 admissionWorker({...identity,worker:"smithers-cloud-chat-canary"},legacy).queue({},{} as never,{})
 expect(consumed).toBe(1)
 expect(admissionDrainRoute("smithers-cloud-identity",new Request("https://identity.smithers.sh/auth/github",{method:"POST"}))).toBe(false)
 expect(admissionDrainRoute("smithers-cloud-identity",new Request("https://identity.smithers.sh/api/identity/cloud-token",{method:"POST"}))).toBe(true)
})

test("interrupted alarm marker: one row per execution, counts every delivery, never overwrites an earlier execution", async () => {
 const db=new Database(":memory:"),sql={exec:(q:string,...b:unknown[])=>{const rows=db.query(q).all(...(b as never[])) as Array<Record<string,unknown>>;return{toArray:()=>rows}}} // eager, like ctx.storage.sql.exec
 let synced=0
 const ctx={id:{toString:()=>"f".repeat(64)},storage:{sql,sync:async()=>{synced++}}}
 const earlier={...identity,executionID:randomUUID()}
 recordInterruptedAlarm(ctx,earlier,"TURN_CANCELS",0,new Date("2026-09-25T10:00:00Z"))
 const D=fencedDurable(identity,"TURN_CANCELS"),object=new D(ctx as never,{} as never)
 await expect(object.alarm!({retryCount:0} as never)).rejects.toThrow("cutover_maintenance")
 await expect(object.alarm!({retryCount:1} as never)).rejects.toThrow("cutover_maintenance")
 expect(synced).toBe(2) // flushed before each throw
 const rows=db.query(`SELECT execution_id, marker FROM ${ALARM_MARKER_TABLE} ORDER BY execution_id`).all() as Array<{execution_id:string;marker:string}>
 expect(rows.map(r=>r.execution_id).sort()).toEqual([earlier.executionID,identity.executionID].sort())
 const mine=JSON.parse(rows.find(r=>r.execution_id===identity.executionID)!.marker)
 expect(mine).toMatchObject({schema:"smithers-cutover-alarm/v1",state:"interrupted-unresolved",worker:identity.worker,binding:"TURN_CANCELS",objectId:"f".repeat(64),observations:2,lastRetryCount:1,sourceVersion:identity.sourceVersion})
 expect(mine.scheduledNoLaterThan).toBe(mine.firstObservedAt)
 expect(JSON.parse(rows.find(r=>r.execution_id===earlier.executionID)!.marker).observations).toBe(1)
})

test("a KV-backed object whose sql getter throws still refuses its alarm, without a marker and without a crash", async () => {
 const ctx={id:{toString:()=>"f".repeat(64)},storage:{get sql():never{throw new Error("SQL is not enabled for this Durable Object class")}}}
 expect(recordInterruptedAlarm(ctx as never,identity,"TURN_CANCELS",0,new Date())).toBeNull()
 const D=fencedDurable(identity,"TURN_CANCELS"),object=new D(ctx as never,{} as never)
 await expect(object.alarm!()).rejects.toThrow("cutover_maintenance")
})
