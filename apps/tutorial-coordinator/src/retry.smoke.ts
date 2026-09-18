import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Stream } from 'effect'
import * as Seat from '@smthrs/agent/Seat'
import * as SeatResolver from '@smthrs/agent/SeatResolver'
import * as Model from '@smthrs/model/Model'
import { ModelError } from '@smthrs/model/ModelError'
import * as ModelEvent from '@smthrs/model/ModelEvent'
import { TutorialAgent, agentLayer } from './agent'
import * as Evaluator from '@smthrs/model/Evaluator'

const directory=await mkdtemp(join(tmpdir(),'tutorial-retry-'))
const answer={title:'Observed issue',summary:'Actual settled answer',steps:['Fix the default'],files:[],message:''}
const settled=[
 ModelEvent.ModelEvent.TextStart({type:'text-start',id:'answer'}),
 ModelEvent.ModelEvent.TextDelta({type:'text-delta',id:'answer',text:'```cell\nctx.done('+JSON.stringify(answer)+')\n```'}),
 ModelEvent.ModelEvent.TextEnd({type:'text-end',id:'answer'}),
 ModelEvent.ModelEvent.Settle({type:'settle',stopReason:'stop'})
]
const run=(name:string,model:Model.Model)=>{
 const seats=SeatResolver.layer({resolve:id=>Effect.succeed(Seat.make({id,modelId:'test',model,contextWindowTokens:32000,route:{prepare:()=>Effect.succeed({routeId:'test',protocolId:'test',method:'POST',url:'https://example.invalid',publicHeaders:{},body:new Uint8Array(),bodyText:''})}}))})
 return ()=>Effect.runPromise(TutorialAgent.execute({instructions:'Research',context:'Observed test failure'},{executionId:name}).pipe(Effect.provide(agentLayer(join(directory,`${name}.sqlite`),{provider:'openai',apiKey:'unused',modelId:'test'},seats,undefined,Evaluator.layerScripted(()=>({complete:{probability:0.99},overclaims:{probability:0.01}})))),Effect.timeout(10000)))
}
try {
 let attempts=0
 const truncated=run('truncated-stream',Model.make({stream:()=>{
  attempts++
  // This is the exact production failure: bytes arrive, then the stream ends
  // without a settlement. No synthetic ModelError hides the classification.
  return Stream.fromIterable(attempts===1?[
   ModelEvent.ModelEvent.TextStart({type:'text-start',id:'partial'}),
   ModelEvent.ModelEvent.TextDelta({type:'text-delta',id:'partial',text:'```cell\nctx.done({title: "partial"'})
  ]:settled)
 }}))
 assert.deepEqual(await truncated(),answer)
 assert.equal(attempts,2)
 assert.deepEqual(await truncated(),answer)
 assert.equal(attempts,2,'replay must not repeat successful transport attempts')

 let unavailableAttempts=0
 const unavailable=run('provider-503',Model.make({stream:()=>{unavailableAttempts++;return Stream.fail(new ModelError({code:'provider_internal',httpStatus:503,message:'Temporarily unavailable'}))}}))
 await assert.rejects(unavailable())
 assert.equal(unavailableAttempts,3,'one initial attempt plus exactly two bounded retries')

 let creditAttempts=0
 const credit=run('credit-exhausted',Model.make({stream:()=>{creditAttempts++;return Stream.fail(new ModelError({code:'quota_exceeded',httpStatus:429,providerCode:'credit_balance_exhausted',message:'No credits remaining'}))}}))
 await assert.rejects(credit())
 assert.equal(creditAttempts,1,'exhausted credit must neither retry nor park')

 let authenticationAttempts=0
 const auth=run('invalid-credential',Model.make({stream:()=>{authenticationAttempts++;return Stream.fail(new ModelError({code:'authentication',httpStatus:401,message:'Invalid credential'}))}}))
 await assert.rejects(auth())
 assert.equal(authenticationAttempts,1)
 console.log('Transient retry passed: truncated stream recovers and replays once, 503 stops after three attempts, credit/auth failures make one attempt')
} finally {await rm(directory,{recursive:true,force:true})}
