/**
 * `smthrs init`, and the repository ignore rule it adds.
 *
 * The 0.x requirement carried forward (`apps/cli/tests/init-root-gitignore.test.js`
 * and `init.e2e.test.js`): run state must never reach a commit, the edit is
 * idempotent, and a directory that is not a repository is left alone.
 */
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime, Graph } from "@smthrs/flow"
import * as Model from "@smthrs/model/Model"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Schema, Stream } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as Init from "../src/Init.ts"
import * as Project from "../src/Project.ts"
import * as Verb from "../src/Verb.ts"

const staged: Array<string> = []

const directory = (kind?: ".git" | ".jj"): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-init-"))
  staged.push(root)
  if (kind !== undefined) mkdirSync(join(root, kind))
  return root
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

describe("the ignore rule", () => {
  it("creates a .gitignore holding .flows/ in a repository without one", () => {
    const root = directory(".git")

    expect(Init.ensureIgnored(root)).toBe("created")
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".flows/")
  })

  it("appends to an existing file exactly once", () => {
    const root = directory(".git")
    writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8")

    expect(Init.ensureIgnored(root)).toBe("updated")
    expect(Init.ensureIgnored(root)).toBe("unchanged")
    const contents = readFileSync(join(root, ".gitignore"), "utf8")
    expect(contents.startsWith("node_modules/\n")).toBe(true)
    expect(contents.match(/^\.flows\/$/gm)).toHaveLength(1)
  })

  it("adds a separating newline to a file that does not end in one", () => {
    const root = directory(".git")
    writeFileSync(join(root, ".gitignore"), "node_modules/", "utf8")

    expect(Init.ensureIgnored(root)).toBe("updated")
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules/\n# Smithers run state\n.flows/\n")
  })

  it("respects a rule that already covers the path, in any of its spellings", () => {
    for (const rule of [".flows", ".flows/", "/.flows", "/.flows/", "  .flows/  "]) {
      const root = directory(".git")
      writeFileSync(join(root, ".gitignore"), `${rule}\n`, "utf8")

      expect(Init.ensureIgnored(root)).toBe("unchanged")
    }
  })

  it("recognizes a jj-only repository", () => {
    expect(Init.ensureIgnored(directory(".jj"))).toBe("created")
  })

  it("writes nothing outside a repository", () => {
    // A .gitignore in a directory that is not a repository is litter.
    const root = directory()

    expect(Init.ensureIgnored(root)).toBe("skipped")
    expect(existsSync(join(root, ".gitignore"))).toBe(false)
    expect(Init.isRepository(root)).toBe(false)
  })
})

