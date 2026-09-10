import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import { composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import { CHAT_INSTRUCTIONS_CAP_BYTES, CODE_INTEL_LINE, INSTRUCTIONS_BUDGET_BYTES, INSTRUCTIONS_HEADROOM_BYTES, instructionStageOf, smithersInstructions } from "./Instructions"
import { WORLD_BODY_BUDGET, WORLD_BODY_PER_DOCUMENT } from "./WorldContext"

/*
 * 2026-09-02: a turn failed with "Smithers Cloud chat failed (HTTP 400):
 * instructions must be a string within the size limit" — the chat seam caps
 * instructions at 16 KiB and the live catalog had grown past it. The prompt
 * now has a budget and degrades its catalog honestly instead of failing the
 * turn. This pins the budget against the REAL registry with a repository open
 * and every local capability on, the largest prompt the app builds.
 */

const CHAT_SEAM_CAP_BYTES = 16 * 1024
const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}
const repositories: NativeRepositories = { available: true, pickLocalRepository: async () => ({ status: "cancelled" }) }
const bytes = (text: string): number => new TextEncoder().encode(text).length

const NATIVE_EVERYTHING = {
  apiVersion: 1 as const,
  host: "local" as const,
  version: "0",
  buildSha: "x",
  capabilities: ["agent", "identity", "cloud", "local.repositories", "local.repository-path-entry", "local.targets", "local.terminal", "local.harnesses", "local.lsp"] as const,
  authFlow: "both" as const,
  sandbox: null
}

/** The largest session the app builds a prompt for: a repository open, every local capability on, and whatever the test adds to the store. */
const capturedTurn = async (prepare: (store: Awaited<ReturnType<typeof createAppStore>>) => void) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "repos.loaded",
    actor: "system",
    repos: [{
      id: "r1",
      path: "/Users/will/smithers",
      name: "smithersai/smithers",
      git: { branch: "main", remote: "git@github.com:smithersai/smithers.git" },
      warnings: [],
      smithers: { detected: true, workspaceFile: "WORKSPACE.ts", declarationFiles: [], reason: "1 workspace detected", workspaces: [{ path: ".", title: "smithers" }] }
    }]
  })
  prepare(store)
  let captured: { instructions?: string; context?: AgentRuntimeContext } | undefined
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      captured = request as { instructions?: string; context?: AgentRuntimeContext }
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: () => () => {}
  }
  const controller = createAppController(store, repositories, agent, { bootstrap: { ...NATIVE_EVERYTHING, capabilities: [...NATIVE_EVERYTHING.capabilities] } })
  await controller.send("hi")
  await new Promise((resolve) => setTimeout(resolve, 50))
  const instructions = captured?.instructions ?? ""
  // What the seam actually measures is the COMPOSED string the Bun side sends: prompt plus the rendered runtime context.
  const composed = composeAgentInstructions(instructions, captured?.context)
  return { store, instructions, context: captured?.context, composed }
}

