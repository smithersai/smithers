import { describe, expect, it } from "vitest"
import * as AgentTarget from "../src/AgentTarget.ts"
import * as Filegroup from "../src/Filegroup.vibe"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

const context: Target.ImplementationContext = {
  sourceFile: "/workspace/src/PACKAGE.ts",
  packageDirectory: "/workspace/src"
}

const gate = Filegroup.Filegroup({ srcs: [Input.glob("src/**/*.ts")] })
const otherGate = Filegroup.Filegroup({ srcs: [Input.glob("test/**/*.ts")] })

describe("workspace agent declarations", () => {
  it("declares engines and pools and validates pool members", () => {
    const agents = AgentTarget.Agents({
      default: AgentTarget.ClaudeCode({ model: "claude-fable-5" }),
      luna: AgentTarget.Codex({ model: "luna" }),
      reviewPool: AgentTarget.Pool(["luna", "default"])
    })
    expect(AgentTarget.isAgentsDeclaration(agents)).toBe(true)
    expect(Object.keys(agents.agents)).toEqual(["default", "luna", "reviewPool"])
    expect(agents.agents["reviewPool"]).toMatchObject({ _tag: "AgentPool", agents: ["luna", "default"] })
    expect(Object.isFrozen(agents.agents)).toBe(true)
  })

  it("refuses illegal names, unknown pool members, and junk entries", () => {
    const claude = AgentTarget.ClaudeCode({ model: "m" })
    expect(() => AgentTarget.Agents({ "bad name": claude })).toThrow(/legal reference name/)
    expect(() => AgentTarget.Agents({ default: AgentTarget.Pool(["ghost"]) })).toThrow(
      /not a declared agent name/
    )
    expect(() => AgentTarget.Agents({ default: { model: "m" } as never })).toThrow(
      /not an agent declaration/
    )
    expect(() => AgentTarget.Pool([])).toThrow(/non-empty/)
  })

  it("mints inert agent references by property access", () => {
    const ref = AgentTarget.Agents["luna"]
    expect(ref).toEqual({ _tag: "AgentRef", name: "luna" })
    expect(Object.isFrozen(ref)).toBe(true)
  })

  it("rejects malformed declaration tables and model names", () => {
    expect(AgentTarget.isAgentsDeclaration(null)).toBe(false)
    expect(AgentTarget.isAgentsDeclaration({})).toBe(false)
    expect(() => AgentTarget.Agents(null as never)).toThrow("Agents requires a name-to-agent record")
    expect(() => AgentTarget.ClaudeCode({ model: "" })).toThrow("Agent.ClaudeCode requires a model name")
    expect(() => AgentTarget.Codex(null as never)).toThrow("Agent.Codex requires a model name")
  })
})

describe("gitDiff collection", () => {
  it("collects declarations in order, descending nested arrays and skipping other members", () => {
    const one = Input.gitDiff({ base: "HEAD", paths: ["src/**"] })
    const two = Input.gitDiff({ base: "origin/main", addedLines: "TODO" })
    const collected = AgentTarget.collectGitDiffs([
      Input.glob("src/**/*.ts"),
      one,
      [Input.file("a.ts"), two]
    ])
    expect(collected).toEqual([one, two])
  })
})