describe("the scaffold", () => {
  it("writes .smithers/flows/<name>/flow.ts and ignores .flows/", () => {
    const root = directory(".git")

    const result = Init.scaffold(root, "review", {})

    expect(result).toMatchObject({ name: "review", created: true, gitignore: "created" })
    expect(result.flowFile).toBe(join(root, ".smithers", "flows", "review", "flow.ts"))
    expect(existsSync(join(root, "flows"))).toBe(false)
    const body = readFileSync(result.flowFile, "utf8")
    expect(body).not.toContain("\nname:")
    expect(body).toContain("export default Flow.make(\"review\", {")
  })

  it("names the entry file it writes in the init verb's own help", () => {
    const root = directory(".git")

    // The published help and the owning docs named `flow.mdx` after the
    // scaffold moved to a module (#3638), so the sentence is pinned to the
    // file the scaffold actually writes rather than to a literal.
    expect(Verb.find("init")!.help).toContain(basename(Init.scaffold(root, "review", {}).flowFile))
  })

  it.each(["flow.ts", "flow.mdx", "SKILL.md"])("retains an authored %s without creating another entry", (entry) => {
    const root = directory(".git")
    const folder = join(root, ".smithers", "flows", "review")
    mkdirSync(folder, { recursive: true })
    const file = join(folder, entry)
    writeFileSync(file, "mine\n")
    const second = Init.scaffold(root, "review", {})
    expect(second.created).toBe(false)
    expect(second.flowFile).toBe(file)
    expect(readFileSync(file, "utf8")).toBe("mine\n")
    for (const other of ["flow.ts", "flow.mdx", "SKILL.md"].filter((value) => value !== entry)) {
      expect(existsSync(join(folder, other))).toBe(false)
    }
  })

  it.each([["flow.ts", "flow.mdx"], ["flow.ts", "SKILL.md"], ["flow.mdx", "SKILL.md"]])(
    "refuses duplicate entries %s and %s before writing state",
    (first, second) => {
      const root = directory(".git")
      const folder = join(root, ".smithers", "flows", "review")
      mkdirSync(folder, { recursive: true })
      for (const entry of [first, second]) writeFileSync(join(folder, entry), entry)
      expect(() => Init.scaffold(root, "review", {})).toThrow(expect.objectContaining({ code: "flow_conflict" }))
      for (const entry of [first, second]) expect(readFileSync(join(folder, entry), "utf8")).toBe(entry)
      expect(existsSync(join(root, ".flows"))).toBe(false)
      expect(existsSync(join(root, ".gitignore"))).toBe(false)
    }
  )

  it.each([".smithers", ".smithers/flows", ".smithers/flows/review", ".flows", ".gitignore"])(
    "refuses a symlink at %s without writing outside the project",
    (path) => {
      const root = directory(".git")
      const outside = directory()
      mkdirSync(join(root, dirname(path)), { recursive: true })
      symlinkSync(outside, join(root, path))
      expect(() => Init.scaffold(root, "review", {})).toThrow(expect.objectContaining({ code: "unsafe_scaffold_path" }))
      expect(existsSync(join(outside, "flow.ts"))).toBe(false)
      expect(existsSync(join(outside, "review"))).toBe(false)
    }
  )

  it("retains a dangling entry symlink without replacing it", () => {
    const root = directory()
    const folder = join(root, ".smithers", "flows", "review")
    mkdirSync(folder, { recursive: true })
    symlinkSync(join(root, "missing"), join(folder, "flow.mdx"))
    expect(Init.scaffold(root, "review", {}).created).toBe(false)
    expect(existsSync(join(folder, "flow.ts"))).toBe(false)
    expect(existsSync(join(root, "missing"))).toBe(false)
  })

  it("leaves behind the .flows/ anchor, so every subdirectory resolves one root", () => {
    const root = directory()
    const result = Init.scaffold(root, "review", {})
    const nested = join(root, "src", "deep")
    mkdirSync(nested, { recursive: true })

    expect(result.stateDirectory).toBe(join(root, ".flows"))
    expect(existsSync(result.stateDirectory)).toBe(true)
    expect(Project.root(undefined, nested)).toBe(root)
  })

  it("names a flow after the project directory when none is given", () => {
    expect(Init.defaultName("/work/My Project")).toBe("my-project")
    expect(Init.defaultName("/work/api-server/")).toBe("api-server")
    expect(Init.defaultName("/")).toBe("flow")
    expect(Init.defaultName("/work/___")).toBe("flow")
  })

  it.each([
    ["traversal", "../outside"],
    ["absolute path", "/absolute"],
    ["slash separator", "a/b"],
    ["backslash separator", "a\\b"],
    ["YAML metacharacter", "a: b"],
    ["quote", "review\"evil"],
    ["Unicode outside the portable set", "réview"],
    ["newline", "name\nmodel: evil"],
    ["empty name", ""],
    ["dot segment", "."]
  ])("refuses a %s before creating state", (_label, name) => {
    const root = directory(".git")
    const reason = `a flow name is one path segment of letters, digits, '-' and '_'; got ${JSON.stringify(name)}`

    expect(Init.nameProblem(name)).toBe(reason)
    // Retyping the name fixes it: a usage error, which exits 2.
    expect(() => Init.scaffold(root, name, {})).toThrow(
      expect.objectContaining({ _tag: "/cli/UsageError", message: reason })
    )
    expect(Init.isValidName(name)).toBe(false)
    expect(existsSync(join(root, ".smithers"))).toBe(false)
    expect(existsSync(join(root, "outside"))).toBe(false)
    expect(existsSync(join(root, ".flows"))).toBe(false)
    expect(existsSync(join(root, ".gitignore"))).toBe(false)
  })

  it("accepts one segment made from the documented character set", () => {
    expect(Init.nameProblem("review_2-final")).toBeUndefined()
    expect(Init.isValidName("review_2-final")).toBe(true)
  })
})