describe("the instructions budget", () => {
  test("the full live registry with a repository open fits the chat seam's cap with headroom", async () => {
    const { instructions, composed } = await capturedTurn(() => {})
    expect(instructions).toContain("What you can do is EXACTLY this")
    expect(bytes(composed)).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - 256)
    expect(CHAT_SEAM_CAP_BYTES).toBe(CHAT_INSTRUCTIONS_CAP_BYTES)
    expect(INSTRUCTIONS_BUDGET_BYTES).toBeLessThanOrEqual(CHAT_SEAM_CAP_BYTES - 2048)
    // The lane report reads the stage the live catalog lands in with an empty context.
    console.info(`instructions budget: empty-context session lands in stage ${instructionStageOf(instructions)} (${bytes(instructions)} prompt bytes, ${bytes(composed)} composed)`)
  })

  /*
   * The floor. Stage 2 had no floor: with World notes at WORLD_BODY_BUDGET
   * and the orchestrator roles present, the composed string measured 22 650
   * bytes and the seam's 400 came back as a failed turn. The World bodies
   * now give way before the cap does, each cut note saying so, and only
   * with none left does the catalog fall to stage 3.
   */
  test("a session with World notes at the body budget and roles present composes under the cap, and the notes are cut before the turn is", async () => {
    const { instructions, context, composed } = await capturedTurn((store) => {
      for (const index of [1, 2, 3]) {
        store.dispatch({
          type: "world.document.upserted",
          actor: "user",
          select: false,
          document: {
            id: `world-note-${index}`,
            path: `notes/note-${index}.md`,
            title: `Note ${index}`,
            body: Array.from({ length: 80 }, (_line, line) => `note ${index} line ${line}: a fact recorded nowhere else in the repository`).join("\n"),
            links: [],
            tags: [],
            sources: [],
            confidence: 0.9
          }
        })
      }
    })
    if (context === undefined) throw new Error("no context captured")
    expect(bytes(composed)).toBeLessThanOrEqual(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES)
    // The roles are in the prompt (the largest native prompt), and the catalog kept every command's name.
    expect(instructions).toContain("You are the ORCHESTRATOR role")
    expect(instructionStageOf(instructions)).toBeLessThanOrEqual(2)
    // Every note is still listed with its body (the head of it) and says when it was cut; none silently vanished.
    const notes = context.worldState.documents.filter((document) => document.path.startsWith("notes/"))
    expect(notes).toHaveLength(3)
    for (const note of notes) expect(note.body).toBeDefined()
    expect(notes.some((note) => note.bodyTruncated === true)).toBe(true)
    expect(notes.reduce((sum, note) => sum + (note.body?.length ?? 0), 0)).toBeGreaterThan(0)
    expect(notes.reduce((sum, note) => sum + (note.body?.length ?? 0), 0)).toBeLessThan(Math.min(WORLD_BODY_BUDGET, 3 * WORLD_BODY_PER_DOCUMENT))
    /*
     * The cut spends the room it has: a one-step cut by the overshoot used to
     * land on a zero budget with hundreds of bytes unused (and passed this
     * floor by a single line only while the catalog stayed small enough).
     * Bisection stops within a few characters, so the slack under the cap is
     * bounded by one note line plus the search's resolution.
     */
    expect(CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES - bytes(composed)).toBeLessThan(256)
    console.info(`instructions budget: World notes at budget land in stage ${instructionStageOf(instructions)} (${bytes(instructions)} prompt bytes, ${bytes(composed)} composed)`)
  })

  test("code intelligence is stated only where its flows are registered", async () => {
    const honesty = { host: "web", github: { connected: true, login: "will", repositories: 1 }, localRepositories: [], localRepositoriesAvailable: false } as const
    const catalog = [{ name: "files.read", summary: "Read a file" }]
    expect(smithersInstructions(catalog, honesty)).not.toContain("code.hover")
    expect(smithersInstructions(catalog, honesty)).toContain("code intelligence (hover, definitions, diagnostics)")
    const native = smithersInstructions([...catalog, { name: "code.hover", summary: "The type at a position" }], { ...honesty, host: "native" })
    expect(native).toContain(CODE_INTEL_LINE)
    expect(native).not.toContain("code intelligence (hover, definitions, diagnostics) and connecting Linear need the native app")
  })

  /*
   * Stage 1 — the argument grammars leave, every summary stays. Only stages
   * 0, 2 and 3 were pinned, so widening the stage-0 predicate to `stage <= 1`
   * kept every grammar in stage 1 and the suite stayed green: the oversized
   * fixture simply fell through to stage 2.
   */
  test("a catalog that fits only once the argument grammars go lands in stage 1, keeping every summary", () => {
    const honesty = { github: { connected: false, login: null, repositories: null }, localRepositories: [], localRepositoriesAvailable: true } as never
    const catalog = Array.from({ length: 40 }, (_entry, index) => ({
      name: `ns${index % 4}.command-${index}`,
      summary: `Does the ${index}th thing, in a sentence long enough to be worth keeping`,
      args: "<one> [two] [three]"
    }))
    // The two renderings the budget chooses between, measured through the public seam.
    const atStage0 = bytes(smithersInstructions(catalog, honesty, [], { lastStage: 0, budgetBytes: 0 }))
    const atStage1 = bytes(smithersInstructions(catalog, honesty, [], { lastStage: 1, budgetBytes: 0 }))
    // Dropping the grammars is what buys the room; without that, stage 1 is stage 0.
    expect(atStage0).toBeGreaterThan(atStage1)

    const text = smithersInstructions(catalog, honesty, [], { budgetBytes: atStage1 })
    expect(instructionStageOf(text)).toBe(1)
    expect(bytes(text)).toBeLessThanOrEqual(atStage1)
    // Every command keeps its name AND its summary — only the grammar left.
    for (const command of catalog) {
      expect(text).toContain(`- /${command.name} — ${command.summary}`)
    }
    expect(text).not.toContain("<one>")
    expect(text).not.toContain("[three]")
  })

  test("a catalog too large for the budget degrades in stages and never drops a command's name", () => {
    const honesty = { github: { connected: false, login: null, repositories: null }, localRepositories: [], localRepositoriesAvailable: true } as never
    const many = Array.from({ length: 400 }, (_entry, index) => ({
      name: `ns${index % 12}.command-${index}`,
      summary: `Does the ${index}th thing, at length, so that the catalog alone outgrows the budget many times over`,
      args: "<one> [two] [three]"
    }))
    const text = smithersInstructions(many, honesty, [], { lastStage: 2 })
    expect(bytes(text)).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET_BYTES + 4096)
    expect(text).toContain("Commands, by namespace")
    expect(instructionStageOf(text)).toBe(2)
    for (const command of many.slice(0, 20)) expect(text).toContain(`/${command.name}`)
    // A small catalog keeps every argument grammar.
    const small = smithersInstructions(many.slice(0, 5), honesty)
    expect(small).toContain("<one> [two] [three]")
    expect(instructionStageOf(small)).toBe(0)
    // The floor: a budget the namespace list cannot meet leaves the namespaces and their counts, every name behind the list action.
    const floor = smithersInstructions(many, honesty, [], { budgetBytes: 4096 })
    expect(instructionStageOf(floor)).toBe(3)
    expect(floor).toContain("Commands: 400, in these namespaces")
    expect(floor).toContain("ns0 (34)")
    expect(floor).not.toContain("/ns0.command-0")
    expect(bytes(floor)).toBeLessThan(bytes(text))
  })
})
