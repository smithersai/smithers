import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Host from "../src/host.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A recorded model that answers once with `cell` (default `ctx.done("ok")`). */
const doneReplay = (directory: string, cell = "ctx.done(\"ok\")"): string => {
  const file = join(directory, "done.jsonl")
  const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
  writeFileSync(
    file,
    [
      JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
      delta({ type: "text-start", id: "cell" }),
      delta({ type: "text-delta", id: "cell", text: `\`\`\`cell\n${cell}\n\`\`\`` }),
      delta({ type: "text-end", id: "cell" }),
      JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
    ].join("\n")
  )
  return file
}

const turn = async (role: "coordinator" | "worker") => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-host-"))
  roots.push(cwd)
  writeFileSync(join(cwd, "a.ts"), "export {}\n")
  const host = Host.make({ cwd, environment: {} })
  const events: Array<AgentEvent.AgentEvent> = []
  try {
    const outcome = await host.run({
      prompt: "answer",
      role,
      seat: `replay:${doneReplay(cwd)}`,
      history: [],
      onEvent: (event) => events.push(event)
    }).done
    return { outcome, events }
  } finally {
    await host.dispose()
  }
}

const basis = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
  events.flatMap((event) => (event._tag === "mutation-observed" ? [event.basis] : []))

describe("Host.run workspace observation", () => {
  test("a coordinator turn measures no tree: it has no flow that can move one", async () => {
    const { outcome, events } = await turn("coordinator")

    expect(outcome).toEqual({ _tag: "done", answer: "ok" })
    expect(basis(events)).toEqual(["declared"])
  })

  test("a worker turn still measures the tree its flows edit", async () => {
    const { outcome, events } = await turn("worker")

    expect(outcome).toEqual({ _tag: "done", answer: "ok" })
    expect(basis(events).length).toBeGreaterThan(0)
    expect(new Set(basis(events))).toEqual(new Set(["observed"]))
  })
})

describe("Host.run Smithers plugin", () => {
  const run = async (role: "coordinator" | "worker", cell: string, runtime: NonNullable<Host.TurnInput["runtime"]>) => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-plugin-"))
    roots.push(cwd)
    const host = Host.make({ cwd, environment: {} })
    try {
      return await host.run({ prompt: "go", role, runtime, seat: `replay:${doneReplay(cwd, cell)}`, history: [], onEvent: () => {} })
        .done
    } finally {
      await host.dispose()
    }
  }

  test("a coordinator cell lists, runs and inspects flows through ctx.call on the host's ports", async () => {
    const requests: Array<unknown> = []
    const outcome = await run(
      "coordinator",
      `const g = await ctx.call("smithers.guide", { topic: "cli" }); const f = await ctx.call("smithers.flows", {}); const r = await ctx.call("smithers.run", { id: "r1", flow: "review" }); const i = await ctx.call("smithers.inspect", { id: "r1" }); ctx.done(JSON.stringify({ cli: g.cli.length, f, r, i }))`,
      {
        publish: () => {},
        flows: {
          list: () => [{ name: "review", description: "Review" }],
          run: (request) => (requests.push(request), { id: request.id, status: "requested" }),
          inspect: (id) => ({ id, status: "running" })
        }
      }
    )
    expect(outcome._tag).toBe("done")
    expect(JSON.parse((outcome as { answer: string }).answer)).toEqual({
      cli: 16,
      f: [{ name: "review", description: "Review" }],
      r: { id: "r1", status: "requested" },
      i: { id: "r1", status: "running" }
    })
    expect(requests).toEqual([{ id: "r1", flow: "review" }])
  })

  test("a worker cell reaches smithers.guide", async () => {
    const outcome = await run(
      "worker",
      `const g = await ctx.call("smithers.guide", {}); ctx.done(Object.keys(g).join(","))`,
      { publish: () => {} }
    )
    expect(outcome).toEqual({ _tag: "done", answer: "packages,cli,authoring" })
  })
})
