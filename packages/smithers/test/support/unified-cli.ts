/** Real unified command invocations and isolated project fixtures. */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Audience from "@smthrs/build-cli/Audience"
import { Control } from "@smthrs/control"
import { Effect, Layer } from "effect"
import type { HttpServer } from "effect/http"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { makeCli } from "../../src/Cli.ts"
import type { Runtime } from "../../src/cli/ControlBridge.ts"
import * as NodeControl from "../../src/NodeControl.ts"

export const invoke = async (args: Array<string>, overrides: Runtime = {}) => {
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  const config: Runtime = {
    environment: {},
    evaluator: ScriptedJudge.layer,
    signal: AbortSignal.timeout(30_000),
    stdout: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stdout += text
      }
    },
    stderr: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stderr += text
      }
    },
    exit: (code) => {
      result.codes.push(code)
    },
    ...overrides
  }
  const presentation = Audience.fromArguments(args, {
    env: config.environment,
    stdout: config.stdout?.isTTY,
    stderr: config.stderr?.isTTY
  })
  await makeCli({ ...config, presentation }).serve(Audience.incurArguments(args, presentation), {
    env: config.environment,
    stdout: (text) => {
      result.stdout += text
    },
    exit: (code) => {
      result.codes.push(code)
    }
  })
  return result
}

export const project = async (directory?: string) => {
  const root = directory ?? await mkdtemp(join(tmpdir(), "smthrs-unified-real-"))
  await mkdir(join(root, ".smithers/flows/echo"), { recursive: true })
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir")
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
  await writeFile(
    join(root, ".smithers/flows/echo/flow.ts"),
    `
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
import { Node } from "@smthrs/plan"
export default Flow.make("echo", {
  description: "Return the supplied input",
  capabilities: [],
  effects: [],
  payload: Schema.Struct({ message: Schema.String }),
  success: Schema.String,
  body: Node.capture({}, ({ message }) => Node.succeed(message))
})
`
  )
  return root
}

/** A real long-running action records both admission and interruption. */
export const waitingProject = async (directory?: string) => {
  const root = await project(directory)
  await mkdir(join(root, ".smithers/flows/wait"), { recursive: true })
  await writeFile(
    join(root, ".smithers/flows/wait/flow.ts"),
    `
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { appendFileSync } from "node:fs"
const Block = Action.make("wait/Block", { payload: { message: Schema.String }, success: Schema.String })
export default Flow.make("wait", {
  description: "Wait until cancelled", capabilities: [], effects: [],
  payload: { message: Schema.String }, success: Schema.String,
  body: Node.capture({ action: Block.name, implementationVersion: "wait/v1" }, (payload) => Block.call(payload))
})
export const layer = Block.toLayer(({ message }) => Effect.acquireUseRelease(
  Effect.sync(() => appendFileSync(${JSON.stringify(join(root, "wait.log"))}, message + "\\n")),
  () => Effect.never,
  () => Effect.sync(() => appendFileSync(${JSON.stringify(join(root, "wait.log"))}, "cancelled\\n"))
))
`
  )
  return root
}

/** Observers may wrap the real service; faulty tests replace only the failed operation. */
export const serverLayer = (root: string, wrap?: (control: Control.Service) => Control.Service, startsRuns = true) => {
  const host = NodeControl.layer({ root, startsRuns, evaluator: ScriptedJudge.layer })
  const service = wrap === undefined ? host : Layer.effect(Control.Control, Effect.map(Control.Control, wrap))
    .pipe(Layer.provideMerge(host))
  return NodeControl.layerServerNoopAuth({ host: "127.0.0.1", port: 0 }).pipe(Layer.provideMerge(service))
}

export const remoteAddress = (server: HttpServer.HttpServer["Service"]) => {
  if (server.address._tag !== "InetAddressV4") throw new Error("Expected TCP server")
  return `http://127.0.0.1:${server.address.port}`
}

export const editStore = (root: string, kind: "control" | "engine", body: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(join(root, ".flows", `${kind}.db`))
  try {
    body(db)
  } finally {
    db.close()
  }
}

/** Populate journal fixtures through the same persisted event shape the real reader consumes. */
export const recordEvents = (root: string, runId: string, payloads: ReadonlyArray<unknown>, kind = "control.test") => {
  const sequences: Array<number> = []
  editStore(root, "control", (db) => {
    const row = db.prepare("SELECT MAX(seq) AS seq FROM flows_journal_events WHERE run_id = ?").get(runId) as {
      seq: number | null
    }
    const start = (row.seq ?? 0) + 1
    const insert = db.prepare(
      "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES(?,?,?,?,?,?,?,?,'null')"
    )
    db.exec("BEGIN")
    for (const [index, payload] of payloads.entries()) {
      const seq = start + index
      sequences.push(seq)
      insert.run(runId, seq, `fixture:${runId}:${seq}`, `fixture:${runId}`, seq, seq, kind, JSON.stringify(payload))
    }
    db.exec("COMMIT")
  })
  return sequences
}
