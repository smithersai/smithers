import { describe, expect, test } from "vitest"
import {
  AGENT_ROLE_IDS,
  AGENT_ROLES,
  agentRole,
  AgentRoleSchema,
  agentRoleTitle,
  CLOUD_AGENT_ROLE_IDS,
  CLOUD_AGENT_ROLES,
  cloudRole,
  cloudRoleModelId,
  CloudRoleSchema,
  findAgentRole,
  isAgentRoleId,
  isBuiltinAgentRoleId,
  isCloudRoleId,
  roleLaunchArgv
} from "../src/AgentRoles.ts"
import type { AgentRole } from "../src/AgentRoles.ts"
import { HARNESS_IDS } from "../src/LocalApp.ts"

const CLAUDE = { binary: "claude", flag: ["--model"] }
const CODEX = { binary: "codex", flag: ["-m"] }
const OPENCODE = { binary: "opencode", flag: ["--model"] }

const custom = {
  id: "reviewer",
  label: "Reviewer",
  purpose: "Reviews diffs for correctness and tests.",
  model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  harness: "codex",
  delegates: false,
  builtin: false,
  createdAt: 10,
  updatedAt: 10
} satisfies AgentRole

describe("the agent role registry", () => {
  test("seeds every built-in once, bound to a real harness and the verified model id, and stores no argv", () => {
    expect(AGENT_ROLES.map((role) => role.id)).toEqual([...AGENT_ROLE_IDS])
    for (const role of AGENT_ROLES) {
      expect(HARNESS_IDS).toContain(role.harness)
      expect(role.purpose.length).toBeGreaterThan(10)
      expect(role.builtin).toBe(true)
      expect(AgentRoleSchema.safeParse(role).success).toBe(true)
      expect("launch" in role).toBe(false)
    }
    expect(agentRole("orchestrator")).toMatchObject({
      model: { id: "claude-fable-5" },
      harness: "claude",
      delegates: true
    })
    expect(agentRole("explainer")).toMatchObject({
      model: { id: "kimi-for-coding/k3", provider: "kimi-for-coding" },
      harness: "opencode-kimi"
    })
    expect(agentRole("implementation")).toMatchObject({ model: { id: "gpt-5.6-sol" }, harness: "codex" })
    expect(agentRole("trivial-implementation")).toMatchObject({ model: { id: "gpt-5.6-luna" }, harness: "codex" })
    expect(agentRole("ui")).toMatchObject({ harness: "opencode-kimi", model: { id: "kimi-for-coding/k3" } })
    expect(agentRole("fast-ui")).toMatchObject({ harness: "opencode-cerebras", model: { id: "cerebras/gpt-oss-120b" } })
    expect(AGENT_ROLES.filter((role) => role.delegates).map((role) => role.id)).toEqual(["orchestrator"])
  })

  test("titles pair the role with its model; a well-formed id is recognised whether or not a row exists", () => {
    expect(agentRoleTitle(agentRole("explainer"))).toBe("Explainer · Kimi K3")
    expect(isAgentRoleId("fast-ui")).toBe(true)
    expect(isAgentRoleId("reviewer")).toBe(true)
    expect(isAgentRoleId("claude")).toBe(true)
    expect(isBuiltinAgentRoleId("fast-ui")).toBe(true)
    expect(isBuiltinAgentRoleId("reviewer")).toBe(false)
    expect(findAgentRole("reviewer")).toBeUndefined()
    expect(findAgentRole("reviewer", [...AGENT_ROLES, custom])?.label).toBe("Reviewer")
  })

  test("the launch argv is composed per harness: binary, model flag, model id, then the task as the first prompt", () => {
    expect(roleLaunchArgv(agentRole("orchestrator"), CLAUDE)).toEqual(["claude", "--model", "claude-fable-5"])
    expect(roleLaunchArgv(agentRole("orchestrator"), CLAUDE, " plan it ")).toEqual([
      "claude",
      "--model",
      "claude-fable-5",
      "--",
      "plan it"
    ])
    expect(roleLaunchArgv(agentRole("implementation"), CODEX, "add a retry")).toEqual([
      "codex",
      "-m",
      "gpt-5.6-sol",
      "--",
      "add a retry"
    ])
    expect(roleLaunchArgv(custom, CODEX)).toEqual(["codex", "-m", "gpt-5.6-terra"])
    expect(roleLaunchArgv(agentRole("explainer"), OPENCODE)).toEqual(["opencode", "--model", "kimi-for-coding/k3"])
    expect(roleLaunchArgv(agentRole("explainer"), OPENCODE, "why did this fail")).toEqual([
      "opencode",
      "run",
      "-m",
      "kimi-for-coding/k3",
      "--",
      "why did this fail"
    ])
    expect(roleLaunchArgv(agentRole("ui"), OPENCODE, "   ")).toEqual(["opencode", "--model", "kimi-for-coding/k3"])
  })

  test("renderer input never reaches argv verbatim: a model id that is a flag is refused at composition", () => {
    expect(() => roleLaunchArgv({ model: { ...custom.model, id: "--yolo" } }, CODEX)).toThrow(/not a model id/)
    expect(() => roleLaunchArgv({ model: { ...custom.model, id: "gpt -m evil" } }, CODEX)).toThrow(/not a model id/)
  })

  describe.each([
    { role: agentRole("orchestrator"), harness: CLAUDE, base: ["claude", "--model", "claude-fable-5"] },
    { role: custom, harness: CODEX, base: ["codex", "-m", "gpt-5.6-terra"] },
    { role: agentRole("explainer"), harness: OPENCODE, base: ["opencode", "run", "-m", "kimi-for-coding/k3"] }
  ])("delegated tasks for $harness.binary", ({ role, harness, base }) => {
    test.each([
      "--dangerously-skip-permissions",
      "--permission-mode=bypassPermissions",
      "--sandbox=danger-full-access",
      "--model=other",
      "--help",
      "--share",
      "-p",
      "--",
      " \t\n--model=other ",
      "--dangerously-skip-permissions do it"
    ])("refuses a flag-shaped task: %j", (task) => {
      expect(() => roleLaunchArgv(role, harness, task)).toThrow(
        new Error("Refusing to launch: a task must not start with a dash.")
      )
    })

    test.each(["plan the next change", " \tplan the next change\n", "explain --model=other and --help"])(
      "terminates options before the trimmed prompt: %j",
      (task) => {
        expect(roleLaunchArgv(role, harness, task)).toEqual([...base, "--", task.trim()])
      }
    )

    test.each([undefined, "", " \t\n"])("omits the prompt and terminator for an empty task: %j", (task) => {
      expect(roleLaunchArgv(role, harness, task)).toEqual([harness.binary, ...harness.flag, role.model.id])
    })
  })
})

