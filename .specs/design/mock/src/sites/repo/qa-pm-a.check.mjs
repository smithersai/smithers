/* PM final A rows 6/7/9/10/11/12: actual builds and fixture-derived navigation. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
const build=process.argv.find(a=>a.startsWith('--build-root='))?.slice(13)??resolve(root,'dist-codex')
const req=createRequire(resolve(root,'../../../apps/app/package.json'))
const {Window}=await import(req.resolve('happy-dom'))
const wait=()=>new Promise(r=>setTimeout(r,110))
let checks=0
const failures=[],counts={},identities={},changed={}
const check=(ok,why)=>{checks++;if(!ok)failures.push(why)}
const message='Hosted runs that change code are held. Run smthrs locally: npm i -g smthrs@next'
const sites=[['default','maya/tinyhttp'],['smithers-site','smithers-canary/smithers'],['effeck-site','effeck/effeck'],['effect','Effect-TS/effect']]
for(const [site,slug] of sites){
 const w=new Window({url:'http://localhost/?still=1',width:390,height:844})
 const html=readFileSync(resolve(build,site,'index.html'),'utf8')
 const open=async(route)=>{w.location.hash='#/'+route;await wait()}
 try{
  w.sessionStorage.setItem('repo-ask-open','false')
  w.document.body.innerHTML='<div id="root"></div>'
  w.eval('(function(){'+html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]+'})()');await wait()
  const meta=w.__SITE__
  counts[site]={screens:meta.screens.length,routes:meta.routes.length}
  identities[site]={screens:meta.screens.map(({id,route})=>({id,route})),routes:meta.routes}
  changed[site]=meta.screens.filter(s=>/home|tree|directory|held|stack|pull|flows/.test(s.id)).map(s=>s.id)
  const fixture=resolve(root,'src/sites/repo/fixtures/data',slug.replace('/','__'))
  const repo=JSON.parse(readFileSync(resolve(fixture,'repo.json'),'utf8'))
  const prompt=repo.config.home?.find(b=>b.type==='prompt')
  for(const as of ['out','in']){
   await open(`smithers.sh/${slug}?as=${as}&role=member&net=ok&data=full&guest=off`)
   const toggle=w.document.querySelector('.repo-frame-ask-button[aria-expanded="true"]')
   if(toggle){toggle.click();await wait()}
   if(prompt){
    const title=prompt.title.replaceAll('{package}','the workspace')
    check([...w.document.querySelectorAll('.repo-ui-box-title')].some(n=>n.textContent===title)||w.document.querySelector('#repo-content')?.textContent.includes(title),`${site}/${as}: prompt title comes from config verbatim`)
    if(as==='out')check([...w.document.querySelectorAll('.repo-code-home-block button')].some(n=>n.textContent===`Sign in to ${title.replace(/^Ask\b/,'ask')}`),`${site}: sign-in action uses configured title`)
   }
   const links=[...w.document.querySelectorAll('.repo-code-home-links a')]
   if(site==='smithers-site')check(JSON.stringify(links.map(a=>a.textContent.trim()))===JSON.stringify(['Install Smithers','Docs','Report a bug','Fixed by agents']),`${site}: exact PM links/order`)
   for(const a of links.filter(a=>a.textContent.includes('Report a bug')))check(a.getAttribute('href').split('?')[0]===`#/smithers.sh/${slug}/${site === "effeck-site" ? "issues" : "bug"}`,`${site}: issue-report link follows the pinned home config`)
   if(site==='effeck-site')check(w.document.querySelector('.repo-ui-markdown-alert[data-kind="warning"]')&&!w.document.querySelector('#repo-content').textContent.includes('[!WARNING]'),`${site}: README warning renders as alert`)
  }
  for(const screen of meta.screens.filter(s=>/held/.test(s.id)&&!/models|eval/.test(s.id))){
   await open(screen.route)
   const held=w.document.querySelector('.repo-ui-held-code-change')
   if(held){
    check(held.textContent.startsWith(message),`${site}/${screen.id}: exact held sentence`)
    let copied='';Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{writeText:async value=>{copied=value}}})
    held.querySelector('button').click();await wait()
    check(copied==='npm i -g smthrs@next',`${site}/${screen.id}: exact copyable install`)
   }
  }
  if(site==='effeck-site')for(const suffix of ['issues/50?act=implement','runs/run-convert-golden-eval']){
   await open(`smithers.sh/${slug}/${suffix}${suffix.includes('?')?'&':'?'}as=in&role=member&net=ok&data=full&host=hosted&landing=install`)
   check(w.document.querySelector('.repo-ui-held-code-change')?.textContent.startsWith(message),`${site}/${suffix}: PM held state`)
  }
 }finally{await w.happyDOM.close()}
}
// Exercise the live tree API, including an incomplete directory-only branch.
const temp=mkdtempSync(join(tmpdir(),'qa-pm-a-tree-'))
try{
 const bundle=await req('esbuild').build({stdin:{contents:`import {KNOWN_REPOS,selectRepo,repo,tree,children,files} from './src/sites/repo/fixtures';export {KNOWN_REPOS,selectRepo,repo,tree,children,files};`,resolveDir:root,loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',nodePaths:[resolve(root,'../../../apps/app/node_modules')]})
 const output=join(temp,'tree.cjs');writeFileSync(output,bundle.outputFiles[0].text);const api=req(output)
 for(const slug of api.KNOWN_REPOS){
  api.selectRepo(slug)
  for(const e of api.tree){
   if(e.kind==='dir')check(api.children(e.path).length>0,`${slug}/${e.path}: no empty directory`)
  }
  api.tree.push({path:'pm-empty',kind:'dir',sha:'test'},{path:'pm-empty/nested',kind:'dir',sha:'test'})
  check(!api.children('').some(e=>e.path==='pm-empty'),`${slug}: derivation hides incomplete directory branches`)
  api.tree.splice(-2)
  const files=api.files
  for(const f of files)check(api.tree.find(e=>e.path===f.path)?.size===Buffer.byteLength(f.content),`${slug}/${f.path}: tree size matches blob`)
  const home=files.find(f=>f.path==='.smithers/home.json')
  if(home&&slug!=='maya/tinyhttp'){
   const configured=api.repo.config.home
   for(const b of JSON.parse(home.content).blocks)check(configured.some(c=>JSON.stringify(b)===JSON.stringify(c)),`${slug}: home.json blocks drive config`)
  }
 }
}finally{rmSync(temp,{recursive:true,force:true})}
writeFileSync(join(tmpdir(),'qa-pm-a-results.json'),JSON.stringify({checks,counts,identities,changed,failures},null,2))
console.log(JSON.stringify({checks,counts,failures},null,2))
assert.equal(failures.length,0,'PM A regressions')