describe("the seat the scaffold writes", () => {
  it("chooses the first provider key the environment sets, in the order doctor lists them", () => {
    expect(Init.defaultSeat({ ANTHROPIC_API_KEY: "k" })).toEqual({
      seat: "anthropic:claude-sonnet-4-5",
      variable: "ANTHROPIC_API_KEY",
      resolved: true
    })
    expect(Init.defaultSeat({ OPENAI_API_KEY: "k" })).toEqual({
      seat: "openai:gpt-6-sol",
      variable: "OPENAI_API_KEY",
      resolved: true
    })
    expect(Init.defaultSeat({ OPENROUTER_API_KEY: "k" })).toEqual({
      seat: "openrouter:anthropic/claude-sonnet-4.5",
      variable: "OPENROUTER_API_KEY",
      resolved: true
    })
    // Doctor's order decides when more than one key is present.
    expect(Init.defaultSeat({ OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" }).seat)
      .toBe("anthropic:claude-sonnet-4-5")
  })

  it("counts the ChatGPT session as the openai credential, and an exported empty key as unset", () => {
    expect(Init.defaultSeat({ SMITHERS_OPENAI_AUTH: "chatgpt" })).toEqual({
      seat: "openai:gpt-6-sol",
      variable: "SMITHERS_OPENAI_AUTH",
      resolved: true
    })
    expect(Init.defaultSeat({ ANTHROPIC_API_KEY: "" }).resolved).toBe(false)
  })

  it("names a seat even when nothing resolves, so the launch refuses by naming its key", () => {
    // `smthrs up` on this scaffold answers `Set ANTHROPIC_API_KEY to run the
    // anthropic:claude-sonnet-4-5 seat`. A scaffold with no `model:` line
    // answers nothing an operator can act on.
    expect(Init.defaultSeat({})).toEqual({
      seat: "anthropic:claude-sonnet-4-5",
      variable: "ANTHROPIC_API_KEY",
      resolved: false
    })
  })

  it("selects a compatible provider the production executor can route", () => {
    expect(Init.defaultSeat({ CEREBRAS_API_KEY: "k" })).toEqual({
      seat: "cerebras:qwen-3.8-27b",
      variable: "CEREBRAS_API_KEY",
      resolved: true
    })
    expect(Init.defaultSeat({ MOONSHOT_API_KEY: "k" }).seat).toBe("moonshot:kimi-k3")
    expect(Init.defaultSeat({ GOOGLE_API_KEY: "k" }).seat).toBe("gemini:gemini-2.5-pro")
  })

  it("emits seat strings as literals and never writes credentials", () => {
    const secret = "fixture-credential"
    const body = Init.template("review", Init.defaultSeat({ OPENAI_API_KEY: secret }))
    expect(body).toContain("seat: \"openai:gpt-6-sol\"")
    expect(body).not.toContain(secret)
    expect(() => Init.template("bad\"name", Init.defaultSeat({}))).toThrow("one path segment")
  })
})

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)

describe("generated TypeScript through the public registry and runtime", () => {
  it.each([
    { name: "review_2-final", selectedSeat: "openai:gpt-6-sol" },
    { name: "HELLO", selectedSeat: "openai:gpt-6-sol" },
    { name: "_escaped", selectedSeat: "fixture:\"\\\nseat" }
  ])("discovers, plans and completes $name with the selected seat", async ({ name, selectedSeat }) => {
    const root = directory()
    const scaffolded = Init.scaffold(root, name, { OPENAI_API_KEY: "never-written" })
    if (selectedSeat !== "openai:gpt-6-sol") {
      writeFileSync(
        scaffolded.flowFile,
        Init.template(name, { seat: selectedSeat, variable: "unused", resolved: true })
      )
    }
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
    const resolved: Array<string> = []
    const requests: Array<string> = []
    // Only the provider and completion judge are scripted; discovery, module
    // loading, planning, action registration, schema decoding and engine are real.
    const model = Model.make({
      stream: (request) => {
        requests.push(JSON.stringify({ messages: request.messages, system: request.system }))
        return Stream.fromIterable([
          ModelEvent.TextStart({ type: "text-start", id: "answer" }),
          ModelEvent.TextDelta({
            type: "text-delta",
            id: "answer",
            text: "```cell\nctx.done(JSON.stringify({ summary: \"Checked the project.\" }))\n```"
          }),
          ModelEvent.TextEnd({ type: "text-end", id: "answer" }),
          ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      }
    })
    const resolver = SeatResolver.layer({
      resolve: (id) =>
        Effect.sync(() => {
          resolved.push(id)
          return Seat.make({
            id,
            modelId: "fixture",
            model,
            contextWindowTokens: 200_000,
            route: {
              prepare: () =>
                Effect.succeed({
                  routeId: "fixture",
                  protocolId: "fixture",
                  method: "POST",
                  url: "https://fixture.invalid",
                  publicHeaders: {},
                  body: new Uint8Array(),
                  bodyText: ""
                })
            }
          })
        })
    })
    const host = Layer.mergeAll(
      Agent.layer,
      Agent.layerDefaults,
      ScriptedJudge.layer,
      AgentAction.layerHost({ registry: Registry.makeNoop(), limits: { calls: 3 }, maxFrames: 2, claimCap: 0 }),
      resolver,
      Action.layerImplementations,
      FlowEngine.layerMemory,
      platform
    ).pipe(Layer.provideMerge(Layer.merge(Budget.layerUnbounded(), QuotaPolicy.layerUnclassified())))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const descriptors = yield* registry.list()
        expect(descriptors.map((entry) => entry.name)).toEqual([name])
        expect(descriptors[0]!.capabilities).toEqual(["fs:read:**", "fs:write:**", "proc:spawn:*", "model:call:*"])
        expect(yield* registry.warnings()).toEqual([])
        expect(scaffolded.flowFile).toBe(join(root, ".smithers", "flows", name, "flow.ts"))
        const executable = yield* Executable.fromDescriptor(yield* registry.get(name), { delegates: [] })
        const input = { args: "Inspect the generated starter." }
        const graph = Graph.build(executable.flow, { input }, { callbackIdentity: "stable" })
        expect(graph.diagnostics).toEqual([])
        expect(graph.nodes.filter((node) => node.kind === "ActionCall")).toHaveLength(1)
        const runtime = yield* FlowRuntime.FlowRuntime
        return yield* runtime.execute(executable.flow, { payload: { input }, executionId: `init-${name}` }).pipe(
          Effect.provide(executable.layer)
        )
      }).pipe(
        Effect.provide(Registry.layerProject({ root }).pipe(Layer.provide(Discovery.layer))),
        Effect.provide(host),
        Effect.scoped
      )
    )
    expect(Schema.decodeUnknownSync(Schema.Struct({ summary: Schema.String }))(result)).toEqual({
      summary: "Checked the project."
    })
    expect(resolved).toEqual([selectedSeat])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain("Inspect the generated starter.")
  })
})

describe("retained legacy entry loading", () => {
  it.each(["flow.mdx", "SKILL.md"])("keeps %s discoverable and lazily loadable", async (entry) => {
    const root = directory()
    const folder = join(root, ".smithers", "flows", "legacy")
    mkdirSync(folder, { recursive: true })
    const text =
      "---\ndescription: An authored legacy flow.\ncapabilities: []\nmodel: openai:gpt-6-sol\n---\n\nKeep these instructions.\n"
    writeFileSync(join(folder, entry), text)
    expect(Init.scaffold(root, "legacy", {}).created).toBe(false)
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        expect((yield* registry.list()).map((descriptor) => descriptor.name)).toEqual(["legacy"])
        expect(yield* registry.warnings()).toEqual([])
        return yield* registry.loadBody("legacy")
      }).pipe(
        Effect.provide(Registry.layerProject({ root }).pipe(Layer.provide(Discovery.layer))),
        Effect.provide(platform)
      )
    )
    expect(result._tag).toBe("Prompt")
    expect(JSON.stringify(result)).toContain("Keep these instructions.")
    expect(readFileSync(join(folder, entry), "utf8")).toBe(text)
    expect(existsSync(join(folder, "flow.ts"))).toBe(false)
  })
})