describe("the cloud roles", () => {
  test("librarian and flows are served on Cerebras, carry no harness, and never join the agents store's built-ins", () => {
    expect(CLOUD_AGENT_ROLES.map((role) => role.id)).toEqual([...CLOUD_AGENT_ROLE_IDS])
    for (const role of CLOUD_AGENT_ROLES) {
      expect(CloudRoleSchema.safeParse(role).success).toBe(true)
      expect(role.seat).toBe("cloud")
      expect(role.model.provider).toBe("cerebras")
      expect(role.purpose.length).toBeGreaterThan(10)
      expect("harness" in role).toBe(false)
      expect(isBuiltinAgentRoleId(role.id)).toBe(false)
      expect(AgentRoleSchema.safeParse(role).success).toBe(false)
    }
    expect(cloudRole("librarian")).toMatchObject({
      model: { id: "gpt-oss-120b" },
      modelEnv: "CEREBRAS_MODEL_LIBRARIAN"
    })
    expect(cloudRole("flows")).toMatchObject({ model: { id: "qwen-3.8-27b" }, modelEnv: "CEREBRAS_MODEL_FLOWS" })
    expect(isCloudRoleId("librarian")).toBe(true)
    expect(isCloudRoleId("explainer")).toBe(false)
    expect(isCloudRoleId("")).toBe(false)
  })

  test("the served model is the env override when it is a model id, else the table default", () => {
    const librarian = cloudRole("librarian")
    expect(cloudRoleModelId(librarian, {})).toBe("gpt-oss-120b")
    expect(cloudRoleModelId(librarian, { CEREBRAS_MODEL_LIBRARIAN: " gemma-4-31b " })).toBe("gemma-4-31b")
    expect(cloudRoleModelId(librarian, { CEREBRAS_MODEL_FLOWS: "gemma-4-31b" })).toBe("gpt-oss-120b")
    expect(cloudRoleModelId(librarian, { CEREBRAS_MODEL_LIBRARIAN: "" })).toBe("gpt-oss-120b")
    // A flag-shaped override is ignored, exactly as roleLaunchArgv refuses one.
    expect(cloudRoleModelId(librarian, { CEREBRAS_MODEL_LIBRARIAN: "--model evil" })).toBe("gpt-oss-120b")
  })
})
