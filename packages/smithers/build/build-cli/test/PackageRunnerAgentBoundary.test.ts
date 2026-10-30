import * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as Exec from "@smthrs/targets/Exec"
import { Context, Effect } from "effect"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { runnerFixture as fixture } from "./helpers/PackageRunnerFixture.ts"
import { write } from "./helpers/WriteFile.ts"

const diffTarget = (data = "[]", gates = "[]", changes = "[\"//out/**\"]") => `
const gate = S.Shell.Test({ shell: "true" })
const command = S.Agent.Diff({ prompt: S.file("//prompt.md"), data: ${data}, changes: ${changes}, gates: ${gates}, maxRounds: 1 })
export const Package = S.Package({ targets: { gate, command } })`

describe("agent verdict publication failures", () => {
  it.each(["throws", "rejects"] as const)(
    "handles a verdict write that %s through the cache service",
    async (fault) => {
      const { root, options, plan } = await fixture(diffTarget(), { "prompt.md": "Produce one file." })
      const scripted = AgentFake.makeScriptedSessionFactory({
        responses: [{ findings: [], edits: [{ path: "out/value.txt", contents: "candidate" }] }]
      })
      let writes = 0
      const notes: Array<string> = []
      const result = await Effect.runPromise(
        executeEffect(plan, { ...options, log: (line) => notes.push(line) }).pipe(
          Effect.provideService(ExecutionServices, {
            ...executionServicesLive,
            sessions: () => scripted,
            cache: (settings) =>
              executionServicesLive.cache(settings).pipe(Effect.map((store) => ({
                ...store,
                put: (...args: Parameters<typeof store.put>) => {
                  const [key, entry, settings] = args
                  if (!key.startsWith("agent-verdict-")) return store.put(key, entry, settings)
                  writes++
                  if (fault === "throws") throw new Error("verdict write unavailable")
                  return Effect.runPromise(Effect.fail(new Error("verdict write unavailable")))
                }
              })))
          })
        )
      )
      expect(writes).toBe(1)
      expect(scripted.spawns()).toBe(1)
      expect(result.ok).toBe(fault === "rejects")
      if (fault === "rejects") {
        expect(notes.join("\n")).toContain(
          "could not store the //:command verdict in the cache: verdict write unavailable"
        )
        expect(await Fs.readFile(Path.join(root, "out/value.txt"), "utf8")).toBe("candidate")
      } else {
        expect(result.results[0]?.error).toBe("verdict write unavailable")
        await expect(Fs.stat(Path.join(root, "out/value.txt"))).rejects.toMatchObject({ code: "ENOENT" })
      }
    }
  )

  it("retries an accepted cached candidate after a failed final application", async () => {
    const { root, options, plan } = await fixture(diffTarget(), { "prompt.md": "Produce one file." })
    const scripted = AgentFake.makeScriptedSessionFactory({
      responses: [{ findings: [], edits: [{ path: "out/value.txt", contents: "candidate" }] }]
    })
    const services = {
      ...executionServicesLive,
      sessions: () => scripted,
      cache: (settings: Parameters<typeof executionServicesLive.cache>[0]) =>
        executionServicesLive.cache(settings).pipe(Effect.map((store) => ({
          ...store,
          put: async (...args: Parameters<typeof store.put>) => {
            await store.put(...args)
            if (args[0].startsWith("agent-verdict-")) {
              await Fs.writeFile(Path.join(root, "out"), "publication unavailable")
            }
          }
        })))
    }
    const failed = await Effect.runPromise(
      executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, services))
    )
    expect(failed.ok).toBe(false)
    expect(failed.results[0]?.error).toContain("out")
    expect(await Fs.readFile(Path.join(root, "out"), "utf8")).toBe("publication unavailable")
    await Fs.unlink(Path.join(root, "out"))
    const resumed = await Effect.runPromise(
      executeEffect(plan, options).pipe(
        Effect.provideService(ExecutionServices, { ...executionServicesLive, sessions: () => scripted })
      )
    )
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true)
    expect(resumed.results[0]?.status).toBe("hit")
    expect(scripted.spawns()).toBe(1)
    expect(await Fs.readFile(Path.join(root, "out/value.txt"), "utf8")).toBe("candidate")
  })
})

