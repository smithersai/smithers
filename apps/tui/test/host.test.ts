import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Capability from "@smthrs/capability/Capability"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import { Effect } from "effect"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import type * as Agents from "../src/agents.ts"
import * as Approvals from "../src/approvals.ts"
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

test("Host.run lets agent.wait settle after the ordinary flow call ceiling", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-wait-"))
  roots.push(cwd)
  const host = Host.make({ cwd, environment: {}, callMs: 20, totalMs: 30 })
  let contacted = 0
  try {
    const result = await host.run({
      prompt: "wait for child", role: "worker", seat: `replay:${doneReplay(cwd,
        'const children = await ctx.call("agent.wait", { ids: ["child"] }); ctx.done(children[0].answer)')}`,
      history: [], runtime: { publish: () => {}, delegate: () => ({ id: "child", status: "requested" }),
        read: () => ({}), list: () => [], wait: async () => {
        contacted++
        await new Promise((resolve) => setTimeout(resolve, 80))
        return [{ id: "child", status: "done", answer: "late answer" }]
      } }, onEvent: () => {}
    }).done
    expect(contacted).toBeGreaterThan(0)
    expect(result).toEqual({ _tag: "done", answer: "late answer" })
  } finally { await host.dispose() }
})

test("Host.run bounds a worker frame waiting on a non-flow promise", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-stall-"))
  roots.push(cwd)
  const host = Host.make({ cwd, environment: {}, totalMs: 30 })
  try {
    const events: AgentEvent.AgentEvent[] = []
    const outcome = await host.run({ prompt: "stall", role: "worker", seat: `replay:${doneReplay(cwd,
      "await new Promise(() => {}); ctx.done('never')")}`,
      history: [], onEvent: (event) => events.push(event) }).done
    expect(events.find((event) => event._tag === "discipline-armed")).toMatchObject({ totalMs: 30 })
    expect(events.find((event) => event._tag === "cell-settled" && event.outcome._tag === "rejected"))
      .toMatchObject({ outcome: { code: "stalled" } })
    expect(outcome._tag === "done" ? outcome.answer : "").not.toContain("never")
  } finally { await host.dispose() }
})

test("Host.run clears the streamed reply when the model retries", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-retry-"))
  roots.push(cwd)
  const file = join(cwd, "retry.jsonl")
  const delta = (value: object) => JSON.stringify({ at: 0, event: { _tag: "model-delta", delta: value } })
  writeFileSync(file, [
    JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
    delta({ type: "text-delta", id: "first", text: "seat one partial" }),
    delta({ type: "retry", attempt: 1, code: "rate_limited", delayMillis: 0 }),
    delta({ type: "text-delta", id: "second", text: "fallback\n```cell\nctx.done('ok')\n```" }),
    JSON.stringify({ at: 0, event: { _tag: "model-settled", message: { stopReason: "stop" } } })
  ].join("\n"))
  const host = Host.make({ cwd, environment: {} })
  const captions: Array<string> = []
  try {
    const outcome = await host.run({ prompt: "reply", role: "coordinator", seat: `replay:${file}`,
      history: [], onEvent: () => {}, onCaption: (caption) => captions.push(caption) }).done
    expect(outcome).toEqual({ _tag: "done", answer: "ok" })
    expect(captions).toContain("fallback")
    expect(captions.join(" ")).not.toContain("seat one")
  } finally { await host.dispose() }
})

test("Host.run keeps the call ceiling on plugin flows while worker waits are exempt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-plugin-limit-"))
  roots.push(cwd)
  const host = Host.make({ cwd, environment: {}, callMs: 20 })
  let settle!: (value: AgentEvent.AgentEvent) => void
  const observed = new Promise<AgentEvent.AgentEvent>((resolve) => { settle = resolve })
  try {
    const turn = host.run({ prompt: "list", role: "worker", seat: `replay:${doneReplay(cwd,
      'await ctx.call("smithers.flows", {}); ctx.done("listed")')}`,
      history: [], runtime: { publish: () => {}, flows: {
        list: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return [] },
        run: () => ({}), inspect: () => ({})
      } }, onEvent: (event) => {
        if (event._tag === "cell-call-settled" && event.flowName === "smithers.flows") settle(event)
      }
    })
    const event = await observed
    turn.cancel()
    await turn.done
    expect(event).toMatchObject({ result: { outcome: "failure", message: expect.stringContaining("timed out") } })
  } finally { await host.dispose() }
})

