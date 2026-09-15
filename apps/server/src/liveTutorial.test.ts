import {describe,it,expect} from 'bun:test'
import {Effect} from 'effect'
import {mintTutorialSession,readTutorialSession} from './liveTutorial'
describe('anonymous live tutorial cookie',()=>{
 it('verifies signed session and rejects changed ids, signatures, expired and future cookies',async()=>{
  const now=1800000000000,secret='test-service-token',signed=await Effect.runPromise(mintTutorialSession(secret,now))
  const cookie=`other=value; __Host-smithers-tutorial=${signed}`
  expect(await Effect.runPromise(readTutorialSession(cookie,secret,now))).toBe(signed.split('.')[0])
  expect(await Effect.runPromise(readTutorialSession(cookie,'wrong',now))).toBeUndefined()
  expect(await Effect.runPromise(readTutorialSession(cookie,secret,now+3600001))).toBeUndefined()
  expect(await Effect.runPromise(readTutorialSession(cookie,secret,now-1))).toBeUndefined()
  expect(await Effect.runPromise(readTutorialSession(cookie.replace(signed.split('.')[0]!,'00000000-0000-0000-0000-000000000000'),secret,now))).toBeUndefined()
  expect(await Effect.runPromise(readTutorialSession(`${cookie}0`,secret,now))).toBeUndefined()
  expect(await Effect.runPromise(readTutorialSession(null,secret,now))).toBeUndefined()
 })
})

