/**
 * The scripted agent fakes: an environment-selected script at an absolute
 * path, the spawn log's file list, and a gate runner that runs out of reports.
 */
import * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const temporary = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-agent-fake-")))
  roots.push(root)
  return root
}

const prompt = [
  "Review these files.",
  "=== FILES ===",
  "--- src/a.ts ---",
  "export const a = 1",
  "--- src/b.ts ---",
  "export const b = 1",
  "=== DIFF SLICE ===",
  "--- src/c.ts ---",
  "+export const c = 1",
  ""
].join("\n")

describe("the scripted agent fakes", () => {
  it("lists only the FILES headers, not the diff slice's", () => {
    expect(AgentFake.promptFilesOf(prompt)).toEqual(["src/a.ts", "src/b.ts"])
    expect(AgentFake.promptFilesOf("no files section")).toEqual([])
  })

  it("loads an absolute script path as given and logs each spawn beside it", async () => {
    const scripts = await temporary()
    const workspaceRoot = await temporary()
    const script = NodePath.join(scripts, "fake.json")
    await Fs.writeFile(script, JSON.stringify({ identity: "abs-fake", responses: [{ purpose: "lint", note: "ok" }] }))
    const factory = AgentFake.sessionFactoryFromEnvironment(
      { workspaceRoot, agents: undefined },
      { [AgentFake.fakeEnvironmentVariable]: script }
    )
    const envelope = await Effect.runPromise(
      Effect.flatMap(factory.open(undefined), (session) => {
        expect(session.identity).toBe("abs-fake")
        return session.run({ purpose: "lint", prompt })
      })
    )
    expect(envelope).toEqual({ findings: [], edits: [], note: "ok" })
    const log = (await Fs.readFile(`${script}.spawns.jsonl`, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(log).toEqual([expect.objectContaining({ seq: 1, purpose: "lint", files: ["src/a.ts", "src/b.ts"] })])
    // Nothing was resolved against the workspace root.
    expect(await Fs.readdir(workspaceRoot)).toEqual([])
  })

  it("fails a gate call past the end of its script and still records the call", async () => {
    const report: ReadonlyArray<AgentTarget.GateReportEntry> = [{ gate: "//:test", status: "green" }]
    const runner = AgentFake.makeScriptedGateRunner([report])
    const overlay = {
      files: new Map<string, string | null>([["src/b.ts", "b"], ["src/a.ts", null]]),
      read: () => Promise.resolve(undefined),
      render: () => ""
    }
    expect(await Effect.runPromise(runner.run(["//:test"], overlay, 1))).toEqual(report)
    const error = await Effect.runPromise(Effect.flip(runner.run(["//:test", "//:lint"], overlay, 2)))
    expect(error).toBeInstanceOf(AgentTarget.AgentSessionError)
    expect(error.phase).toBe("gate")
    expect(error.message).toBe("the scripted gate runner is exhausted: call 2 has no scripted report (1 declared)")
    expect(runner.calls()).toEqual([
      { round: 1, gates: ["//:test"], files: ["src/a.ts", "src/b.ts"] },
      { round: 2, gates: ["//:test", "//:lint"], files: ["src/a.ts", "src/b.ts"] }
    ])
  })
})