test("Host.run exposes non-parked usage-limit copy for a failure card", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-limit-"))
  roots.push(cwd)
  const file = join(cwd, "limited.jsonl")
  writeFileSync(file, [
    JSON.stringify({ at: 0, event: { _tag: "model-requested" } }),
    JSON.stringify({ at: 0, event: { _tag: "replay-failure", code: "rate_limited", message: "The usage limit has been reached" } })
  ].join("\n"))
  const host = Host.make({ cwd, environment: {} })
  try {
    const outcome = await host.run({ prompt: "review", role: "coordinator", seat: `replay:${file}`,
      history: [], onEvent: () => {} }).done
    expect(outcome._tag).toBe("failed")
    const copy = FailureCopy.describe(outcome._tag === "failed" ? outcome.error : undefined, "openai:gpt-6-sol")
    expect(copy.headline).toBe("ChatGPT usage limit reached")
    expect(copy.line).not.toContain("usage limit has been reached")
  } finally { await host.dispose() }
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

describe("Host.run shell monitors pass the approval gate", () => {
  const shell = { kind: "shell", command: "tail -5 x.log" }
  const tab = { kind: "tab", id: "build" }
  const created: Array<unknown> = []
  const monitorTurn = async (
    approvals: Approvals.Mode,
    source: object,
    answer?: Approvals.Choice
  ) => {
    created.length = 0
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-monitor-"))
    roots.push(cwd)
    const host = Host.make({ cwd, environment: {}, approvals })
    const request = { id: "log", title: "Log", watch: "an error", source }
    const cell = `let r; try { r = await ctx.call("monitor.create", ${JSON.stringify(request)}) } ` +
      `catch (e) { r = { threw: String(e?.message ?? e) } } ctx.done(JSON.stringify(r))`
    try {
      const turn = host.run({
        prompt: "watch",
        role: "coordinator",
        seat: `replay:${doneReplay(cwd, cell)}`,
        history: [],
        runtime: {
          publish: () => {},
          monitors: {
            create: (input) => (created.push(input), { id: input.id, status: "active" }),
            list: () => [],
            stop: (id) => ({ id, status: "stopped" })
          }
        },
        onEvent: () => {}
      })
      let pending: ReadonlyArray<Approvals.Pending> = []
      if (answer !== undefined) {
        for (let attempt = 0; attempt < 400 && pending.length === 0; attempt++) {
          pending = await host.approvals!.pending()
          if (pending.length === 0) await Bun.sleep(10)
        }
        expect(created).toEqual([])
        await host.approvals!.reply(pending[0]!, answer)
      }
      const outcome = await turn.done
      return { outcome, pending, created: [...created] }
    } finally {
      await host.dispose()
    }
  }

  test("all creates without asking", async () => {
    const { outcome, created } = await monitorTurn("all", shell)
    expect(outcome).toEqual({ _tag: "done", answer: JSON.stringify({ id: "log", status: "active" }) })
    expect(created).toHaveLength(1)
  })

  test("ask waits for y and shows the command; n refuses", async () => {
    const yes = await monitorTurn("ask", shell, "once")
    expect(yes.pending[0]).toMatchObject({ flow: "monitor.create", subject: "tail -5 x.log", action: "proc:spawn" })
    expect(yes.created).toHaveLength(1)
    const no = await monitorTurn("ask", shell, "deny")
    expect(no.created).toEqual([])
    expect(JSON.stringify(no.outcome)).toContain("Denied: monitor.create tail -5 x.log")
  })

  test("deny refuses a shell source and still creates a tab source", async () => {
    const denied = await monitorTurn("deny", shell)
    expect(denied.created).toEqual([])
    expect(JSON.stringify(denied.outcome)).toContain("Denied: monitor.create")
    const watched = await monitorTurn("deny", tab)
    expect(watched.created).toHaveLength(1)
  })

  test("a restored shell monitor asks again under this session's mode", async () => {
    const restoredUnder = async (approvals: Approvals.Mode, answer?: Approvals.Choice) => {
      const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-monitor-"))
      roots.push(cwd)
      const host = Host.make({ cwd, environment: {}, approvals })
      try {
        const gate = Approvals.restored((requests) => host.approvals!.authorize(requests))
        const settled = gate({ source: { kind: "shell", command: "tail -5 x.log" } }).then(() => "armed", (error) => String(error))
        let pending: ReadonlyArray<Approvals.Pending> = []
        if (answer !== undefined) {
          for (let attempt = 0; attempt < 400 && pending.length === 0; attempt++) {
            pending = await host.approvals!.pending()
            if (pending.length === 0) await Bun.sleep(10)
          }
          await host.approvals!.reply(pending[0]!, answer)
        }
        return { result: await settled, pending, tab: await gate({ source: { kind: "tab", id: "t" } }).then(() => "armed") }
      } finally {
        await host.dispose()
      }
    }
    expect(await restoredUnder("all")).toMatchObject({ result: "armed", tab: "armed" })
    const denied = await restoredUnder("deny")
    expect(denied.result).toContain("Denied: monitor.create tail -5 x.log")
    expect(denied.tab).toBe("armed")
    const asked = await restoredUnder("ask", "once")
    expect(asked.pending[0]).toMatchObject({ flow: "monitor.create", subject: "tail -5 x.log" })
    expect(asked.result).toBe("armed")
    expect((await restoredUnder("ask", "deny")).result).toContain("Denied")
  })
})

describe("Host.complete", () => {
  test("sends the seat's bare model id and no token budget, which the ChatGPT route would refuse", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const chunk = (value: object) => `data: ${JSON.stringify(value)}\n\n`
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        bodies.push(await request.json() as Record<string, unknown>)
        const choice = (delta: object, finish: string | null) =>
          chunk({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })
        return new Response(`${choice({ role: "assistant", content: "{\"minutes\": 3}" }, null)}${choice({}, "stop")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" }
        })
      }
    })
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-complete-"))
    roots.push(cwd)
    const host = Host.make({
      cwd,
      environment: { OPENAI_API_KEY: "k", SMITHERS_OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${server.port}` }
    })
    try {
      expect(await host.complete!({ system: "s", prompt: "p", seat: "openai:gpt-6-luna" })).toBe("{\"minutes\": 3}")
      // A tab description goes to the worker's own seat, by its bare model id too.
      expect(await host.describe!({ title: "t", prompt: "p", seat: "openai:gpt-6-sol" })).toBe("{\"minutes\": 3}")
    } finally {
      await host.dispose()
      server.stop()
    }
    expect(bodies.map((body) => body.model)).toEqual(["gpt-6-luna", "gpt-6-sol"])
    for (const body of bodies) {
      expect(Object.keys(body).filter((key) => /max/.test(key))).toEqual([])
    }
  })
})

