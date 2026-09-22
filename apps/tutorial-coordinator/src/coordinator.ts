import { DatabaseSync } from "node:sqlite"
import { randomUUID, createHash } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { LiveTutorialRun, LiveTutorialOperation, LiveTutorialStart } from "@smthrs/rpc/LiveTutorial"
import type { Executor } from "../../tutorial-executor/src/KubernetesExecutor"
import type { AgentAnswer } from "./agent"
import { TutorialJournal } from "./TutorialJournal"
import { CoordinatorOwnership } from "./CoordinatorOwnership"

export interface Dependencies {
  ensure(session:string):Promise<Executor>
  agent(filename:string,executionId:string,instructions:string,context:unknown):Promise<AgentAnswer>
}
const editable=new Set(["src/hello.ts","src/hello.test.ts","README.md"])
const issue="Issue #3: GET /hello without a name returns Hello, null!, and an empty name returns Hello, !. Both must return Hello, world!; name=Ada must still return Hello, Ada!."
export function parseDiff(patch:string):NonNullable<LiveTutorialRun["diff"]>{
  return patch.split(/(?=^diff --git )/m).filter(part=>part.startsWith("diff --git ")).map(part=>{
    const match=/^diff --git a\/(.+) b\/(.+)$/m.exec(part)
    if(!match||!editable.has(match[2]!))throw new Error("The executor returned an unexpected changed path")
    const lines=part.split("\n")
    return {path:match[2]!,changeType:part.includes("new file mode")?"added":"modified",isBinary:false,additions:lines.filter(l=>l.startsWith("+")&&!l.startsWith("+++")).length,deletions:lines.filter(l=>l.startsWith("-")&&!l.startsWith("---")).length,patch:part}
  })
}
export class Coordinator {
  readonly db:DatabaseSync
  private busy=new Set<string>()
  private readonly ownerId=randomUUID()
  private readonly ownership:CoordinatorOwnership
  private recovered=false
  private closed=false
  readonly directory:string
  readonly deps:Dependencies
  readonly journal:TutorialJournal
  constructor(directory:string,deps:Dependencies){
    this.directory=directory;this.deps=deps
    this.ownership=new CoordinatorOwnership(directory)
    this.db=new DatabaseSync(join(directory,"coordinator.sqlite"))
    try{
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session TEXT NOT NULL, playthrough INTEGER NOT NULL, key TEXT NOT NULL, plan TEXT, body TEXT NOT NULL, input TEXT NOT NULL, UNIQUE(session,playthrough,key)); CREATE TABLE IF NOT EXISTS checkpoints (run TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(run,name));")
    this.journal=new TutorialJournal(this.db)
    this.activate()
    }catch(error){this.db.close();this.ownership.close();throw error}
  }
  private activate():boolean{
    if(this.closed)throw new Error("The tutorial coordinator is closed")
    if(!this.ownership.acquire())return false
    if(!this.recovered){for(const {run} of this.journal.all())this.journal.interrupt(run);this.recovered=true}
    return true
  }
  private assertOwner(){if(!this.ownership.owned)throw new Error("Another tutorial coordinator is still running. Try again shortly.")}
  private async external<T>(work:()=>Promise<T>):Promise<T>{
    this.assertOwner();const value=await work();this.assertOwner();return value
  }
  close(){
    if(this.closed)return
    this.closed=true
    try{this.db.close()}finally{this.ownership.close()}
  }
  get(session:string,id:string){return this.journal.get(session,id)}
  private save(run:LiveTutorialRun){this.journal.save(run)}
  private latest(session:string,playthrough:number,operation:LiveTutorialOperation){
    return this.journal.all().reverse().find(({run,input})=>run.sessionId===session&&input.playthrough===playthrough&&run.operation===operation&&run.phase==="completed")?.run
  }
  start(session:string,operation:LiveTutorialOperation,input:LiveTutorialStart):LiveTutorialRun{
    this.activate()
    const prior=this.journal.all().find(row=>row.run.sessionId===session&&row.input.playthrough===input.playthrough&&row.input.idempotencyKey===input.idempotencyKey)
    if(prior){const run=prior.run;if(run.operation!==operation)throw new Error("The request key belongs to another tutorial action");this.schedule(run,prior.input);return run}
    this.assertOwner()
    if(operation==="implement"){
      const plan=this.latest(session,input.playthrough,"plan")?.plan
      if(!plan||plan.id!==input.planId)throw new Error("Review the latest plan before starting implementation")
      const completed=this.latest(session,input.playthrough,"implement")
      if(completed?.plan?.id===plan.id)return completed
    }
    if(operation==="plan"&&!this.latest(session,input.playthrough,"research"))throw new Error("Research the issue before planning the implementation")
    if(operation==="change"&&!this.latest(session,input.playthrough,"implement"))throw new Error("Finish a verified implementation before creating its Change")
    const active=this.journal.all().filter(row=>row.run.sessionId===session&&row.input.playthrough===input.playthrough)
    if(active.some(row=>["queued","running"].includes(row.run.phase)))throw new Error("The previous tutorial action is still running")
    const now=Date.now(),run:LiveTutorialRun={sessionId:session,runId:randomUUID(),operation,phase:"queued",createdAt:now,updatedAt:now,events:[]}
    this.journal.create(run,input)
    this.schedule(run,input);return run
  }
  async prune(now=Date.now()){
    if(!this.activate())return
    const rows=this.journal.all()
    const retained=new Set<string>(),expired:Array<{run:LiveTutorialRun,scope:string}>=[]
    for(const row of rows){
      const {run,input}=row
      const scope=createHash("sha256").update(`${run.sessionId}:${input.playthrough}${run.operation === "poc" ? `:poc:${run.runId}` : ""}`).digest("hex")
      if(!this.busy.has(run.runId)&&["completed","failed"].includes(run.phase)&&now-run.updatedAt>2*60*60*1000)expired.push({run,scope})
      else retained.add(scope)
    }
    for(const {run,scope} of expired){
      this.journal.remove(run)
      if(!retained.has(scope))await rm(join(this.directory,scope),{recursive:true,force:true})
    }
    if(expired.length)this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
  }
  resume():boolean{if(!this.activate())return false;for(const {run,input} of this.journal.all()){if(run.phase==="queued")this.schedule(run,input)}return true}
  private schedule(run:LiveTutorialRun,input:LiveTutorialStart){if(!this.ownership.owned||this.busy.has(run.runId)||run.phase!=="queued")return;if(!this.journal.claim(run,this.ownerId))return;this.busy.add(run.runId);void Promise.resolve().then(()=>this.execute(run,input)).catch(error=>{if(!this.closed)console.error("Tutorial journal did not accept run progress",error)}).finally(()=>this.busy.delete(run.runId))}
  private async checkpoint<T>(run:LiveTutorialRun,name:string,work:()=>Promise<T>):Promise<T>{
    const existing=this.journal.checkpoint(run,name)
    if(existing!==undefined)return JSON.parse(existing)
    const value=await this.external(work);this.journal.recordCheckpoint(run,name,JSON.stringify(value));return value
  }
  private async step<T>(run:LiveTutorialRun,id:string,label:string,work:()=>Promise<T>):Promise<T>{
    let event=run.events.find(e=>e.id===id)
    if(!event){event={id,label,status:"running",startedAt:Date.now()};run.events.push(event)}else if(event.status!=="completed"){event.status="running"}
    this.save(run)
    try{const result=await this.checkpoint(run,id,work);event.status="completed";event.finishedAt??=Date.now();
      if(result&&typeof result==="object"){
        const output=result as Record<string,unknown>
        if(typeof output.stdout==="string")event.detail=`${output.stdout}${typeof output.stderr==="string"?output.stderr:""}`.slice(0,24000)
        else if(typeof output.summary==="string")event.detail=[output.summary,...(Array.isArray(output.observations)?output.observations.filter(item=>typeof item==="string"):[])].join("\n").slice(0,24000)
        else if(typeof output.patch==="string")event.detail=output.patch.slice(0,24000)
        else if(typeof output.sha==="string")event.detail=`${output.sha} ${output.subject??""}`
        else if(typeof output.base==="string")event.detail=`Base ${output.base}\n${Object.keys((output.files??{}) as object).join("\n")}`
      }
      this.save(run);return result}catch(error){event.status="failed";event.finishedAt=Date.now();this.save(run);throw error}
  }
  private async execute(run:LiveTutorialRun,input:LiveTutorialStart){
    try{
      this.assertOwner()
      run.phase="running";this.save(run)
      const scope=createHash("sha256").update(`${run.sessionId}:${input.playthrough}${run.operation === "poc" ? `:poc:${run.runId}` : ""}`).digest("hex")
      const folder=join(this.directory,scope);await mkdir(folder,{recursive:true})
      if(run.operation==="change"){
        const implemented=this.latest(run.sessionId,input.playthrough,"implement")!
        const commits=implemented.commits??[],selected=input.commitIds??commits.map(c=>c.commitId)
        if(!selected.length||selected.some(id=>!commits.some(c=>c.commitId===id)))throw new Error("Choose commits produced by this implementation")
        run.change={id:run.runId,title:implemented.plan?.title??"Fix the greeting",summary:implemented.result??"",commitIds:selected,baseCommitId:implemented.baseCommitId!}
        run.commits=commits.filter(c=>selected.includes(c.commitId));run.diff=implemented.diff;run.files=implemented.files;run.result="The Change is ready to review.";run.phase="completed";this.save(run);return
      }
      const executor=await this.step(run,"workspace","Prepare your isolated example repository",()=>this.deps.ensure(scope).then(()=>({ready:true}))).then(()=>this.external(()=>this.deps.ensure(scope)))
      const snapshot=await this.step(run,"snapshot","Read the repository",()=>executor.snapshot())
      if ((await this.external(()=>executor.snapshot())).base !== snapshot.base) throw new Error("This isolated example workspace expired. Start a new tutorial playthrough.")
      run.baseCommitId=snapshot.head;run.branch="main";run.files=snapshot.files;this.save(run)
      const model=(name:string,instructions:string,context:unknown)=>this.step(run,name,name==="research"?"Research the issue":name==="plan"?"Plan the implementation":"Ask the agent to implement the fix",()=>this.deps.agent(join(folder,"flows.sqlite"),`${run.runId}-${name}`,instructions,context))
      if(run.operation==="research"){
        const tested=await this.step(run,"reproduce","Run the existing tests and reproduce the missing and empty name cases",()=>executor.test())
        run.tests={command:tested.command,exitCode:tested.code,output:(tested.stdout+tested.stderr).slice(0,24000)}
        const answer=await model("research","Research this issue using the supplied source and ACTUAL command output. Return a concise summary and evidence/next actions in steps. files must be []; title identifies the issue; message is empty. Do not propose that code was changed.",{issue,files:snapshot.files,tests:run.tests})
        run.result=[answer.summary,...answer.steps.map(s=>`- ${s}`)].join("\n\n")
      }else if(run.operation==="plan"){
        const research=this.latest(run.sessionId,input.playthrough,"research")!
        const answer=await model("plan","Plan a minimal fix covering missing and empty names while preserving named greetings. Return title,summary,ordered steps. files must list only intended edited paths with content empty. message is empty. Do not implement or claim tests passed.",{issue,files:snapshot.files,research:research.result,tests:research.tests})
        if(!answer.steps.length)throw new Error("The agent returned an empty plan")
        run.plan={id:run.runId,title:answer.title,summary:answer.summary,baseCommitId:snapshot.head,steps:[...answer.steps],files:answer.files.map(f=>f.path).filter(p=>editable.has(p))};run.result=answer.summary
      }else{
        const plan=run.operation === "poc" ? { id:run.runId,title:"Proof of concept for issue #3",summary:"Try a small solution in an isolated disposable example repository",baseCommitId:snapshot.head,steps:["Apply the smallest fix and test missing, empty, and named inputs"],files:["src/hello.ts","src/hello.test.ts"] } : this.latest(run.sessionId,input.playthrough,"plan")!.plan!
        if(run.operation !== "poc" && (plan.id!==input.planId||plan.baseCommitId!==snapshot.head))throw new Error("The repository changed after this plan. Request a new plan")
        if(run.operation !== "poc") run.plan=plan;this.save(run)
        let feedback:unknown=undefined,passed=false,last:AgentAnswer|undefined
        for(let attempt=0;attempt<3;attempt++){
          const answer=await model(`implement-${attempt}`,"Implement the approved plan. Return complete replacement contents for only src/hello.ts,src/hello.test.ts,README.md as necessary. Include regression tests for missing, empty, and named inputs. Return summary and a concise commit message. Never change infrastructure, package scripts, or unrelated files. Do not claim your proposed edits were already applied or tested.",{issue,plan,files:snapshot.files,feedback})
          if(!answer.files.length||answer.files.some(f=>!editable.has(f.path)||f.content.length>65536))throw new Error("The agent returned edits outside the approved example files")
          await this.step(run,`apply-${attempt}`,"Apply the agent's edits",()=>executor.apply(Object.fromEntries(answer.files.map(f=>[f.path,f.content]))))
          const tested=await this.step(run,`test-${attempt}`,"Run the tests against the actual edited files",()=>executor.test())
          run.tests={command:tested.command,exitCode:tested.code,output:(tested.stdout+tested.stderr).slice(0,24000)};this.save(run)
          last=answer;if(tested.code===0){passed=true;break}
          feedback={proposedFiles:answer.files,tests:run.tests}
        }
        if(!passed||!last)throw new Error("The implementation did not pass the tests after three attempts. Review the recorded test output before retrying")
        const before=await this.step(run,"diff","Read the actual diff",()=>executor.diff(plan.baseCommitId));const diff=parseDiff(before.patch)
        if(!diff.length)throw new Error("The agent produced no code change")
        if(run.operation === "poc") { run.diff=diff;run.files=await this.external(()=>executor.files());run.result=`${last.summary}\n\nThe proof of concept passed the recorded tests in a separate disposable repository. Your implementation workspace is unchanged.`;run.phase="completed";this.save(run);return }
        const commit=await this.step(run,"commit","Commit the verified fix",()=>executor.commit(last!.message.trim().slice(0,160)||plan.title,run.runId))
        if(commit.parent!==plan.baseCommitId)throw new Error("The committed fix does not match the approved plan base")
        run.commits=[{commitId:commit.sha,parentCommitId:commit.parent,message:commit.subject,files:diff.map(f=>f.path),additions:diff.reduce((n,f)=>n+f.additions,0),deletions:diff.reduce((n,f)=>n+f.deletions,0)}]
        run.diff=diff;run.files=await this.external(()=>executor.files());run.result=last.summary
      }
      run.phase="completed";this.save(run)
    }catch(error){run.phase="failed";run.error=error instanceof Error?error.message.slice(0,350):"The tutorial action failed";this.save(run)}
  }
}
