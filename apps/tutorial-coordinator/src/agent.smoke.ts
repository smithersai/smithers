import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Stream } from 'effect'
import * as Seat from '@smthrs/agent/Seat'
import * as SeatResolver from '@smthrs/agent/SeatResolver'
import * as Model from '@smthrs/model/Model'
import * as ModelEvent from '@smthrs/model/ModelEvent'
import { TutorialAgent,agentLayer } from './agent'
import * as Evaluator from '@smthrs/model/Evaluator'
const directory=await mkdtemp(join(tmpdir(),'tutorial-agent-'))
const answer={title:'Observed issue',summary:'Tests show the bug',steps:['Default null and empty names'],files:[],message:''}
let calls=0
const model=Model.make({stream:()=>{calls++;return Stream.fromIterable([
ModelEvent.ModelEvent.TextStart({type:'text-start',id:'answer'}),
ModelEvent.ModelEvent.TextDelta({type:'text-delta',id:'answer',text:'```cell\nctx.done('+JSON.stringify(calls===1?{title:'Incomplete answer'}:answer)+')\n```'}),
ModelEvent.ModelEvent.TextEnd({type:'text-end',id:'answer'}),
ModelEvent.ModelEvent.Usage({inputTokens:6000,outputTokens:867,totalTokens:6867}),
ModelEvent.ModelEvent.Settle({type:'settle',stopReason:'stop'})])}})
const seats=SeatResolver.layer({resolve:id=>Effect.succeed(Seat.make({id,modelId:'test',model,contextWindowTokens:32000,route:{prepare:()=>Effect.succeed({routeId:'test',protocolId:'test',method:'POST',url:'https://example.invalid',publicHeaders:{},body:new Uint8Array(),bodyText:''})}}))})
try {
 const execute=()=>Effect.runPromise(TutorialAgent.execute({instructions:'Research',context:'Observed test failure'},{executionId:'durable-smoke'}).pipe(Effect.provide(agentLayer(join(directory,'flows.sqlite'),{provider:'openai',apiKey:'unused',modelId:'test'},seats,undefined,ScriptedJudge.layer))))
 assert.deepEqual(await execute(),answer)
 assert.deepEqual(await execute(),answer)
 assert.equal(calls,2)
 console.log('Actual durable AgentAction + QuickJS corrected incomplete output within token budget; replay made no additional model calls')
} finally {await rm(directory,{recursive:true,force:true})}
