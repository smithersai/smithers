import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { api, listObjects, type Settings } from "./cloudflare"
import { requireExportVersion } from "./deployment"
import { exportBatch } from "./batch"
import { decodeStored, openSnapshot, type SnapshotPayload } from "./sealed"
import { authorityOrigins } from "./fence-routes"
import { CLOUDFLARE_PRODUCERS, privateArtifact } from "./fence"
import { collectPagedSnapshot, validatePagedArchive } from "./paged"
import { EXPORT_PATH } from "../../src/MaintenanceExport"
import type { SealedSnapshot, SnapshotFence } from "../../src/SealedSnapshot"
import type { FenceExpected, ArtifactReference } from "./fence"
const record=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:undefined
export interface DurableDrainCounts { objects:number; rows:number; alarms:number; liveTurns:number; expiredRegistrations:number; openJournals:number; pendingSetup:number; queuedSetup:number; invalidRows:number; unsupportedWorkObjects:number }
export const emptyCounts=():DurableDrainCounts=>({objects:0,rows:0,alarms:0,liveTurns:0,expiredRegistrations:0,openJournals:0,pendingSetup:0,queuedSetup:0,invalidRows:0,unsupportedWorkObjects:0})
/** Work the final fence stopped. Preserved in storage; never labeled completed. */
export type DispositionReason="active-at-fence"|"expired-registration"|"open-journal"|"setup-pending"|"setup-queued"|"alarm-pending"|"alarm-interrupted"|"unclassified-retained"
/** Provenance of an alarm the fence refused; the platform may since have dropped the alarm itself. */
export interface AlarmMarkerSummary { executionID:string; sourceVersion:string; scheduledNoLaterThan:string; firstObservedAt:string; lastObservedAt:string; observations:number; lastRetryCount:number }
export interface Disposition { binding:string; objectId:string; key:string|null; reason:DispositionReason; disposition:"interrupted-unknown"; marker?:AlarmMarkerSummary }
/** One authoritative `chg:<id>` row from the billing AccountDurableObject. */
export interface ChargeRow { objectId:string; id:string; createdAt:string; amountNanos:number; resource:string; runId:string|null }
export interface StripeGrant { objectId:string; id:string; createdAt:string }
export interface ObjectClassification { counts:DurableDrainCounts; dispositions:Disposition[]; charges:ChargeRow[]; stripeGrants:StripeGrant[] }
// These classes can own background work that is not represented by the web
// turn/setup/billing schema. Rows are retained and quarantined, never guessed.
const UNCLASSIFIED=['PUSH_SUBSCRIPTIONS','GUARDIAN_STORE','PAIR_DO','REPO_DO','WORKSPACE_DO','HOOKS','BRANCH_SYNC']
const iso=(v:unknown)=>typeof v==="string"&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v
/** Follows the persisted legacy lifecycle (turns.ts: 10 min active expiry), never labels old work successful. */
export const classifyDurableObject=(binding:string,objectId:string,entries:Array<[string,unknown]>,alarm:number|null,observedAt:number,markers:readonly string[]=[],worker?:string):ObjectClassification=>{
 const c:DurableDrainCounts={...emptyCounts(),objects:1,rows:entries.length,alarms:alarm===null?0:1}
 const dispositions:Disposition[]=[],charges:ChargeRow[]=[],stripeGrants:StripeGrant[]=[]
 const stop=(key:string|null,reason:DispositionReason)=>dispositions.push({binding,objectId,key,reason,disposition:"interrupted-unknown"})
 if(alarm!==null)stop(null,"alarm-pending")
 for(const raw of markers){
  let m:Record<string,unknown>|undefined
  try{m=record(JSON.parse(raw))}catch{m=undefined}
  const n=(v:unknown,min:number)=>Number.isSafeInteger(v)&&(v as number)>=min
  // A retired (post-cutover) owner records alarms it refused under the fixed key "retired".
  if(m?.schema==="smithers-retired-alarm/v1"){
   if(m.state!=="interrupted-unresolved"||m.binding!==binding||m.objectId!==objectId||(worker!==undefined&&m.worker!==worker)||!iso(m.firstObservedAt)||!iso(m.lastObservedAt)||
    m.scheduledNoLaterThan!==m.firstObservedAt||Date.parse(m.firstObservedAt as string)>Date.parse(m.lastObservedAt as string)||!n(m.observations,1)||!n(m.lastRetryCount,0)){c.invalidRows++;continue}
   dispositions.push({binding,objectId,key:"alarm-marker#retired",reason:"alarm-interrupted",disposition:"interrupted-unknown",
    marker:{executionID:"retired",sourceVersion:"retired",scheduledNoLaterThan:m.firstObservedAt as string,firstObservedAt:m.firstObservedAt as string,lastObservedAt:m.lastObservedAt as string,observations:m.observations as number,lastRetryCount:m.lastRetryCount as number}})
   continue
  }
  if(!m||m.schema!=="smithers-cutover-alarm/v1"||m.state!=="interrupted-unresolved"||m.binding!==binding||m.objectId!==objectId||(worker!==undefined&&m.worker!==worker)||
   typeof m.executionID!=="string"||!/^[0-9a-f-]{36}$/.test(m.executionID)||typeof m.sourceVersion!=="string"||typeof m.sourceArtifactSHA256!=="string"||
   !iso(m.firstObservedAt)||!iso(m.lastObservedAt)||m.scheduledNoLaterThan!==m.firstObservedAt||Date.parse(m.firstObservedAt as string)>Date.parse(m.lastObservedAt as string)||
   !n(m.observations,1)||!n(m.lastRetryCount,0)){c.invalidRows++;continue}
  dispositions.push({binding,objectId,key:`alarm-marker#${m.executionID}`,reason:"alarm-interrupted",disposition:"interrupted-unknown",
   marker:{executionID:m.executionID,sourceVersion:m.sourceVersion,scheduledNoLaterThan:m.firstObservedAt as string,firstObservedAt:m.firstObservedAt as string,lastObservedAt:m.lastObservedAt as string,observations:m.observations as number,lastRetryCount:m.lastRetryCount as number}})
 }
 for(const[key,encoded]of entries){const v=record(decodeStored(encoded))
  if(binding==="TURN_CANCELS"&&key==="state"){
   if(!v||!['active','settled','cancelled'].includes(String(v.state))||typeof v.at!=="number"||!Number.isFinite(v.at)){c.invalidRows++;continue}
   if(v.state==='active'){if(observedAt-v.at>600_000){c.expiredRegistrations++;stop(key,"expired-registration")}else{c.liveTurns++;stop(key,"active-at-fence")}}
  }else if(binding==="TURN_CANCELS"&&key==="turn-journal:v1:head"){
   if(v?.retired===true||v?.terminal===true)continue
   if(v?.terminal===false){c.openJournals++;stop(key,"open-journal")}else c.invalidRows++
  }else if(binding==="GATEWAY_SESSIONS"&&key.startsWith("repository-setup:request:")){
   const result=record(v?.result),receipt=record(result?.receipt),input=record(v?.input)
   if(!input||!record(v?.receipt)){c.invalidRows++;continue}
   if(!result||!receipt||!['completed','failed','stopped'].includes(String(receipt.phase))){c.pendingSetup++;stop(key,"setup-pending");continue}
   if(result.requestId!==input.requestId||result.revision!==input.revision||result.digest!==input.digest||receipt.requestId!==input.requestId||receipt.revision!==input.revision||receipt.digest!==input.digest)c.invalidRows++
  }else if(binding==="GATEWAY_SESSIONS"&&key==="repository-setup:pending"){
   const requests=record(v?.requests);if(!requests){c.invalidRows++;continue}
   for(const id of Object.keys(requests).sort()){c.queuedSetup++;stop(`${key}#${id}`,"setup-queued")}
  }else if(binding==="ACCOUNTS"&&key.startsWith("chg:")){
   if(!v||v.id!==key.slice(4)||!iso(v.createdAt)||!Number.isSafeInteger(v.amountNanos)||(v.amountNanos as number)<0||typeof v.resource!=="string"||(v.runId!==null&&typeof v.runId!=="string")){c.invalidRows++;continue}
   charges.push({objectId,id:v.id as string,createdAt:v.createdAt as string,amountNanos:v.amountNanos as number,resource:v.resource,runId:v.runId as string|null})
  }else if(binding==="ACCOUNTS"&&key==="ledger"){
   if(!v||!Array.isArray(v.grants)){c.invalidRows++;continue}
   for(const grant of v.grants.map(record)){
    if(!grant||typeof grant.id!=="string"||!iso(grant.createdAt)){c.invalidRows++;continue}
    if(grant.id.startsWith("stripe:"))stripeGrants.push({objectId,id:grant.id,createdAt:grant.createdAt as string})
   }
  }
 }
 if(entries.length&&UNCLASSIFIED.includes(binding)){c.unsupportedWorkObjects++;stop(null,"unclassified-retained")}
 return {counts:c,dispositions,charges,stripeGrants}
}
/** Count-only view kept for the historical archive tooling. */
export const classifyDurableDrain=(binding:string,entries:Array<[string,unknown]>,alarm:number|null,observedAt:number):DurableDrainCounts=>classifyDurableObject(binding,"0".repeat(64),entries,alarm,observedAt).counts
/** One canonical row order, so a validator can recompute and compare byte-for-byte. */
export const orderRows=(rows:{dispositions:Disposition[];charges:ChargeRow[];stripeGrants:StripeGrant[]})=>{
 const by=<T extends {objectId:string}>(items:T[],key:(r:T)=>string)=>[...items].sort((a,b)=>(a.objectId+'\0'+key(a)).localeCompare(b.objectId+'\0'+key(b)))
 return {dispositions:by(rows.dispositions,d=>d.binding+'\0'+(d.key??'')+'\0'+d.reason),charges:by(rows.charges,c=>c.id),stripeGrants:by(rows.stripeGrants,g=>g.id)}
}
export const addCounts=(into:DurableDrainCounts,from:DurableDrainCounts)=>{for(const key of Object.keys(into)as Array<keyof DurableDrainCounts>)into[key]+=from[key]}