it("typechecks the generated flow and rejects wrong imported prompt props with its own config", () => {
  const root = directory()
  const result = Init.scaffold(root, "review", {})
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
  const compiler = join(dirname(createRequire(import.meta.url).resolve("vibelang/package.json")), "bin/vibelang")
  const config = join(root, ".smithers/flows/review/tsconfig.json")
  const check = () => spawnSync(process.execPath, [compiler, "-p", config], { cwd: root, encoding: "utf8" })
  const compiled = check()
  expect(
    { status: compiled.status, signal: compiled.signal, error: compiled.error?.message },
    [compiled.stdout, compiled.stderr].filter(Boolean).join("\n")
  ).toEqual({ status: 0, signal: null, error: undefined })
  writeFileSync(result.flowFile, "import Instructions from \"./prompt.mdx\"; Instructions({ args: 42 });")
  const rejected = check()
  const diagnostics = [rejected.stdout, rejected.stderr].filter(Boolean).join("\n")
  expect(rejected.status, diagnostics).toBe(2)
  expect(diagnostics).toContain("not assignable to type 'string'")
  expect(diagnostics).not.toContain("Cannot find module './prompt.mdx'")
})

it.each(["tsconfig.json", "prompt.mdx", "prompt.d.mdx.ts"])("preserves an authored %s beside a new flow", (entry) => {
  const root = directory()
  const folder = join(root, ".smithers/flows/review")
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, entry), "authored\n")
  Init.scaffold(root, "review", {})
  expect(readFileSync(join(folder, entry), "utf8")).toBe("authored\n")
  Init.scaffold(root, "review", {})
  expect(readFileSync(join(folder, entry), "utf8")).toBe("authored\n")
})

it("refuses a symlinked compiler config without touching its target", () => {
  const root = directory()
  const outside = directory()
  mkdirSync(join(root, ".smithers/flows/review"), { recursive: true })
  const config = join(outside, "tsconfig.json")
  writeFileSync(config, "authored\n")
  symlinkSync(config, join(root, ".smithers/flows/review/tsconfig.json"))
  expect(() => Init.scaffold(root, "review", {})).toThrow(expect.objectContaining({ code: "unsafe_scaffold_path" }))
  expect(readFileSync(config, "utf8")).toBe("authored\n")
  expect(existsSync(join(root, ".smithers/flows/review/flow.ts"))).toBe(false)
})
