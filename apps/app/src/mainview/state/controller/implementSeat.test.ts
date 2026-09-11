import { describe, expect, test } from "bun:test"
import { agentRole, AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import { payloadFor } from "../../flows/SlashPayload"

/*
 * The implement seat, pinned (factory-spec review RULINGS 42, Will,
 * 2026-09-08): "Implement runs on the SMART seat always, first try included.
 * The fast seat is not the implementer. Cost control is parallelism, caching,
 * and prototype-first, never a cheaper model for the implementation itself."
 *
 * No code here picks a seat tier for a run, and this file is not where that
 * starts. Seats are declared, never inferred: a flow names its own model in
 * its `model:` frontmatter or in `AgentAction`'s `seat` option, a markdown
 * flow that names none asks for `smart`
 * (packages/smithers/flows/core/src/Markdown.ts), and the host's
 * `SeatResolver` turns that declared string into a live model.
 *
 * Two things in this app do name a model, so they are the two that could
 * quietly cheapen an implement run: the built-in role table
 * (packages/rpc/src/AgentRoles.ts), where each role binds one model, and
 * `agent.delegate`, the door the orchestrator hands a frame through. Both are
 * pinned here, so a change to a cheaper implementer fails a test rather than
 * shipping.
 */

/** The fast rows: a person's explicit pick for a mechanical edit, never an implement-shaped run's. */
const FAST_ROLE_IDS = ["trivial-implementation", "fast-ui"] as const

describe("the implement seat (RULINGS 42)", () => {
  test("the implementation role runs on the smart Codex seat, not on either fast row's model", () => {
    const implementation = agentRole("implementation")
    expect(implementation.model.id).toBe("gpt-5.6-sol")
    expect(implementation.harness).toBe("codex")

    const fastModels = FAST_ROLE_IDS.map((id) => agentRole(id).model.id)
    expect(fastModels).toEqual(["gpt-5.6-luna", "cerebras/gpt-oss-120b"])
    expect(fastModels).not.toContain(implementation.model.id)
  })

  test("the orchestrator that delegates the work is itself the smart seat, and is the only row that delegates", () => {
    const orchestrator = agentRole("orchestrator")
    expect(orchestrator.model.id).toBe("claude-fable-5")
    expect(orchestrator.delegates).toBe(true)
    expect(AGENT_ROLES.filter((role) => role.delegates).map((role) => role.id)).toEqual(["orchestrator"])
  })

  test("no fast row advertises itself as an implementer: only the smart row's purpose claims end-to-end changes", () => {
    for (const id of FAST_ROLE_IDS) {
      const purpose = agentRole(id).purpose.toLowerCase()
      expect(purpose).not.toContain("end to end")
      expect(purpose).not.toContain("non-trivial")
    }
    expect(agentRole("implementation").purpose.toLowerCase()).toContain("non-trivial")
  })

  test("agent.delegate has no default role, so an implement-shaped delegation can never fall to a fast seat by omission", () => {
    // Both halves are required: the caller names the role, and this boundary never picks one.
    expect(payloadFor("agent.delegate", "")).toHaveProperty("error")
    expect(payloadFor("agent.delegate", "implementation")).toHaveProperty("error")
    expect(payloadFor("agent.delegate", "implementation add a retry to the fetch")).toEqual({
      payload: { roleId: "implementation", task: "add a retry to the fetch" }
    })
  })
})
