import { createServer } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { LiveTutorialOperationSchema, LiveTutorialStartSchema } from "@smthrs/rpc/LiveTutorial"
import { ensure } from "../../tutorial-executor/src/KubernetesExecutor"
import { runAgent } from "./agent"
import { Coordinator } from "./coordinator"

const directory=process.env.TUTORIAL_DATA_DIR??"/data"
const provider=process.env.TUTORIAL_PROVIDER??"openai"
if(provider!=="openai"&&provider!=="gemini")throw new Error("Unsupported tutorial provider")
const token=process.env.TUTORIAL_SERVICE_TOKEN,apiKey=provider==="gemini"?process.env.GEMINI_API_KEY:process.env.OPENAI_API_KEY,model=process.env.TUTORIAL_MODEL
if(!token||!apiKey||!model)throw new Error("Configure tutorial service authentication and model settings before starting")
await mkdir(directory,{recursive:true})
const coordinator=new Coordinator(directory,{ensure,agent:(filename,id,instructions,context)=>runAgent(filename,apiKey,model,id,instructions,context,provider)})
coordinator.resume()
setInterval(()=>{void coordinator.prune().catch(()=>console.error("Tutorial artifact cleanup failed"))},5*60*1000).unref()
createServer(async(request,response)=>{
  const send=(status:number,value:unknown)=>{response.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});response.end(JSON.stringify(value))}
  const path=new URL(request.url??"/","http://internal").pathname.replace(/^\/__tutorial(?=\/)/,"")
  if(path==="/health"&&request.method==="GET"){send(200,{status:"ok"});return}
  const authorization=Buffer.from(request.headers.authorization??""),expected=Buffer.from(`Bearer ${token}`)
  if(authorization.length!==expected.length||!timingSafeEqual(authorization,expected)){send(401,{message:"Service authentication required"});return}
  const match=/^\/sessions\/([0-9a-f-]{36})\/(?:run\/([a-zA-Z0-9_-]{1,128})|([a-z]+))$/.exec(path)
  if(!match){send(404,{message:"Unknown tutorial route"});return}
  try{
    if(request.method==="GET"&&match[2]){const run=coordinator.get(match[1]!,match[2]);send(run?200:404,run??{message:"This tutorial run was not found"});return}
    const operation=LiveTutorialOperationSchema.safeParse(match[3])
    if(request.method!=="POST"||!operation.success){send(405,{message:"Unsupported tutorial action"});return}
    let body=""
    for await(const chunk of request){body+=chunk;if(body.length>4096){send(413,{message:"Tutorial request too large"});return}}
    const input=LiveTutorialStartSchema.safeParse(JSON.parse(body))
    if(!input.success){send(400,{message:"Invalid tutorial input"});return}
    send(202,coordinator.start(match[1]!,operation.data,input.data))
  }catch(error){send(409,{message:error instanceof Error?error.message.slice(0,300):"The tutorial action could not start"})}
}).listen(Number(process.env.PORT??3000),"0.0.0.0")