describe("candidate gate boundaries", () => {
  it("bounds a failing gate's diagnostic and retains the exact candidate", async () => {
    const { root, options, plan } = await fixture(diffTarget("[]", "[gate]"), { "prompt.md": "Produce one file." })
    const scripted = AgentFake.makeScriptedSessionFactory({
      responses: [{ findings: [], edits: [{ path: "out/value.txt", contents: "candidate" }] }]
    })
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        sessions: () => scripted,
        exec: (_settings, payload) =>
          Effect.fail(
            Exec.ExecError.make({
              _tag: "smithers-build/ExecError",
              argv: payload.argv,
              cwd: payload.cwd,
              code: "exit_status",
              exitCode: 71,
              stdout: "",
              stderr: "detail".repeat(20_000)
            })
          )
      }))
    )
    expect(result.ok).toBe(false)
    const report = JSON.parse(await Fs.readFile(Path.join(root, ".flows/artifacts/command/gate-report.json"), "utf8"))
    expect(report).toMatchObject([{ gate: "//:gate", status: "red" }])
    expect(report[0].detail).toHaveLength(AgentTarget.maximumGateDetail)
    expect(report[0].detail.endsWith("...")).toBe(true)
    expect(await Fs.readFile(Path.join(root, ".flows/artifacts/command/candidate.diff"), "utf8")).toContain("candidate")
    await expect(Fs.stat(Path.join(root, "out/value.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not invoke an agent for an empty declared diff slice", async () => {
    const { options, plan } = await fixture(diffTarget("[S.gitDiff({ base: \"HEAD\", paths: [\"src/**\"] })]"), {
      "prompt.md": "Produce one file.",
      "src/input.ts": "export const value = 1\n"
    })
    const scripted = AgentFake.makeScriptedSessionFactory({ responses: [] })
    const notes: Array<string> = []
    const result = await Effect.runPromise(
      executeEffect(plan, { ...options, log: (line) => notes.push(line) }).pipe(
        Effect.provideService(ExecutionServices, { ...executionServicesLive, sessions: () => scripted })
      )
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(scripted.spawns()).toBe(0)
    expect(notes.join("\n")).toContain("vacuous: declared diff slice is empty, agent not invoked")
  })
})

describe("advisory findings", () => {
  it("bounds informational findings while keeping the real lint verdict cacheable", async () => {
    const { root, options } = await fixture(
      `
const command = S.Agent.Lint({ prompt: S.file("//prompt.md"), data: [S.gitDiff({ base: "HEAD", paths: ["src/**"] })], fixes: ["src/**"] })
export const Package = S.Package({ targets: { command } })`,
      { "prompt.md": "Review the change.", "src/input.ts": "export const value = 1\n" }
    )
    await write(root, "src/input.ts", "export const value = 2\n")
    const plan = await PackageExec.plan(options)
    const scripted = AgentFake.makeScriptedSessionFactory({
      responses: [{
        edits: [],
        findings: Array.from(
          { length: 21 },
          (_, i) => ({ file: "src/input.ts", line: 1, severity: "info" as const, message: `advisory-${i}` })
        )
      }]
    })
    const notes: Array<string> = []
    const run = () =>
      Effect.runPromise(
        executeEffect(plan, { ...options, log: (line) => notes.push(line) }).pipe(
          Effect.provideService(ExecutionServices, { ...executionServicesLive, sessions: () => scripted })
        )
      )
    const first = await run()
    expect(first.ok, JSON.stringify(first)).toBe(true)
    expect(notes.join("\n")).toContain("21 info finding(s)")
    expect(notes.join("\n")).toContain("(+1 more)")
    expect(notes.join("\n")).toContain("advisory-19")
    expect(notes.join("\n")).not.toContain("advisory-20")
    expect((await run()).results[0]?.status).toBe("hit")
    expect(scripted.spawns()).toBe(1)
  })
})

describe("candidate deletion and portal isolation", () => {
  it("judges deletion candidates against the deleted tree and publishes only the accepted deletion", async () => {
    const source = diffTarget("[]", "[gate]", "[\"**\"]").replace(
      "shell: \"true\"",
      "shell: \"test ! -e out/remove.txt\""
    )
    const { root, options, plan } = await fixture(source, {
      "prompt.md": "Remove the obsolete file.",
      "out/remove.txt": "obsolete",
      "other.txt": "preserve"
    })
    const scripted = AgentFake.makeScriptedSessionFactory({
      responses: [{ findings: [], edits: [{ path: "out/remove.txt", contents: null }] }]
    })
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(
        Effect.provideService(ExecutionServices, { ...executionServicesLive, sessions: () => scripted })
      )
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(scripted.spawns()).toBe(1)
    await expect(Fs.stat(Path.join(root, "out/remove.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await Fs.readFile(Path.join(root, "other.txt"), "utf8")).toBe("preserve")
  })

  it("reverts a candidate gate's escaping host write and refuses publication", async () => {
    const { root, options, plan } = await fixture(diffTarget("[]", "[gate]"), { "prompt.md": "Produce one file." })
    const external = `${root}-portal`
    await Fs.mkdir(external)
    await Fs.writeFile(Path.join(external, "value.txt"), "original")
    await Fs.symlink(external, Path.join(root, "portal"))
    const scripted = AgentFake.makeScriptedSessionFactory({
      responses: [{ findings: [], edits: [{ path: "out/value.txt", contents: "candidate" }] }]
    })
    try {
      const result = await Effect.runPromise(
        executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
          ...executionServicesLive,
          sessions: () => scripted,
          exec: (settings, payload) =>
            executionServicesLive.exec(settings, payload).pipe(
              Effect.tap(() =>
                Effect.promise(() => Fs.writeFile(Path.join(external, "value.txt"), "escaped host write"))
              )
            )
        }))
      )
      expect(result.ok).toBe(false)
      expect(result.results[0]?.error).toContain("candidate gate touched the real tree through a symlink (reverted)")
      expect(await Fs.readFile(Path.join(external, "value.txt"), "utf8")).toBe("original")
      await expect(Fs.stat(Path.join(root, "out/value.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await Fs.rm(external, { recursive: true, force: true })
    }
  })
})

describe("agent interruption and failed diagnostics", () => {
  it("records an interrupted agent host as a failed target without publishing", async () => {
    const { root, options, plan } = await fixture(diffTarget(), { "prompt.md": "Produce one file." })
    const result = await Effect.runPromise(
      executeEffect(plan, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        sessions: () => ({ open: () => Effect.interrupt })
      }))
    )
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toBe("agent session interrupted")
    await expect(Fs.stat(Path.join(root, "out/value.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps a cache warning's failed diagnostic in the agent failure", async () => {
    const { root, options, plan } = await fixture(diffTarget(), { "prompt.md": "Produce one file." })
    const scripted = AgentFake.makeScriptedSessionFactory({
      responses: [{ findings: [], edits: [{ path: "out/value.txt", contents: "candidate" }] }]
    })
    class FaultNotes
      extends Context.Service<FaultNotes, { readonly write: (line: string) => Effect.Effect<void, Error> }>()(
        "test/RunnerFaultNotes"
      )
    {}
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const notes = yield* FaultNotes
        return yield* executeEffect(plan, { ...options, log: (line) => Effect.runSync(notes.write(line)) }).pipe(
          Effect.provideService(ExecutionServices, {
            ...executionServicesLive,
            sessions: () => scripted,
            cache: (settings) =>
              executionServicesLive.cache(settings).pipe(Effect.map((store) => ({
                ...store,
                put: (...args: Parameters<typeof store.put>) =>
                  args[0].startsWith("agent-verdict-")
                    ? Effect.runPromise(Effect.fail(new Error("verdict store unavailable")))
                    : store.put(...args)
              })))
          })
        )
      }).pipe(Effect.provideService(FaultNotes, {
        write: (line) =>
          line.includes("could not store") ? Effect.fail(new Error("cache warning unavailable")) : Effect.void
      }))
    )
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toContain("agent cache:")
    expect(result.results[0]?.error).toContain("cache warning unavailable")
    await expect(Fs.stat(Path.join(root, "out/value.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("candidate service identities", () => {
  it.each(["docker", "anvil"] as const)("keeps the %s gate service rooted in its candidate tree", async (kind) => {
    const { options, plan } = await fixture(diffTarget("[]", "[gate]"), { "prompt.md": "Produce one file." })
    const nodes = new Map(plan.nodes)
    const gate = nodes.get("//:gate")!
    nodes.set(gate.label, { ...gate, serviceDeps: ["//:server"] } as unknown as PackageExec.PackageNode)
    nodes.set(
      "//:server",
      {
        ...gate,
        label: "//:server",
        rule: kind === "docker" ? "Docker.Service" : "Anvil.Fork",
        lane: { kind: kind === "docker" ? "docker-service" : "anvil-fork", attrs: {} }
      } as unknown as PackageExec.PackageNode
    )
    const scripted = AgentFake.makeScriptedSessionFactory({
      responses: [{ findings: [], edits: [{ path: "out/value.txt", contents: "candidate" }] }]
    })
    const labels: Array<string> = []
    const result = await Effect.runPromise(
      executeEffect({ ...plan, nodes }, options).pipe(Effect.provideService(ExecutionServices, {
        ...executionServicesLive,
        sessions: () => scripted,
        dockerService: (settings) => {
          labels.push(settings.label)
          return Effect.runPromise(Effect.fail(new Error("service host unavailable")))
        },
        anvilService: (settings) => {
          labels.push(settings.label)
          return Effect.runPromise(Effect.fail(new Error("service host unavailable")))
        }
      }))
    )
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatch(/^\/\/:server @ /)
    expect(result.ok).toBe(false)
    expect(result.results[0]?.error).toContain("service host unavailable")
  })
})