describe("Host.run under a provider quota refusal", () => {
  test("a worker refused for ten minutes emits a park instead of a provider failure", async () => {
    let asked = 0
    const provider = Bun.serve({
      port: 0,
      fetch: () => {
        asked += 1
        return Response.json(
          { error: { message: "Rate limit reached. Try again in 10m.", type: "rate_limit_exceeded", code: "rate_limit_exceeded" } },
          { status: 429, headers: { "retry-after": "600" } }
        )
      }
    })
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-quota-"))
    roots.push(cwd)
    const host = Host.make({
      cwd,
      environment: { OPENAI_API_KEY: "sk-test", SMITHERS_OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${provider.port}` },
      approvals: "all"
    })
    try {
      const events: AgentEvent.AgentEvent[] = []
      const turn = host.run({ prompt: "answer", role: "worker", seat: "openai:gpt-test", history: [], onEvent: (event) => events.push(event) })
      const outcome = await turn.done
      expect(events.find((event) => event._tag === "model-parked")).toMatchObject({ code: "rate_limited", seat: "openai:gpt-test" })
      expect(outcome).toMatchObject({ _tag: "cancelled" })
      expect(asked).toBe(1)
    } finally {
      await host.dispose()
      provider.stop(true)
    }
  }, 90_000)

  test("a worker with no parks left fails with the provider's typed limit", async () => {
    let asked = 0
    const provider = Bun.serve({
      port: 0,
      fetch: () => {
        asked += 1
        return Response.json(
          { error: { message: "Rate limit reached. Try again in 10m.", type: "rate_limit_exceeded", code: "rate_limit_exceeded" } },
          { status: 429, headers: { "retry-after": "600" } }
        )
      }
    })
    const cwd = mkdtempSync(join(tmpdir(), "smithers-tui-quota-"))
    roots.push(cwd)
    const host = Host.make({
      cwd,
      environment: { OPENAI_API_KEY: "sk-test", SMITHERS_OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${provider.port}` },
      approvals: "all"
    })
    try {
      const events: AgentEvent.AgentEvent[] = []
      const turn = host.run({ prompt: "answer", role: "worker", seat: "openai:gpt-test", fallbackSeats: [], maxParks: 0,
        history: [], onEvent: (event) => events.push(event) })
      const outcome = await turn.done
      expect(events.some((event) => event._tag === "model-parked")).toBe(false)
      expect(outcome._tag).toBe("failed")
      expect(FailureCopy.describe(outcome._tag === "failed" ? outcome.error : undefined, "openai:gpt-test"))
        .toMatchObject({ headline: "ChatGPT usage limit reached", fault: "wait" })
      expect(asked).toBe(1)
    } finally {
      await host.dispose()
      provider.stop(true)
    }
  }, 90_000)
})

