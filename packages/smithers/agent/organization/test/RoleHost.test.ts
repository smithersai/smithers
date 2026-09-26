/**
 * The role host a principal runs under, built directly: which flows each
 * grant binds, the capability envelope those flows declare, the skills the
 * registry admits, and the wiki reads the knowledge grants allow.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, Layer, Option } from "effect"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type * as Profile from "../src/Profile.ts"
import * as RoleHost from "../src/RoleHost.ts"
import { baseHost, exampleOrg, fileServices, loadSnapshot, memoryServices, wikiRoot } from "./dispatchSupport.ts"
import { hostMachines } from "./workspaceSupport.ts"

const profiles = async () => {
  const snapshot = await loadSnapshot()
  return (id: string): Profile.Profile => snapshot.roster.profiles.get(id)!
}

const build = (
  options: Omit<RoleHost.Options, "base" | "system" | "executionId"> & { readonly system?: Array<string> }
) =>
  Effect.runPromise(
    RoleHost.make({ base: baseHost, system: options.system ?? ["Composed."], executionId: "run-1", ...options }).pipe(
      Effect.exit
    )
  )

const built = async (options: Parameters<typeof build>[0]) => {
  const exit = await build(options)
  if (exit._tag === "Failure") throw new Error(String(exit.cause))
  return exit.value
}

const refused = async (options: Parameters<typeof build>[0]) => {
  const exit = await build(options)
  if (exit._tag === "Success") throw new Error("expected a refusal")
  return String(exit.cause)
}

const skillsLayer = Registry.layer({
  sources: [{ source: "organization", root: join(exampleOrg, "Skills"), naming: "path" }]
}).pipe(Layer.provide(Discovery.layer), Layer.provide(NodeServices.layer))

const wiki = (root = wikiRoot()) => ({ root, services: fileServices })

describe("RoleHost.make", () => {
  it("admits the reads the engine measures for a sealed memory call under the served root, and no other", async () => {
    const profile = await profiles()
    const served = (options: Parameters<typeof build>[0]) =>
      Effect.runPromise(
        RoleHost.make({ base: baseHost, system: ["Composed."], executionId: "run-1", ...options }).pipe(
          Effect.provideService(KernelWorkspace.Workspace, KernelWorkspace.make("/srv/org/"))
        )
      )
    const lead = await served({ profile: profile("lead"), resources: { memory: memoryServices, wiki: wiki() } })
    expect(lead.envelope.map((pattern) => [pattern.action, pattern.resource])).toEqual([
      ["fs:read", "/srv/org/memory/**"],
      ["net:get", "*"]
    ])
    const bare = await served({
      profile: { ...profile("lead"), grants: { ...profile("lead").grants, tools: ["wiki-read"] } },
      resources: { wiki: wiki() }
    })
    expect(bare.envelope).toEqual([])
  })

  it("binds only granted families, never the base host's flows, and keeps the base limits", async () => {
    const profile = await profiles()
    const lead = await built({ profile: profile("lead"), resources: { memory: memoryServices, wiki: wiki() } })
    expect(lead.flows).toEqual(["recall", "remember", "web-fetch", "wiki-read"])
    expect(lead.envelope.map((pattern) => `${pattern.action}:${pattern.resource}`)).toEqual(["net:get:*"])
    expect(lead.host.limits).toBe(baseHost.limits)
    expect(lead.host.system).toEqual(["Host teaching.", "Composed.", RoleHost.retrievalNotice])
    expect(lead.host.plugins).toBeUndefined()
    expect(lead.host.implementations).toBeUndefined()
    expect(lead.host.claimCap).toBeUndefined()

    const builder = await built({ profile: profile("builder"), resources: { memory: memoryServices, claimCap: 0 } })
    expect(builder.flows).toEqual(["recall", "remember", "web-fetch"])
    expect(builder.host.claimCap).toBe(0)

    // A principal granted no tool family gets no flow at all, and a base host
    // without teaching adds none.
    const bare = await Effect.runPromise(RoleHost.make({
      base: { ...baseHost, system: undefined },
      profile: { ...profile("builder"), grants: { ...profile("builder").grants, tools: [] } },
      system: ["Composed."],
      executionId: "run-1",
      resources: {}
    }))
    expect(bare.flows).toEqual([])
    expect(bare.host.system).toEqual(["Composed."])
  })

  it("binds the standard file and shell flows over a workspace session, and declares their capabilities", async () => {
    const profile = await profiles()
    const { machines } = hostMachines()
    const { flows, envelope, system } = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const session = yield* machines.workspace("run-1/example/demo/build")
      const { Sandbox } = yield* Effect.promise(() => import("@smthrs/sandbox"))
      const services = yield* Layer.build(
        Sandbox.layerHost({ acquire: () => Effect.succeed(session) }, { session: session.id })
      )
      const result = yield* RoleHost.make({
        base: baseHost,
        profile: profile("builder"),
        system: [],
        executionId: "run-1",
        resources: { memory: memoryServices },
        workspace: { services, workdir: session.workdir }
      })
      return {
        flows: result.flows,
        envelope: result.envelope.map((pattern) => `${pattern.action}:${pattern.resource}`),
        system: result.host.system
      }
    })))
    expect(flows).toEqual([
      "apply_patch",
      "bash",
      "edit",
      "glob",
      "grep",
      "ls",
      "read",
      "recall",
      "remember",
      "web-fetch",
      "write"
    ])
    expect(envelope).toEqual(["fs:read:/**", "fs:write:/**", "net:get:*", "proc:spawn:*"])
    expect(system?.at(-1)).toContain("isolated machine")
  })

  it("fails composition when a granted family has no resource, or a workspace is handed to a principal without it", async () => {
    const profile = await profiles()
    expect(await refused({ profile: profile("builder"), resources: {} })).toContain(
      "builder holds memory, and this host configured no memory store"
    )
    expect(await refused({ profile: profile("lead"), resources: { memory: memoryServices } })).toContain(
      "lead holds wiki-read, and this host configured no wiki"
    )
    expect(
      await refused({
        profile: profile("lead"),
        resources: { memory: memoryServices, wiki: wiki() },
        workspace: { services: Context.empty() as never, workdir: "/workspace" }
      })
    ).toContain("lead does not hold workspace")
  })
})

describe("the skills registry", () => {
  it("admits only the profile's skills, for every operation", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const base = yield* Registry.Registry
        const granted = RoleHost.skillsRegistry(base, ["evidence-receipts"])
        const none = RoleHost.skillsRegistry(base, [])
        yield* granted.refresh()
        return {
          base: (yield* base.list()).map((entry) => entry.name),
          listed: (yield* granted.list()).map((entry) => entry.name),
          visible: (yield* granted.visible()).map((entry) => entry.name),
          got: (yield* granted.get("evidence-receipts")).name,
          option: Option.isSome(yield* granted.getOption("evidence-receipts")),
          body: (yield* granted.loadBody("evidence-receipts"))._tag,
          warnings: (yield* granted.warnings()).map((warning) => warning.code),
          hiddenList: (yield* none.list()).length,
          hiddenVisible: (yield* none.visible()).length,
          hiddenOption: Option.isNone(yield* none.getOption("evidence-receipts")),
          hiddenGet: (yield* Effect.flip(none.get("evidence-receipts"))).code,
          hiddenBody: (yield* Effect.flip(none.loadBody("evidence-receipts"))).code,
          hiddenPrompt: (yield* Effect.flip(none.runPrompt("evidence-receipts", { args: "" }))).code
        }
      }).pipe(Effect.provide(skillsLayer))
    )
    expect(outcome).toMatchObject({
      base: ["evidence-receipts"],
      listed: ["evidence-receipts"],
      visible: outcome.visible,
      got: "evidence-receipts",
      option: true,
      body: "Prompt",
      warnings: ["name_field_ignored", "unprojectable_authority"],
      hiddenList: 0,
      hiddenVisible: 0,
      hiddenOption: true,
      hiddenGet: "not_found",
      hiddenBody: "not_found",
      hiddenPrompt: "not_found"
    })
  })

  it("keeps warnings about admitted names and unnamed warnings only", async () => {
    const warnings = [{ name: "evidence-receipts" }, { name: "other" }, {}] as never
    const base = Registry.makeNoop({ warnings: () => Effect.succeed(warnings), runPrompt: () => Effect.succeed("ran") })
    const view = RoleHost.skillsRegistry(base, ["evidence-receipts"])
    expect(await Effect.runPromise(view.warnings())).toEqual([{ name: "evidence-receipts" }, {}])
    expect(await Effect.runPromise(view.runPrompt("evidence-receipts", { args: "" }))).toBe("ran")
  })
})

describe("wiki-read", () => {
  const read = async (profile: Profile.Profile, root: string, path: string, maxBytes?: number) => {
    const source = RoleHost.wikiRead(profile, { root, services: fileServices, maxBytes })
    const [binding] = await Effect.runPromise(source.bindings())
    return Effect.runPromise(binding!.run({ identity: "c1", flow: RoleHost.wikiReadName, input: { path } } as never))
  }

  it("reads a granted page and refuses ungranted, escaping, and malformed paths", async () => {
    const profile = await profiles()
    const assistant = profile("assistant")
    const root = wikiRoot()
    mkdirSync(join(root, "Secrets"))
    writeFileSync(join(root, "Secrets", "plan.md"), "secret\n")
    symlinkSync(join(root, "Secrets", "plan.md"), join(root, "Org", "Roles", "linked.md"))
    symlinkSync(join(root, "Org", "Roles"), join(root, "Org", "Policy", "Roles"))
    const ok = await read(assistant, root, "Org/Roles/lead.md")
    expect(ok.outcome).toBe("success")
    expect(JSON.stringify(ok.value)).toContain("id: lead")
    const refusal = async (path: string, maxBytes?: number) =>
      JSON.stringify(await read(assistant, root, path, maxBytes))
    expect(await refusal("Org/Organization.md")).toContain("Org/Organization.md is not granted")
    expect(await refusal("Org/Roles/linked.md")).toContain("resolves to a path that is not granted")
    expect(await refusal("../outside.md")).toContain("is not a relative wiki file path")
    expect(await refusal("Org/Roles/")).toContain("is not a relative wiki file path")
    expect(await refusal("Org/Roles/missing.md")).toContain("could not be resolved")
    expect(await refusal("Org/Roles/lead.md", 10)).toContain("is over 10 bytes")
    mkdirSync(join(root, "Org", "Roles", "folder.md"))
    expect(await refusal("Org/Roles/folder.md")).toContain("is not a regular file")
  })
})

describe("the workspace snapshot boundary", () => {
  it("snapshots the workspace tree, diffs against it, and restores it exactly", async () => {
    const { fixtureRepo } = await import("./workspaceSupport.ts")
    const Workspace = await import("../src/Workspace.ts")
    const { FlowEngine } = await import("@smthrs/engine")
    const { readFileSync, existsSync } = await import("node:fs")
    const { repo, commit } = fixtureRepo()
    const { machines } = hostMachines()
    const options = { flow: undefined as never, executionId: "run-1", key: "k", attempt: 1, metadata: undefined }
    const outcome = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const workspace = yield* Workspace.Workspace
        const prepared = yield* workspace.prepare({ key: "run-1/example/demo/build", repoPath: repo, commit })
        const session = yield* workspace.session(prepared.key)
        const boundary = RoleHost.snapshotBoundary(session)
        const before = yield* boundary.snapshot(options)
        writeFileSync(join(session.workdir, "lib.txt"), "changed\n")
        writeFileSync(join(session.workdir, "new.txt"), "new\n")
        const diff = yield* boundary.diff(before, options)
        yield* boundary.restore(before, options)
        const restored = {
          lib: readFileSync(join(session.workdir, "lib.txt"), "utf8"),
          added: existsSync(join(session.workdir, "new.txt"))
        }
        const badRestore = yield* Effect.exit(boundary.restore("not-a-tree", options))
        const badDiff = yield* Effect.exit(boundary.diff("not-a-tree", options))
        const missingTree = yield* Effect.exit(boundary.restore("f".repeat(40), options))
        return {
          before,
          diff,
          restored,
          badRestore,
          badDiff,
          missingTree,
          boundary: FlowEngine.SnapshotBoundary.of(boundary)
        }
      })).pipe(
        Effect.provide(Workspace.layer({ machines, maxConcurrentVMs: 1 }).pipe(Layer.provide(NodeServices.layer)))
      )
    )
    expect(outcome.before).toMatch(/^[0-9a-f]{40}$/)
    expect(outcome.diff).toBe("M\tlib.txt\nA\tnew.txt")
    expect(outcome.restored).toEqual({ lib: "hello\n", added: false })
    for (const exit of [outcome.badRestore, outcome.badDiff, outcome.missingTree]) expect(exit._tag).toBe("Failure")
    expect(String(outcome.missingTree._tag === "Failure" && outcome.missingTree.cause)).toContain(
      "the workspace restore"
    )
  })
})
