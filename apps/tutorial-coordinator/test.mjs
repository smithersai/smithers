import { bundle } from '../../flows/coding/build.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const directory=await mkdtemp(join(tmpdir(),'tutorial-tests-'))
try {
 for (const name of ['agent','retry','coordinator']) {
  const output=join(directory,`${name}.mjs`)
  await bundle(new URL(`./src/${name}.smoke.ts`,import.meta.url).pathname,output)
  execFileSync(process.execPath,[output],{stdio:'inherit',timeout:60_000})
 }
} finally {await rm(directory,{recursive:true,force:true})}
