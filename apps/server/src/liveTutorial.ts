import { Effect, Redacted } from "effect"
import { WORKER_FAILURES } from "@smthrs/rpc/WorkerFailureCodes"
import type { WorkerFailureCode } from "@smthrs/rpc/WorkerFailureCodes"
import { LiveTutorialStartSchema } from "@smthrs/rpc/LiveTutorial"
import { ServerConfig } from "./Config"
import { fetchWithDeadline, readBoundedText } from "./Http"
import { TurnLimits, anonymousTurnKey, ANONYMOUS_CEILING, ANONYMOUS_ALL_CEILING } from "./turnLimit"
import type { TurnBudget } from "./turnLimit"

const COOKIE = "__Host-smithers-tutorial"
const lifetime = 60 * 60 * 1000
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2,"0")).join("")
const signingKey = (secret: string) => crypto.subtle.importKey("raw",new TextEncoder().encode(`tutorial-session:${secret}`),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"])
export const mintTutorialSession = (secret: string, now = Date.now()) => Effect.gen(function*(){
  const value = `${crypto.randomUUID()}.${now}`
  const key=yield* Effect.promise(()=>signingKey(secret))
  const signature=yield* Effect.promise(()=>crypto.subtle.sign("HMAC",key,new TextEncoder().encode(value)))
  return `${value}.${hex(signature)}`
})
export const readTutorialSession = (cookie: string | null, secret: string, now = Date.now()) => Effect.gen(function*(){
  const value = cookie?.split(";").map(v=>v.trim()).find(v=>v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1)
  if (!value) return
  const [id,time,mac,...extra] = value.split(".")
  if(extra.length || !/^[0-9a-f-]{36}$/.test(id ?? "") || !/^\d{13}$/.test(time ?? "") || !/^[0-9a-f]{64}$/.test(mac ?? "")) return
  const age = now-Number(time)
  if(age<0||age>lifetime) return
  const signature = Uint8Array.from(mac!.match(/../g)!,v=>parseInt(v,16))
  const key=yield* Effect.promise(()=>signingKey(secret))
  const valid=yield* Effect.promise(()=>crypto.subtle.verify("HMAC",key,signature,new TextEncoder().encode(`${id}.${time}`)))
  return valid ? id : undefined
})
/* The Worker's own refusal, at the status its code names (@smthrs/rpc/WorkerFailureCodes). */
const json = (code: WorkerFailureCode, message: string) =>
  Response.json({ status: "error", code, message }, {
    status: WORKER_FAILURES[code].status,
    headers: { "cache-control": "no-store" }
  })

const tutorialLimitResponse = (budget: TurnBudget, shared: boolean): Response => {
  const retryAt = budget.retryAt ?? Date.now() + ANONYMOUS_CEILING.windowMs
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
  return Response.json({
    status: "error", code: "turn_rate_limited" satisfies WorkerFailureCode,
    message: `${shared ? "Practice agent runs have reached their daily limit for everyone." : "Practice agent runs from this network have reached their daily limit."} You can still read your saved results and create a Change from a finished implementation. Try another agent run in about ${Math.ceil(seconds / 60)} minutes.`,
    retryAt: new Date(retryAt).toISOString()
  }, { status: 429, headers: { "retry-after": String(seconds), "cache-control": "no-store" } })
}

export const handleLiveTutorial = (request:Request) => Effect.gen(function*(){
  const config=yield* ServerConfig
  if(!config.tutorialServiceUrl||!config.tutorialServiceToken) return json("seam_not_configured","The live tutorial service is not available yet.")
  const token=Redacted.value(config.tutorialServiceToken)
  const path=new URL(request.url).pathname.slice("/api/tutorial/live".length)
  const operation=/^\/(research|plan|implement|change|poc)$/.exec(path)?.[1]
  const read=/^\/run\/([a-zA-Z0-9_-]{1,128})$/.exec(path)?.[1]
  if(!(request.method==="POST"&&operation)&&!(request.method==="GET"&&read)) return json("route_not_found","Unknown live tutorial action.")
  let session=yield* readTutorialSession(request.headers.get("cookie"),token)
  if(!session&&(operation==="plan"||operation==="implement"||operation==="change")) return json("session_expired","This live example session expired. Your saved results remain available; start a new tutorial to run the agent again.")
  let setCookie:string|undefined
  let body:string|undefined
  if(operation){
    const raw=yield* readBoundedText(request,4096).pipe(Effect.catch(error=>Effect.succeed(error._tag==="BodyTooLarge"?undefined:"")))
    if(raw===undefined) return json("request_body_too_large","The tutorial request is too large.")
    let parsed:unknown
    try{parsed=JSON.parse(raw)}catch{return json("request_body_not_json","The tutorial request must be JSON.")}
    const input=LiveTutorialStartSchema.safeParse(parsed)
    if(!input.success) return json("request_invalid","The tutorial request needs an idempotency key and playthrough.")
    // A Change packages an already verified implementation. It starts no
    // model or executor and remains available when agent spending is capped.
    // The signed session and coordinator's commit-ownership gate still apply.
    if(operation!=="change") {
      const limits=yield* TurnLimits
      const key=yield* anonymousTurnKey(request,token)
      const local=yield* limits.spend(`tutorial:${key}`,ANONYMOUS_CEILING)
      if(!local.allowed)return tutorialLimitResponse(local,false)
      const shared=yield* limits.spend("tutorial:all",ANONYMOUS_ALL_CEILING)
      if(!shared.allowed)return tutorialLimitResponse(shared,true)
    }
    if(!session){
      const signed=yield* mintTutorialSession(token)
      session=signed.split(".")[0]!
      setCookie=`${COOKIE}=${signed}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`
    }
    body=JSON.stringify(input.data)
  }
  if(!session)return json("session_expired","This live example session expired. Your saved results remain available; start a new tutorial to run the agent again.")
  const response=yield* fetchWithDeadline("The live tutorial",`${config.tutorialServiceUrl.replace(/\/$/, "")}/sessions/${session}${path}`,{
    method:request.method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},...(body?{body}:{})
  },30_000).pipe(Effect.catch(()=>Effect.succeed(json("service_temporarily_unavailable","The live tutorial service is temporarily unavailable. Your run can be resumed."))))
  const headers=new Headers(response.headers)
  headers.set("cache-control","no-store")
  headers.delete("set-cookie")
  if(setCookie)headers.set("set-cookie",setCookie)
  return new Response(response.body,{status:response.status,headers})
})