export interface Recipient { migrationId:string; privateJwk:JsonWebKey; token:string; expiresAt:string }
export const readRecipient=(root:string,executionID:string):Recipient=>{
 const path=resolve(root,'recipient.json'),st=lstatSync(path)
 if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw Error('CF_DRAIN_PRIVATE_PATH_REQUIRED')
 const recipient=JSON.parse(readFileSync(path,'utf8')) as Recipient
 if(recipient.migrationId!==executionID||!recipient.privateJwk?.d||typeof recipient.token!=="string"||recipient.token.length<43||!Number.isFinite(Date.parse(recipient.expiresAt)))throw Error('CF_DRAIN_RECIPIENT_INVALID')
 return recipient
}
export interface DrainSnapshot extends ArtifactReference { binding:string; objectId:string; capturedAt:string; format?:"paged" }
export interface DurableDrainObservation extends FenceExpected {
 schema:"smithers-durable-drain/v3";worker:string;version:string;sourceVersion:string;sourceArtifactSHA256:string;startedAt:string;finishedAt:string
 credentialExpiresAt:string;complete:true;counts:DurableDrainCounts;dispositions:Disposition[];charges:ChargeRow[];stripeGrants:StripeGrant[]
 snapshots:DrainSnapshot[];emptyAtListing:number;namespaces:Array<{binding:string;namespaceId:string;listed:number}>
}
export interface SnapshotProvenance { executionID:string; binding:string; objectId:string; sourceVersion:string; sourceArtifactSHA256:string; notBefore:number; credentialExpiresAt:string }
/** Opens one sealed snapshot and refuses any provenance drift, including a capture outside the credential epoch. */
export const openDrainSnapshot=async(bytes:string,expect:SnapshotProvenance,privateJwk:JsonWebKey):Promise<{payload:SnapshotPayload;capturedAt:string}>=>{
 const sealed=JSON.parse(bytes) as SealedSnapshot,m=sealed.metadata,at=Date.parse(m.capturedAt)
 if(m.migrationId!==expect.executionID||m.binding!==expect.binding||m.objectId!==expect.objectId||m.sourceVersion!==expect.sourceVersion||m.sourceRevision!=='sha256:'+expect.sourceArtifactSHA256||!Number.isFinite(at)||at<expect.notBefore||at>=Date.parse(expect.credentialExpiresAt))throw Error('CF_DRAIN_SNAPSHOT_PROVENANCE')
 return {payload:await openSnapshot(sealed,privateJwk),capturedAt:m.capturedAt}
}
/** Every page is classified, but object-level facts are counted only once. */
export const classifyDurablePage=(binding:string,objectId:string,payload:SnapshotPayload,capturedAt:string,first:boolean,worker?:string):ObjectClassification=>{
 const result=classifyDurableObject(binding,objectId,payload.entries,first?payload.alarm:null,Date.parse(capturedAt),first?payload.cutoverAlarmMarkers??[]:[],worker)
 if(!first){result.counts.objects=0;result.counts.unsupportedWorkObjects=0;result.dispositions=result.dispositions.filter(d=>d.reason!=="unclassified-retained")}
 return result
}
/** Reopen retained v1 or the complete authenticated v2 chain; no page is an object by itself. */
export const visitDrainSnapshot=async(root:string,ref:DrainSnapshot,expect:SnapshotProvenance,fence:SnapshotFence,privateJwk:JsonWebKey,onPage:(payload:SnapshotPayload,capturedAt:string,first:boolean)=>void|Promise<void>):Promise<void>=>{
 const text=privateArtifact(root,ref).toString()
 if(ref.format!=="paged"){
  const opened=await openDrainSnapshot(text,expect,privateJwk)
  if(opened.capturedAt!==ref.capturedAt)throw Error("CF_DRAIN_SNAPSHOT_PROVENANCE")
  await onPage(opened.payload,opened.capturedAt,true);return
 }
 const path=resolve(root,ref.path)
 const archive=await validatePagedArchive(dirname(path),basename(path),{migrationId:expect.executionID,binding:expect.binding,objectId:expect.objectId,sourceRevision:"sha256:"+expect.sourceArtifactSHA256,sourceVersion:expect.sourceVersion,fence},privateJwk,async(payload,metadata)=>{
  const at=Date.parse(metadata.capturedAt)
  if(at<expect.notBefore||at>=Date.parse(expect.credentialExpiresAt))throw Error("CF_DRAIN_SNAPSHOT_PROVENANCE")
  await onPage(payload,metadata.capturedAt,metadata.page.index===0)
 })
 if(archive.capturedAt!==ref.capturedAt)throw Error("CF_DRAIN_SNAPSHOT_PROVENANCE")
}
/** Reads every stored object of one fenced authority through its sealed export door. GET/export only. */
export const collectDurableDrain=async(input:FenceExpected&{worker:string;version:string;sourceVersion:string;sourceArtifactSHA256:string;origin:string;privateDirectory:string;fencedAt:string}):Promise<DurableDrainObservation>=>{
 if(!(CLOUDFLARE_PRODUCERS as readonly string[]).includes(input.worker)||input.endpoint!=="https://api.jjhub.tech"||!(await authorityOrigins(input.worker)).includes(input.origin))throw Error("CF_DRAIN_AUTHORITY_INVALID")
 const root=resolve(input.privateDirectory),st=lstatSync(root)
 if(st.isSymbolicLink()||(st.mode&0o077)!==0)throw Error('CF_DRAIN_PRIVATE_PATH_REQUIRED')
 const recipient=readRecipient(root,input.executionID)
 if(Date.parse(recipient.expiresAt)<=Date.now())throw Error('CF_DRAIN_RECIPIENT_INVALID')
 const base='/workers/scripts/'+input.worker
 const guard=async()=>{const d=(await api<{deployments:Array<{versions:Array<{version_id:string;percentage:number}>}>}>(base+'/deployments')).result.deployments[0];requireExportVersion(d,input.version)}
 await guard()
 const settings=(await api<Settings>(base+'/settings')).result
 const namespaces=settings.bindings.filter(b=>b.type==='durable_object_namespace')
 if(namespaces.some(b=>!/^[a-f0-9]{32}$/.test(b.namespace_id??'')||b.script_name&&b.script_name!==input.worker))throw Error('CF_DRAIN_NAMESPACE_OWNER_UNKNOWN')
 const directory='drain-'+input.worker+'-'+randomUUID();mkdirSync(resolve(root,directory),{mode:0o700})
 const startedAt=new Date().toISOString(),snapshots:DrainSnapshot[]=[],counts=emptyCounts()
 const dispositions:Disposition[]=[],charges:ChargeRow[]=[],stripeGrants:StripeGrant[]=[],listed:DurableDrainObservation['namespaces']=[]
 let emptyAtListing=0
 for(const binding of namespaces){
  const before=await listObjects(binding.namespace_id!);emptyAtListing+=before.filter(o=>!o.hasStoredData).length
  listed.push({binding:binding.name,namespaceId:binding.namespace_id!,listed:before.length})
  await exportBatch(before.filter(o=>o.hasStoredData),async object=>{
   await guard()
   const fence:SnapshotFence={executionID:input.executionID,worker:input.worker,sourceVersion:input.sourceVersion,sourceArtifactSHA256:input.sourceArtifactSHA256,smithersRevision:input.smithersRevision,plueRevision:input.plueRevision,endpoint:input.endpoint}
   const collected=await collectPagedSnapshot({directory:resolve(root,directory),stem:binding.name+'-'+object.id,expected:{migrationId:input.executionID,binding:binding.name,objectId:object.id,sourceRevision:'sha256:'+input.sourceArtifactSHA256,sourceVersion:input.sourceVersion,fence},privateJwk:recipient.privateJwk,
    fetchPage:async cursor=>{await guard();return fetch(input.origin+EXPORT_PATH,{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{authorization:'Bearer '+recipient.token,'content-type':'application/json'},body:JSON.stringify({migrationId:input.executionID,binding:binding.name,objectId:object.id,page:{cursor}})})},
    onPage:(payload,metadata)=>{
     const at=Date.parse(metadata.capturedAt)
     if(at<Math.max(Date.parse(startedAt),Date.parse(input.fencedAt))||at>=Date.parse(recipient.expiresAt))throw Error('CF_DRAIN_SNAPSHOT_PROVENANCE')
     const observed=classifyDurablePage(binding.name,object.id,payload,metadata.capturedAt,metadata.page.index===0,input.worker)
     addCounts(counts,observed.counts);dispositions.push(...observed.dispositions);charges.push(...observed.charges);stripeGrants.push(...observed.stripeGrants)
    }})
   snapshots.push({path:directory+'/'+collected.file,sha256:collected.sha256,binding:binding.name,objectId:object.id,capturedAt:collected.archive.capturedAt,format:'paged'})
  })
  const after=await listObjects(binding.namespace_id!)
  if(JSON.stringify(before.sort((a,b)=>a.id.localeCompare(b.id)))!==JSON.stringify(after.sort((a,b)=>a.id.localeCompare(b.id))))throw Error('CF_DRAIN_OBJECT_INVENTORY_CHANGED')
 }
 await guard()
 const observation:DurableDrainObservation={schema:'smithers-durable-drain/v3',executionID:input.executionID,smithersRevision:input.smithersRevision,plueRevision:input.plueRevision,endpoint:input.endpoint,worker:input.worker,version:input.version,sourceVersion:input.sourceVersion,sourceArtifactSHA256:input.sourceArtifactSHA256,startedAt,finishedAt:new Date().toISOString(),
  credentialExpiresAt:recipient.expiresAt,complete:true,counts,...orderRows({dispositions,charges,stripeGrants}),snapshots:snapshots.sort((a,b)=>a.path.localeCompare(b.path)),emptyAtListing,namespaces:listed}
 writeFileSync(resolve(root,directory+'/receipt.json'),JSON.stringify(observation),{mode:0o600,flag:'wx'})
 return observation
}
