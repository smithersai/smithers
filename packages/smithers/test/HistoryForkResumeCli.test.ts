import * as History from "../src/history/History.ts"
/** Actual module bytes, native jj/SQLite and the canonical CLI resume boundary. */
import * as AgentSession from "@smthrs/agent/AgentSession"
import { execFile, execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { childEnvironment } from "./support/node-child.ts"

const execute = promisify(execFile)
const source = `
import { Action, DurableClock, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { appendFileSync } from "node:fs"
const marker = new URL("../../../executed.jsonl", import.meta.url)
const First = Action.make("steps/First", { implementationVersion:"first/v1", payload:{}, success:Schema.String, tier:"irreversible", idempotencyKey:"first" })
const Pause = Action.make("steps/Pause", { implementationVersion:"pause/v1", payload:{}, success:Schema.String, tier:"sealed" })
const Finish = Action.make("steps/Finish", { implementationVersion:"finish/v1", payload:{}, success:Schema.String, tier:"irreversible", idempotencyKey:"finish" })
export const layer = Layer.mergeAll(
 First.toLayer(()=>Effect.sync(()=>{appendFileSync(marker,"first\\n");return "first"}),{implementationVersion:"first/v1"}),
 Pause.toLayer(()=>Effect.gen(function*(){yield* DurableClock.sleep({name:"park",duration:"20 seconds",inMemoryThreshold:0});return "awake"}),{implementationVersion:"pause/v1"}),
 Finish.toLayer(()=>Effect.sync(()=>{appendFileSync(marker,"finish\\n");return "done"}),{implementationVersion:"finish/v1"})
)
export default Flow.make("steps", {
 description:"Recorded steps across a retained fork", capabilities:["fs:write:**"],
 effects:{reads:[],writes:["executed.jsonl"],mode:"expected",onConflict:"serialize",tier:"irreversible"},
 payload:{name:Schema.String},success:Schema.String,
 body:Node.capture({action:First.name,implementationVersion:"first/v1"},()=>First.call({}).pipe(Node.bindPlanned(Node.capture({action:Pause.name,implementationVersion:"pause/v1"},()=>Pause.call({}))),Node.bindPlanned(Node.capture({action:Finish.name,implementationVersion:"finish/v1"},()=>Finish.call({})))))
})
`

it("resumes the retained module snapshot, replays carried steps and settles only the fork", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-fork-resume-cli-")))
  const helper = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
  const read = <A>(name: "engine" | "control", f: (db: DatabaseSync) => A): A => {
    const db = new DatabaseSync(join(root, ".flows", `${name}.db`), { readOnly: true })
    try {
      return f(db)
    } finally {
      db.close()
    }
  }
  const run = async (...args: Array<string>) => {
    const result = await execute(process.execPath, [
      "--no-warnings",
      resolve("src/bin.ts"),
      ...args,
      "--root",
      root,
      "--json"
    ], {
      cwd: root,
      timeout: 60_000,
      env: childEnvironment({
        PATH: process.env.PATH,
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: helper
      })
    }).catch((cause: unknown) => {
      const error = cause as { stdout?: string; stderr?: string }
      throw new Error(JSON.stringify({ args, stdout: error.stdout, stderr: error.stderr, cause: String(cause) }))
    })
    return JSON.parse(result.stdout) as Record<string, unknown>
  }
  try {
    mkdirSync(join(root, ".smithers", "flows", "steps"), { recursive: true })
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir")
    writeFileSync(join(root, ".gitignore"), ".flows/\nnode_modules\nhome/\nconfig/\n")
    writeFileSync(join(root, ".smithers", "flows", "steps", "flow.ts"), source)
    execFileSync("jj", ["git", "init", root], { stdio: "ignore" })
    execFileSync("jj", ["new", "-R", root], { stdio: "ignore" })
    // The explicit offline evaluator supplies the required judge; no model
    // call, module loader, filesystem, engine or process boundary is mocked.
    const initial = await execute(process.execPath, [
      "--no-warnings",
      "--import",
      fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url)),
      fileURLToPath(new URL("./fixtures/history-fork-start.ts", import.meta.url)),
      root
    ], { cwd: root, env: childEnvironment(), timeout: 60_000 })
    const { runId } = JSON.parse(
      initial.stdout.split("\n").find((line) => line.startsWith("{\"marker\":\"fork-started\""))!
    )
    expect(readFileSync(join(root, "executed.jsonl"), "utf8")).toBe("first\n")
    const at = read(
      "engine",
      (db) => Number(db.prepare("SELECT MAX(seq) AS seq FROM flows_journal_events WHERE run_id=?").get(runId)!.seq)
    )
    const fork = await History.mutate(root, runId, { sequence: at }, "fork")
    if (!("workspace" in fork)) throw new Error("Core fork workspace missing")
    expect(fork.workspace).toEqual(expect.any(String))
    expect(fork.runId).toEqual(expect.any(String))
    const workspace = String(fork.workspace), forkId = String(fork.runId)
    expect(readFileSync(join(workspace, ".smithers", "flows", "steps", "flow.ts"), "utf8")).toBe(source)
    // The ordinary checkout changes after fork. It must neither be evaluated
    // nor replace the descriptor approved for the retained source snapshot.
    writeFileSync(
      join(root, ".smithers", "flows", "steps", "flow.ts"),
      "throw new Error('CURRENT_CHECKOUT_MUST_NOT_LOAD')\n"
    )
    const digest = read(
      "control",
      (db) =>
        String(
          JSON.parse(String(db.prepare("SELECT card_json FROM control_plans LIMIT 1").get()!.card_json)).executionDigest
        )
    )
    const before = read(
      "engine",
      (db) =>
        db.prepare("SELECT outcome_json FROM flows_attempts WHERE run_id=? AND state='succeeded'").all(
          AgentSession.moduleExecutionId(forkId, digest)
        )
    )
    expect(before.some((row) => JSON.parse(String(row.outcome_json)) === "first")).toBe(true)
    const resumed = await run("runs", "resume", forkId)
    expect(resumed._tag).toBe("Accepted")
    // Resume's successful process exit is backed by the fork's durable settlement.
    expect(read("control", (db) =>
      JSON.parse(String(
        db.prepare("SELECT state_json FROM flows_runs WHERE run_id=?").get(forkId)!.state_json
      )))).toMatchObject({ status: "completed", executionDigest: digest })
    expect(read("engine", (db) => db.prepare("SELECT status FROM flows_runs WHERE run_id=?").get(forkId)?.status)).toBe(
      "completed"
    )
    expect(read("control", (db) => db.prepare("SELECT status FROM flows_runs WHERE run_id=?").get(runId)?.status))
      .toBe("suspended")
    const settled = await run("runs", "show", forkId)
    expect(settled.status).toBe("completed")
    expect(settled.executionDigest).toBe(digest)
    expect(readFileSync(join(workspace, "executed.jsonl"), "utf8")).toBe("finish\n")
    expect(readFileSync(join(root, "executed.jsonl"), "utf8")).toBe("first\n")
    const replay = await run("runs", "replay", forkId)
    expect(replay).toHaveProperty("position")
    expect(readFileSync(join(workspace, "executed.jsonl"), "utf8")).toBe("finish\n")
    expect((await run("runs", "show", runId)).status).toBe("parked")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 180_000)
