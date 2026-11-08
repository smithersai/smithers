import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Option } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as Changes from "../src/changes.vibe"
import type * as Host from "../src/host.vibe"
import * as Session from "../src/session.ts"

/** Persisted worker receipts, with no executed tools, repository or provider. */
export const fixture = (root: string) => {
  const cwd = join(root, "workspace")
  mkdirSync(cwd)
  const saved = Session.create(cwd)
  saved.append({ type: "user", at: 1, text: "Review both files" })
  for (const id of ["alpha", "beta"]) {
    const writer = Session.create(cwd)
    const path = `${id}.ts`
    const before = "old\n".repeat(60)
    const after = "new\n".repeat(60)
    writeFileSync(join(cwd, path), after)
    const cell = Cell.source(`await ctx.call("edit", { path: "${path}" })`)
    const identity = new Cell.CallIdentity({
      session: id,
      frame: 0,
      cell: cell.digest,
      ordinal: 0,
      declaration: "edit",
      layers: []
    })
    writer.append({
      type: "event",
      at: 2,
      event: new AgentEvent.CellProduced({
        eventType: "flows.harness.cell-produced.v1",
        cell
      })
    })
    writer.append({
      type: "event",
      at: 3,
      event: new AgentEvent.CellCallStarted({
        eventType: "flows.harness.cell-call-started.v1",
        call: new Cell.Call({
          flowName: "edit",
          input: { path },
          identity,
          capabilities: [],
          placement: Option.none(),
          effects: { reads: [], writes: [path], tier: "compensable", mode: "expected", onConflict: "serialize" }
        })
      })
    })
    writer.append({
      type: "patch",
      receipt: { call: Changes.identity(identity), patches: [Changes.patch(path, before, after)!] }
    })
    writer.append({
      type: "event",
      at: 4,
      event: new AgentEvent.CellCallSettled({
        eventType: "flows.harness.cell-call-settled.v1",
        flowName: "edit",
        identity,
        result: Cell.CallResult.new({ outcome: "success", value: "Changed" })
      })
    })
    writer.append({
      type: "event",
      at: 5,
      event: new AgentEvent.Resolved({
        eventType: "flows.harness.resolved.v1",
        message: ModelRequest.Message.assistant("Changed")
      })
    })
    saved.append({
      type: "tab",
      tab: {
        id,
        depth: 0,
        title: `Review ${id}`,
        prompt: `Review ${path}`,
        seat: "replay:fixture",
        file: writer.file,
        status: "done",
        startedAt: 2,
        endedAt: 5,
        answer: "Changed"
      }
    })
  }
  saved.append({ type: "outcome", at: 6, prompt: "Review both files", outcome: { _tag: "done", answer: "Reviewed" } })
  const prompts: Array<string> = []
  const turns: Array<ReturnType<typeof Promise.withResolvers<Host.Outcome>>> = []
  const host: Host.Host = {
    cwd,
    judged: false,
    dispose: async () => {},
    run: (input) => {
      prompts.push(input.prompt)
      const turn = Promise.withResolvers<Host.Outcome>()
      turns.push(turn)
      return { done: turn.promise, cancel: () => turn.resolve({ _tag: "cancelled" }) }
    }
  }
  return { cwd, saved, host, prompts, turns }
}
