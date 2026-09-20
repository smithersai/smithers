import { bundle } from '../../flows/coding/build.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
const directory=await mkdtemp(join(tmpdir(),'tutorial-tests-'))
try {
 const server=join(directory,'server.mjs')
 await bundle(new URL('./src/server.ts',import.meta.url).pathname,server)
 const state=join(directory,'state')
 const env={...process.env,PORT:'5309',TUTORIAL_DATA_DIR:state}
 delete env.AI_GATEWAY_API_KEY
 const refused=spawnSync(process.execPath,[server],{env,encoding:'utf8',timeout:30_000})
 assert.equal(refused.status,1,refused.stderr)
 assert.match(refused.stderr,/tutorial-coordinator needs AI_GATEWAY_API_KEY,/)
 assert.equal(existsSync(state),false,'a refused host must not create its state directory')
 console.log('tutorial server refuses a missing judge before creating state')
 for (const name of ['kubernetes','providerRelay','model','agent','retry','coordinator','executorAuth']) {
  const output=join(directory,`${name}.mjs`)
  await bundle(new URL(`./src/${name}.smoke.ts`,import.meta.url).pathname,output)
  const env={...process.env}
  if(name==='executorAuth'){const artifact=join(directory,'executor.mjs');await bundle(new URL('../tutorial-executor/src/executor.ts',import.meta.url).pathname,artifact);env.TUTORIAL_EXECUTOR_ARTIFACT=artifact}
  execFileSync(process.execPath,[output],{stdio:'inherit',timeout:60_000,env})
 }
} finally {await rm(directory,{recursive:true,force:true})}
