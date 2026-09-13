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
  Layer.succeed(TurnLimits,{spend:()=>Effect.succeed({allowed,remaining:allowed?19:0,retryAt:Date.now()+10000})}),
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
 expect((await run(request())).status).toBe(429)
 expect(calls.length).toBe(2)
})