describe("turnOptions", () => {
  const source = (name: string, flows: ReadonlyArray<string>) => ({
    name,
    bindings: () => Effect.succeed(flows.map((flow) => ({ descriptor: { name: flow } }))) as never
  })
  const standard = [source("filesystem", ["read", "write", "grep"]), source("shell", ["bash"])]
  const names = async (sources: ReadonlyArray<{ readonly bindings: () => Effect.Effect<ReadonlyArray<{ descriptor: { name: string } }>, unknown> }>) =>
    (await Promise.all(sources.map((each) => Effect.runPromise(each.bindings())))).flat().map((binding) => binding.descriptor.name)
  const base = { prompt: "go", seat: "test:worker", role: "worker" as const, history: [], onEvent: () => {} }
  const profile: Agents.Profile = {
    name: "review",
    digest: "d",
    system: "You review changes.",
    thinking: "high",
    flows: ["read", "bash"],
    envelope: ["fs:read:**"]
  }

  test("a plain worker keeps every standard flow, the wildcard envelope and the provider's effort", async () => {
    const options = Host.turnOptions(base, "/repo", standard)
    expect(await names(options.flows)).toEqual(["read", "write", "grep", "bash"])
    expect(options.capabilityEnvelope.map(String)).toEqual([String(new Capability.CapabilityPattern({ action: "*", resource: "*" }))])
    expect(options.reasoningEffort).toBeUndefined()
    expect(options.system.some((part) => part.includes("You review changes."))).toBe(false)
  })

  test("an agent profile sets the system prompt, the envelope, the flows and the effort", async () => {
    const options = Host.turnOptions({ ...base, agent: profile }, "/repo", standard)
    expect(options.system.at(-1)).toBe("You review changes.")
    // The worker teaching still applies.
    expect(options.system.some((part) => part.startsWith("Start each cell"))).toBe(true)
    expect(options.capabilityEnvelope.map((pattern) => `${pattern.action}:${pattern.resource}`)).toEqual(["fs:read:**"])
    expect(await names(options.flows)).toEqual(["read", "bash"])
    expect(options.reasoningEffort).toBe("high")
    expect(Host.turnOptions({ ...base, agent: profile, thinking: "low" }, "/repo", standard).reasoningEffort).toBe("low")
  })

  test("an agent with no declared flows or capabilities keeps the host defaults", async () => {
    const options = Host.turnOptions({ ...base, agent: { ...profile, flows: [], envelope: [] } }, "/repo", standard)
    expect(await names(options.flows)).toEqual(["read", "write", "grep", "bash"])
    expect(options.capabilityEnvelope).toHaveLength(1)
    expect(options.capabilityEnvelope[0]!.action).toBe("*")
  })
})
