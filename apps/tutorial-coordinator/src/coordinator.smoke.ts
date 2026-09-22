import { strict as assert } from 'node:assert'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Coordinator} from './coordinator'
const directory=await mkdtemp(join(tmpdir(),'tutorial-coordinator-'))
const scopes=new Map<string,{head:string,files:Record<string,string>}>()
let commits=0,applies=0,failTests=false
const coordinator=new Coordinator(directory,{
 ensure:async scope=>{
  let state=scopes.get(scope);if(!state){state={head:'base',files:{'src/hello.ts':'broken'}};scopes.set(scope,state)}
  const current=state
  return {
   snapshot:async()=>({base:'base',head:current.head,files:{...current.files}}),
   files:async()=>({...current.files}),
   apply:async files=>{applies++;Object.assign(current.files,files);return current.files},
   test:async()=>({command:'node --permission --test protected-regression.mjs',code:failTests||current.files['src/hello.ts']==='broken'?1:0,stdout:'protected regression output',stderr:''}),
   commit:async message=>{commits++;const parent=current.head;current.head='actual-commit';return {sha:current.head,parent,subject:message}},
   diff:async()=>({base:'base',head:current.head,patch:'diff --git a/src/hello.ts b/src/hello.ts\n--- a/src/hello.ts\n+++ b/src/hello.ts\n@@ -1 +1 @@\n-broken\n+fixed\n'})
  }
 },
 agent:async (_file,_id,instructions)=>({title:'Fix greeting',summary:'Use world for missing and empty names',steps:['Fix and test'],files:instructions.startsWith('Implement')?[{path:'src/hello.ts',content:'fixed'}]:[],message:'Fix greeting'})
})
async function done(session:string,operation:'research'|'plan'|'implement'|'poc'|'change',key:string,extra={}){
 const run=coordinator.start(session,operation,{playthrough:0,idempotencyKey:key,...extra})
 for(let i=0;i<100;i++){const value=coordinator.get(session,run.runId)!;if(value.phase==='completed'||value.phase==='failed')return value;await new Promise(r=>setTimeout(r,5))}
 throw Error('Run timed out')
}
try {
 assert.throws(()=>coordinator.start('a','plan',{playthrough:0,idempotencyKey:'too-early'}),/Research/)
 const research=await done('a','research','r');assert.equal(research.phase,'completed');assert.equal(research.tests?.exitCode,1);assert.equal(research.events.find(event=>event.id==='reproduce')?.detail,'protected regression output')
 assert.equal(coordinator.journal.history(research.runId).filter(event=>event.fact.kind==='execution.claimed').length,1)
 assert.equal(coordinator.journal.verify(research.runId),true)
 assert.equal(coordinator.get('b',research.runId),undefined)
 const plan=await done('a','plan','p');assert.equal(plan.phase,'completed')
 assert.throws(()=>coordinator.start('a','implement',{playthrough:0,idempotencyKey:'stale',planId:'wrong'}),/latest plan/)
 const implementation=await done('a','implement','i',{planId:plan.plan!.id});assert.equal(implementation.phase,'completed');assert.equal(implementation.commits?.[0]?.commitId,'actual-commit');assert.equal(implementation.commits?.[0]?.parentCommitId,'base')
 assert.equal((await done('a','implement','another-key',{planId:plan.plan!.id})).runId,implementation.runId)
 assert.equal((await done('a','implement','i',{planId:plan.plan!.id})).runId,implementation.runId)
 assert.equal(commits,1);assert.equal(applies,1)
 const change=await done('a','change','c',{commitIds:['actual-commit']});assert.deepEqual(change.change?.commitIds,['actual-commit'])
 const badChange=await done('a','change','bad-c',{commitIds:['invented']});assert.equal(badChange.phase,'failed')
 const poc=await done('a','poc','poc');assert.equal(poc.phase,'completed');assert.equal(commits,1);assert.equal(scopes.size,2)
 failTests=true
 await done('b','research','r');const badPlan=await done('b','plan','p');const failed=await done('b','implement','i',{planId:badPlan.plan!.id});assert.equal(failed.phase,'failed');assert.equal(failed.tests?.exitCode,1);assert.equal(commits,1)
 const gate=new Promise<never>(()=>{});let externalCalls=0
 const heldDirectory=join(directory,'held');await mkdir(heldDirectory)
 const held=new Coordinator(heldDirectory,{ensure:async()=>{externalCalls++;return gate},agent:async()=>{throw new Error('unexpected model call')}})
 const heldRun=held.start('held','research',{playthrough:0,idempotencyKey:'held'})
 for(let attempt=0;attempt<100&&externalCalls===0;attempt++)await new Promise(resolve=>setTimeout(resolve,5))
 assert.equal(externalCalls,1)
 const replacement=new Coordinator(heldDirectory,{ensure:async()=>{externalCalls++;return gate},agent:async()=>{throw new Error('unexpected model call')}})
 assert.equal(replacement.start('held','research',{playthrough:0,idempotencyKey:'held'}).runId,heldRun.runId)
 replacement.resume()
 await new Promise(resolve=>setTimeout(resolve,0))
 assert.equal(externalCalls,1)
 assert.equal(replacement.journal.history(heldRun.runId).filter(event=>event.fact.kind==='execution.claimed').length,1)
 replacement.close();held.close()
 await coordinator.prune(Date.now()+3*60*60*1000)
 assert.equal(coordinator.get('a',research.runId),undefined)
 console.log('Coordinator passed: research gate, session isolation, plan validation, actual artifacts, idempotent commit, selected commits, isolated POC, protected-test failure blocks commit')
} finally {coordinator.close();await rm(directory,{recursive:true,force:true})}
