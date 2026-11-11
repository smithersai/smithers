import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { Session } from "node:inspector"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Agents from "../../src/Agents.ts"
import * as ClaudeMirror from "../../src/ClaudeMirror.ts"

// Real filesystem operations, paused at a V8 statement boundary. No filesystem
// calls are replaced: FIFOs order the competing processes without timed waits.
const [scenario, root] = process.argv.slice(2)
const url = new URL("../../src/Agents.ts", import.meta.url).href
const path = join(root, ".claude.json")
const lock = `${path}.smithers.lock`
const agent = Agents.find("claude")
const at = (needle, callback, columnNeedle = needle.trimStart(), target = url) => {
  const lines = readFileSync(new URL(target), "utf8").split("\n")
  const lineNumber = lines.findIndex((line) => line.includes(needle))
  if (lineNumber < 0) throw new Error(`Missing statement: ${needle}`)
  const session = new Session()
  session.connect()
  session.post("Debugger.enable")
  let breakpoint
  session.post("Debugger.setBreakpointByUrl", {
    url: target, lineNumber, columnNumber: lines[lineNumber].indexOf(columnNeedle)
  }, (error, result) => {
    if (error) throw error
    breakpoint = result.breakpointId
  })
  let hits = 0
  session.on("Debugger.paused", ({ params }) => {
    if (params.hitBreakpoints.includes(breakpoint) && hits++ === 0) callback()
    session.post("Debugger.resume")
  })
  return () => { session.disconnect(); return hits }
}

if (scenario === "subscribe") {
  ClaudeMirror.subscribe(root, "run-a", "session-a", 1000)
  const stop = at("writeSubscriptions(root,", () => {
    ClaudeMirror.unsubscribe(root, "run-a", "session-a", 1000)
  }, "writeSubscriptions", new URL("../../src/ClaudeMirror.ts", import.meta.url).href)
  ClaudeMirror.subscribe(root, "run-b", "session-b", 1000)
  const hits = stop()
  console.log(JSON.stringify({ raced: hits, entries: ClaudeMirror.readSubscriptions(root, 1000) }))
} else if (scenario === "hold") {
  let held = false
  const stop = at('if (agent.id === "codex") return registerCodex', () => {
    held = true
    writeFileSync(join(root, "ready"), "held")
    readFileSync(join(root, "release"))
  })
  const result = Agents.addMcp(agent, root)
  stop()
  if (!held) writeFileSync(join(root, "ready"), JSON.stringify(result))
} else {
  writeFileSync(path, '{"theme":"original"}\n')
  let raced = 0
  let peerHeld = false
  let child
  let stop
  if (scenario === "recover") {
    const departed = spawnSync(process.execPath, ["-e", ""])
    writeFileSync(lock, `${departed.pid}:abandoned`)
    for (const pipe of ["ready", "release"]) {
      const result = spawnSync("mkfifo", [join(root, pipe)])
      if (result.status !== 0) throw new Error("mkfifo failed")
    }
    stop = at('if (readFileSync(lockPath, "utf8") === observed) unlinkSync(lockPath)', () => {
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), "hold", root], { stdio: "ignore" })
      peerHeld = readFileSync(join(root, "ready"), "utf8") === "held"
      raced++
    }, "unlinkSync")
  } else {
    // An external client's update lands after Smithers read the configuration.
    stop = at('run(["add-json"', () => { writeFileSync(path, '{"theme":"external"}\n'); raced++ })
  }
  const result = Agents.addMcp(agent, root)
  const hits = stop()
  const lockSurvived = peerHeld && existsSync(lock) && readFileSync(lock, "utf8").startsWith(`${child.pid}:`)
  if (peerHeld) writeFileSync(join(root, "release"), "continue")
  console.log(JSON.stringify({ result, hits, raced, peerHeld, lockSurvived,
    document: JSON.parse(readFileSync(path, "utf8")) }))
}