describe("target identity", () => {
  it("distinguishes two instances of one definition by attrs and stays stable", () => {
    const left = AgentTarget.targetIdentity(gate)
    const right = AgentTarget.targetIdentity(otherGate)
    expect(left).toMatch(/^Filegroup#[0-9a-f]{64}$/)
    expect(left).not.toBe(right)
    expect(AgentTarget.targetIdentity(gate)).toBe(left)
  })
})

describe("Agent.Lint", () => {
  it("constructs a lint-kind target whose payload carries the declared slice", () => {
    const diff = Input.gitDiff({ base: "HEAD", paths: ["src/**"] })
    const target = AgentTarget.Lint({
      prompt: Input.file("prompts/review.md"),
      data: [diff],
      fixes: ["src/**"]
    })
    expect(Target.isTarget(target)).toBe(true)
    expect(Target.metadata(target).target).toBe("Agent.Lint")
    expect(Target.metadata(target).kinds).toEqual(["lint"])
    const payload = AgentTarget.lintPayload(
      {
        prompt: Input.file("prompts/review.md"),
        data: [diff],
        fixes: ["src/**"]
      },
      context
    )
    expect(payload).toEqual({
      promptPath: "prompts/review.md",
      packageDirectory: "/workspace/src",
      diffs: [diff],
      fixes: ["src/**"],
      mode: "check"
    })
  })
})

describe("Agent.Diff", () => {
  it("projects payload spec, MCP servers, write-set, and gate identities", () => {
    const attrs = {
      agent: AgentTarget.Agents["luna"],
      prompt: Input.file("//prompts/task.md"),
      payload: { ticket: Input.String("the ticket id") },
      mcp: [],
      data: [],
      changes: ["src/**"],
      gates: [gate, otherGate],
      maxRounds: 4
    }
    const payload = AgentTarget.diffPayload(attrs, context)
    expect(payload.agent).toEqual({ _tag: "AgentRef", name: "luna" })
    expect(payload.promptPath).toBe("//prompts/task.md")
    expect(payload.payloadSpec).toEqual({ ticket: Input.String("the ticket id") })
    expect(payload.changes).toEqual(["src/**"])
    expect(payload.maxRounds).toBe(4)
    expect(payload.gateIdentities).toEqual([
      AgentTarget.targetIdentity(gate),
      AgentTarget.targetIdentity(otherGate)
    ])
    const target = AgentTarget.Diff(attrs)
    expect(Target.metadata(target).target).toBe("Agent.Diff")
    expect(Target.metadata(target).kinds).toEqual(["run"])
  })

  it("plans the sealed diff action with default optional surfaces", () => {
    const target = AgentTarget.Diff({
      prompt: Input.file("prompts/task.md"),
      data: [],
      changes: ["src/**"],
      gates: [],
      maxRounds: 2
    })
    const call = plannedCalls(target)[0]

    expect(call?.action).toBe("smithers-build/agent-diff")
    expect(call?.payload).toMatchObject({
      promptPath: "prompts/task.md",
      payloadSpec: {},
      mcp: [],
      diffs: [],
      changes: ["src/**"],
      gateIdentities: [],
      maxRounds: 2
    })
    expect(call?.payload).not.toHaveProperty("agent")
  })

  it("refuses a fractional round count the sealed payload could not carry", () => {
    const attrs = {
      prompt: Input.file("prompts/task.md"),
      data: [],
      changes: ["src/**"],
      gates: [],
      maxRounds: 1.5
    }
    expect(() => AgentTarget.Diff(attrs)).toThrow()
    expect(() => AgentTarget.Diff({ ...attrs, maxRounds: 2 })).not.toThrow()
    expect(AgentTarget.diffPayload({ ...attrs, maxRounds: 2 }, context).maxRounds).toBe(2)
  })
})

describe("Agent.Pr", () => {
  it("defaults maxRounds and declares no payload or MCP surface", () => {
    const attrs = {
      agent: AgentTarget.Agents["luna"],
      prompt: Input.file("prompts/pr.md"),
      data: [],
      changes: ["src/**"],
      gates: [gate]
    }
    const payload = AgentTarget.prPayload(attrs, context)
    expect(payload.agent).toEqual(AgentTarget.Agents["luna"])
    expect(payload.maxRounds).toBe(AgentTarget.defaultPrRounds)
    expect(payload.payloadSpec).toEqual({})
    expect(payload.mcp).toEqual([])
    expect(payload.gateIdentities).toEqual([AgentTarget.targetIdentity(gate)])
    const target = AgentTarget.Pr(attrs)
    expect(Target.metadata(target).target).toBe("Agent.Pr")
    expect(Target.metadata(target).kinds).toEqual(["run"])
  })

  it("projects the same payload and MCP surface as Agent.Diff", () => {
    const attrs = {
      prompt: Input.file("prompts/pr.md"),
      payload: { ticket: Input.String("ticket") },
      mcp: [],
      data: [],
      changes: ["src/**"],
      gates: [gate]
    }
    const payload = AgentTarget.prPayload(attrs, context)
    expect(payload.payloadSpec).toEqual(attrs.payload)
    expect(payload.mcp).toEqual([])
    expect(Target.metadata(AgentTarget.Pr(attrs)).attrs).toMatchObject({ payload: attrs.payload, mcp: [] })
  })

  it("plans the sealed pull-request action with the default round limit", () => {
    const target = AgentTarget.Pr({
      prompt: Input.file("prompts/pr.md"),
      data: [],
      changes: ["src/**"],
      gates: []
    })
    const call = plannedCalls(target)[0]

    expect(call?.action).toBe("smithers-build/agent-pr")
    expect(call?.payload).toMatchObject({
      promptPath: "prompts/pr.md",
      payloadSpec: {},
      mcp: [],
      diffs: [],
      changes: ["src/**"],
      gateIdentities: [],
      maxRounds: AgentTarget.defaultPrRounds
    })
  })

  it("refuses a fractional round count and leaves an integer untouched", () => {
    const attrs = {
      prompt: Input.file("prompts/pr.md"),
      data: [],
      changes: ["src/**"],
      gates: [],
      maxRounds: 1.5
    }
    expect(() => AgentTarget.Pr(attrs)).toThrow()
    expect(() => AgentTarget.Pr({ ...attrs, maxRounds: 4 })).not.toThrow()
    expect(AgentTarget.prPayload({ ...attrs, maxRounds: 4 }, context).maxRounds).toBe(4)
  })
})