import {Layer,Redacted} from 'effect'
import {handleLiveTutorial} from './liveTutorial'
import {testConfigLayer} from './Config'
import {transportLayer} from './Http'
import {TurnLimits} from './turnLimit'
it('forwards only a signed scoped session, retains private token, bounds bodies, and refuses exhausted budget',async()=>{
 const calls:Array<{url:string,init:RequestInit|undefined}>=[]
 let allowed=true
 const services=Layer.mergeAll(
  testConfigLayer({tutorialServiceUrl:'https://service.invalid/__tutorial',tutorialServiceToken:Redacted.make('private-token')}),
  Layer.succeed(TurnLimits,{spend:()=>Effect.succeed({allowed,remaining:allowed?19:0,retryAt:Date.now()+10000}),peek:()=>Effect.succeed({allowed:true,remaining:1})}),
  transportLayer(async(input,init)=>{calls.push({url:String(input),init});return Response.json({runId:'run'},{headers:{'set-cookie':'bad-cookie=1'}})})
 )
 const run=(request:Request)=>Effect.runPromise(handleLiveTutorial(request).pipe(Effect.provide(services)))
 const request=()=>new Request('https://smithers.sh/api/tutorial/live/research',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1'},body:JSON.stringify({playthrough:0,idempotencyKey:'request'})})
 const first=await run(request())
 expect(first.status).toBe(200)
 const cookie=first.headers.get('set-cookie')!
 expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict')
 expect(cookie).not.toContain('private-token')
 expect(cookie).not.toContain('bad-cookie')
 expect(calls[0]!.url).toMatch(/^https:\/\/service.invalid\/__tutorial\/sessions\/[0-9a-f-]+\/research$/)
 expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer private-token')
 const unauthorized=await run(new Request('https://smithers.sh/api/tutorial/live/run/run'))
 expect(unauthorized.status).toBe(401)
 const resumed=await run(new Request('https://smithers.sh/api/tutorial/live/run/run',{headers:{cookie:cookie.split(';')[0]!}}))
 expect(resumed.status).toBe(200)
 expect(calls[1]!.url.replace('/run/run','/research')).toBe(calls[0]!.url)
 const expired=await run(new Request('https://smithers.sh/api/tutorial/live/implement',{method:'POST',body:JSON.stringify({playthrough:0,idempotencyKey:'expired',planId:'old-plan'})}))
 expect(expired.status).toBe(401)
 expect(expired.headers.get('set-cookie')).toBeNull()
 expect(await expired.text()).toContain('saved results remain available')
 const huge=await run(new Request('https://smithers.sh/api/tutorial/live/research',{method:'POST',body:'x'.repeat(4097)}))
 expect(huge.status).toBe(413)
 allowed=false
 const capped=await run(request())
 expect(capped.status).toBe(429)
 expect(capped.headers.get('retry-after')).not.toBeNull()
 const refusal=await capped.json() as {message:string}
 expect(refusal.message).toContain('from this network')
 expect(refusal.message).not.toContain('Sign in')
 // Finishing an existing verified result costs no additional model call.
 const change=await run(new Request('https://smithers.sh/api/tutorial/live/change',{method:'POST',headers:{cookie:cookie.split(';')[0]!},body:JSON.stringify({playthrough:0,idempotencyKey:'change',commitIds:['verified-commit']})}))
 expect(change.status).toBe(200)
 expect(calls[2]!.url.replace('/change','/research')).toBe(calls[0]!.url)
 expect(JSON.parse(calls[2]!.init!.body as string).commitIds).toEqual(['verified-commit'])
 const unscopedChange=await run(new Request('https://smithers.sh/api/tutorial/live/change',{method:'POST',body:JSON.stringify({playthrough:0,idempotencyKey:'unscoped'})}))
 expect(unscopedChange.status).toBe(401)
 expect(calls.length).toBe(3)
})

it('allows two free repeats per session action, then spends, and never frees a refused action',async()=>{
 const counts=new Map<string,number>()
 let localMax=20
 const spends:string[]=[]
 const budget=(key:string,max:number,spend:boolean)=>{
  const count=counts.get(key)??0
  if(count>=max)return {allowed:false,remaining:0,retryAt:Date.now()+10000}
  if(spend)counts.set(key,count+1)
  return {allowed:true,remaining:max-count-(spend?1:0)}
 }
 const services=Layer.mergeAll(
  testConfigLayer({tutorialServiceUrl:'https://service.invalid/__tutorial',tutorialServiceToken:Redacted.make('private-token')}),
  Layer.succeed(TurnLimits,{
   spend:(key,ceiling)=>Effect.sync(()=>{const max=key.startsWith('tutorial:anonymous:')?localMax:ceiling!.max;const result=budget(key,max,true);if(result.allowed&&!key.startsWith('tutorial:charged:'))spends.push(key);return result}),
   peek:(key,ceiling)=>Effect.sync(()=>budget(key,ceiling!.max,false))
  }),
  transportLayer(async()=>Response.json({runId:'run'}))
 )
 const run=(request:Request)=>Effect.runPromise(handleLiveTutorial(request).pipe(Effect.provide(services)))
 const post=(operation:string,body:Record<string,unknown>,cookie?:string)=>run(new Request(`https://smithers.sh/api/tutorial/live/${operation}`,{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1',...(cookie?{cookie}:{})},body:JSON.stringify(body)}))
 const local=()=>spends.filter(key=>key.startsWith('tutorial:anonymous:')).length
 const first=await post('research',{playthrough:0,idempotencyKey:'first'})
 expect(first.status).toBe(200)
 const cookie=first.headers.get('set-cookie')!.split(';')[0]!
 expect(local()).toBe(1)
 // Retry mints a new idempotency key; reconnect and reload repeat the old one.
 expect((await post('research',{playthrough:0,idempotencyKey:'retry'},cookie)).status).toBe(200)
 expect((await post('research',{playthrough:0,idempotencyKey:'first'},cookie)).status).toBe(200)
 expect(local()).toBe(1)
 expect(spends.filter(key=>key==='tutorial:all')).toHaveLength(1)
 // The third repeat spends, and so does every one after it.
 expect((await post('research',{playthrough:0,idempotencyKey:'third'},cookie)).status).toBe(200)
 expect(local()).toBe(2)
 expect((await post('research',{playthrough:0,idempotencyKey:'fourth'},cookie)).status).toBe(200)
 expect(local()).toBe(3)
 expect((await post('plan',{playthrough:0,idempotencyKey:'plan'},cookie)).status).toBe(200)
 expect(local()).toBe(4)
 expect((await post('research',{playthrough:1,idempotencyKey:'replay'},cookie)).status).toBe(200)
 expect(local()).toBe(5)
 // A refused action records no charge, so retrying it is refused again rather than run for free.
 localMax=5
 expect((await post('poc',{playthrough:1,idempotencyKey:'refused'},cookie)).status).toBe(429)
 expect((await post('poc',{playthrough:1,idempotencyKey:'refused-retry'},cookie)).status).toBe(429)
 expect(local()).toBe(5)
})
