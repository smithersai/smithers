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

/** A recorded model whose every reply delegates and prints, never calling `ctx.done`. */
const pollingReplay = (directory: string): string => {
  const file = join(directory, "polling.jsonl")
  const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
  const cell = [
    "```cell",
    "try { await ctx.call(\"agent.delegate\", { id: \"fix-tab-read\", title: \"Fix tab.read output\", prompt: \"fix it\" }) }",
    "catch (error) { console.log(\"Still no seat\") }",
    "await ctx.call(\"tab.list\", {})",
    "```"
  ].join("\n")
  writeFileSync(
    file,
    [
      JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
      delta({ type: "text-start", id: "cell" }),
      delta({ type: "text-delta", id: "cell", text: cell }),
      delta({ type: "text-end", id: "cell" }),
      JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
    ].join("\n")
  )
  return file
}

const pollingTurn = async (delegate: (attempt: number) => unknown) => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-host-"))
  roots.push(cwd)
  const host = Host.make({ cwd, environment: {} })
  const events: Array<AgentEvent.AgentEvent> = []
  let delegations = 0
  try {
    const outcome = await host.run({
      prompt: "fix tab.read",
      role: "coordinator",
      seat: `replay:${pollingReplay(cwd)}`,
      history: [],
      runtime: { publish: () => {}, delegate: () => delegate(++delegations), read: () => ({}), list: () => [] },
      onEvent: (event) => events.push(event)
    }).done
    const answer = outcome._tag === "done" ? outcome.answer : `${outcome._tag}`
    const resolved = events.flatMap((event) => (event._tag === "resolved" ? [event.message.content] : []))
    return { answer, delegations, resolved }
  } finally {
    await host.dispose()
  }
}

/** A recorded model whose every reply delegates and completes in the same cell, before the result exists. */
const claimingReplay = (directory: string): string => {
  const file = join(directory, "claiming.jsonl")
  const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
  const cell = [
    "```cell",
    "await ctx.call(\"agent.delegate\", { id: \"design\", title: \"Estimation design\", prompt: \"design it\" })",
    "ctx.done(\"Delegated the estimation design to codex astra.\")",
    "```"
  ].join("\n")
  writeFileSync(
    file,
    [
      JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
      delta({ type: "text-start", id: "cell" }),
      delta({ type: "text-delta", id: "cell", text: cell }),
      delta({ type: "text-end", id: "cell" }),
      JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
    ].join("\n")
  )
  return file
}

describe("Host.run completion over a failed request", () => {
  const claimingTurn = async (delegate: () => unknown) => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-host-"))
    roots.push(cwd)
    const host = Host.make({ cwd, environment: {} })
    const events: Array<AgentEvent.AgentEvent> = []
    let delegations = 0
    try {
      const outcome = await host.run({
        prompt: "design estimation",
        role: "coordinator",
        seat: `replay:${claimingReplay(cwd)}`,
        history: [],
        runtime: { publish: () => {}, delegate: () => (delegations++, delegate()), read: () => ({}), list: () => [] },
        onEvent: (event) => events.push(event)
      }).done
      const answer = outcome._tag === "done" ? outcome.answer : `${outcome._tag}`
      const resolved = events.flatMap((event) => (event._tag === "resolved" ? [event.message.content] : []))
      return { answer, delegations, resolved, events }
    } finally {
      await host.dispose()
    }
  }

  test("a claim written before its delegation failed is handed back once, then answered with the failure", async () => {
    const { answer, delegations, resolved, events } = await claimingTurn(() => {
      throw new Error("Three workers are active; wait for a completion")
    })

    // The harness hands the blind claim back once; the replayed seat claims again.
    expect(events.filter((event) => event._tag === "failed-call-demanded")).toHaveLength(1)
    expect(delegations).toBe(2)
    expect(answer).toBe("Not delegated: Estimation design (Three workers are active; wait for a completion)")
    expect(answer).not.toContain("Delegated the estimation design")
    expect(resolved).toEqual([[{ type: "text", text: answer }]])
  })

  test("a delegation that was accepted keeps the coordinator's own answer", async () => {
    const { answer, delegations } = await claimingTurn(() => ({ id: "design", status: "requested" }))

    expect(delegations).toBe(1)
    expect(answer).toBe("Delegated the estimation design to codex astra.")
  })
})

describe("Host.run frame budget", () => {
  test("a coordinator that spends its frames polling a refused delegation says it was not delegated", async () => {
    const { answer, delegations, resolved } = await pollingTurn(() => {
      throw new Error("Three workers are active; wait for a completion")
    })

    expect(delegations).toBe(8)
    expect(answer).toBe(
      "Stopped after 8 frames.\nNot delegated: Fix tab.read output (Three workers are active; wait for a completion)"
    )
    // The transcript renders the resolved event, so it must carry the same words.
    expect(resolved).toEqual([[{ type: "text", text: answer }]])
  })

  test("a delegation refused once and accepted later reads as requested, not as not delegated", async () => {
    const { answer } = await pollingTurn((attempt) => {
      if (attempt === 1) throw new Error("Three workers are active")
      return { id: "fix-tab-read", status: "requested" }
    })

    expect(answer).toBe("Stopped after 8 frames.\nRequested: Fix tab.read output")
  })
})
