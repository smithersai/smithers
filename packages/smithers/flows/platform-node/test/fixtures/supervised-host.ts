import * as NodeSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Effect, Layer } from "effect"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { targetPidOf } from "../../src/internal/ProcessSupervisor.ts"
import * as ProcessReaper from "../../src/ProcessReaper.ts"

// A real host, in its own process, so a test can kill it outright. Nothing in
// this file may notice that death: the supervisor's own loss of the private
// channel is the whole subject, so the host installs no exit handler, holds
// its scope open forever, and never runs a finalizer once the test signals it.
const directory = process.argv[2]!
const token = process.argv[3]!
const targetBeat = join(directory, "target.json")
const childBeat = join(directory, "child.json")
const graceMs = 200

const beating = (path: string) =>
  `const fs=require('node:fs');let tick=0;
  const beat=()=>{fs.writeFileSync(${JSON.stringify(path)}+'.tmp',JSON.stringify({token,pid:process.pid,tick:tick++}));
    fs.renameSync(${JSON.stringify(path)}+'.tmp',${JSON.stringify(path)})};
  beat();setInterval(beat,25);`

// Both workloads refuse the polite signal, so only the supervisor's own
// escalation can end them. Both carry the fixture token in their argv, which
// is what makes a later liveness answer about these exact processes.
const grandchild = `const token=process.argv.at(-1);process.on('SIGTERM',()=>{});${beating(childBeat)}`
const target = `const cp=require('node:child_process');const token=process.argv.at(-1);
  process.on('SIGTERM',()=>{});
  cp.spawn(process.execPath,['-e',${JSON.stringify(grandchild)},token],{stdio:'ignore'});
  ${beating(targetBeat)}`

const raw = NodeSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer)))
const contained = ProcessReaper.layerSpawner({ graceMs }).pipe(Layer.provide(raw))

const beat = (path: string): { readonly token: string; readonly pid: number; readonly tick: number } | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

await Effect.runPromise(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(process.execPath, ["-e", target, token], {
        env: { PATH: "/usr/bin:/bin" },
        forceKillAfter: graceMs,
        stdout: "ignore",
        stderr: "ignore"
      })
    )
    while (!(existsSync(targetBeat) && existsSync(childBeat))) yield* Effect.sleep(5)
    const workloads = { target: beat(targetBeat)!, child: beat(childBeat)! }
    if (workloads.target.token !== token || workloads.child.token !== token) {
      throw new Error("Fixture workloads reported a different identity")
    }
    console.log(JSON.stringify({
      host: process.pid,
      supervisor: handle.pid,
      target: targetPidOf(handle),
      grandchild: workloads.child.pid,
      graceMs
    }))
    // The scope stays open until the test ends this process the hard way.
    yield* Effect.never
  }).pipe(
    Effect.provide(contained),
    Effect.provide(ProcessLedger.layerMemory({ hostId: token, ownerPid: process.pid })),
    Effect.scoped
  )
)
