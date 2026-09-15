import { bundle } from '../../flows/coding/build.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const directory=await mkdtemp(join(tmpdir(),'tutorial-tests-'))
try {
 for (const name of ['kubernetes','providerRelay','model','agent','retry','coordinator','executorAuth']) {
  const output=join(directory,`${name}.mjs`)
  await bundle(new URL(`./src/${name}.smoke.ts`,import.meta.url).pathname,output)
  const env={...process.env}
  if(name==='executorAuth'){const artifact=join(directory,'executor.mjs');await bundle(new URL('../tutorial-executor/src/executor.ts',import.meta.url).pathname,artifact);env.TUTORIAL_EXECUTOR_ARTIFACT=artifact}
  execFileSync(process.execPath,[output],{stdio:'inherit',timeout:60_000,env})
 }
} finally {await rm(directory,{recursive:true,force:true})}
