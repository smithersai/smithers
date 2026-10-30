// The registry's laws (decision 0003 §1, docs/features/flows.md#the-registry): anything a person can do, the agent can
// do; every registered flow runs on this device; the UI dispatches only registered names; and the declarations an
// engine runs are the registry's flows, one to one, with the very schemas the tab dispatches by.
import { Flow } from "@smthrs/flow"
import { Placement } from "@smthrs/plan"
import { Context, Effect, Option } from "effect"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import ts from "typescript"
import { agentFlows, catalogDescription, childExecutionId, publicError } from "./catalog"
import { clientFlows, declarationOf, declarations, modelInvocable } from "./declarations"
import { entryOf, FlowRegistry, names, registry } from "./registry"
import { requesterOf } from "./requests"
import { AGENT_FLOWS, PERSON_ONLY_FLOWS } from "../../worker/Actor.ts"

/** Every source file under `src/`, tests and test support left out. */
const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "test" ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : []
  })

// Kept separately so syntax coverage is itself a regression test.
const dispatchArguments = (source: ts.SourceFile): ReadonlyArray<ts.Expression> => {
  const args: ts.Expression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "dispatch") {
      expect(node.arguments.length).toBeGreaterThan(0)
      args.push(node.arguments[0]!)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return args
}

test("dispatch scanning includes single quotes, template literals and constants", () => {
  const source = ts.createSourceFile("dispatch.ts", "const FLOW = 'app/theme/set'; f.dispatch('app/theme/set', {}); f.dispatch(`app/navigate`, {}); f.dispatch(FLOW, {})", ts.ScriptTarget.Latest)
  expect(dispatchArguments(source).map((argument) => argument.getText(source))).toEqual(["'app/theme/set'", "`app/navigate`", "FLOW"])
})

describe("the parity law", () => {
  test("every registered flow the agent may not run says why, and declares itself not model-invocable", () => {
    for (const name of names) {
      const entry = entryOf(name)
      expect([name, modelInvocable(name)]).toEqual([name, entry.userOnlyReason === undefined])
      if (entry.userOnlyReason !== undefined) expect(entry.userOnlyReason.length).toBeGreaterThan(0)
    }
  })

  test("the server's person-only list and its agents are the registry's, one to one (decision 0017 slice 0)", () => {
    expect(Object.keys(PERSON_ONLY_FLOWS).sort()).toEqual(
      names.filter((name) => entryOf(name).userOnlyReason !== undefined).toSorted(),
    )
    expect([...AGENT_FLOWS].sort()).toEqual(names.filter((name) => entryOf(name).acts === "agent").toSorted())
    // An agent asks nobody's leave: the person only starts it, and its run's own requests carry its credential.
    for (const name of AGENT_FLOWS) {
      const enforcement = PERSON_ONLY_FLOWS[name as keyof typeof PERSON_ONLY_FLOWS]
      if (enforcement !== undefined) expect("route" in enforcement, name).toBe(false)
    }
  })

  test("the UI dispatches only registered names", () => {
    const paths = sources(join(import.meta.dirname, ".."))
    const config = ts.readConfigFile(join(import.meta.dirname, "../../tsconfig.json"), ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(import.meta.dirname, "../.."))
    const program = ts.createProgram(paths, parsed.options)
    const checker = program.getTypeChecker()
    const dispatched: string[] = []
    for (const path of paths) {
      const source = program.getSourceFile(path)!
      for (const argument of dispatchArguments(source)) {
        const inferred = checker.getTypeAtLocation(argument)
        const type = checker.getBaseConstraintOfType(inferred) ?? inferred
        for (const member of type.isUnion() ? type.types : [type]) {
          // Constants, unions and template literals must resolve to registered names; an unconstrained string fails.
          expect(member.isStringLiteral(), `${path}: ${argument.getText(source)}`).toBe(true)
          if (member.isStringLiteral()) dispatched.push(member.value)
        }
      }
    }
    expect(dispatched).toContain("app/theme/set")
    expect(dispatched).toContain("triage/enable")
    for (const name of dispatched) expect(names).toContain(name)
  }, 90_000)

  test("the agent's catalog is every model-invocable flow", () => {
    expect(agentFlows).toEqual(names.filter(modelInvocable))
    expect(agentFlows).toEqual([
      "app/theme/set",
      "conversation/new",
      "app/navigate",
      "file/open",
      "file/close",
      "app/web/open",
      "app/docs/search",
      "ui/form",
      "ui/render",
      "view/set-state",
      "ui/repo",
      "ui/issues",
      "chat/pin",
      "chat/unpin",
      "chat/copy",
      "app/memory/remember",
      "repo/tree",
      "repo/read",
      "repo/refs",
      "repo/clone",
      "repo/copy",
      "app/jev/classify",
      "app/jev/evaluate",
      "app/agent/ask",
      "flow/new",
      "flow/save",
      "flow/read",
      "flow/write",
      "flow/run",
      "flow/delete",
      "flow/draft/delete",
      "flow/drafts",
      "flow/list",
      "run/cancel",
      "run/retry",
      "run/retry/from",
      "run/resume",
      "run/list",
      "run/inspect",
      "run/steer",
      "branch/track",
      "branch/create",
      "branch/publish",
      "branch/update",
      "branch/resync",
      "conversation/archive",
      "issue/create",
      "issue/comment",
      "todo/draft",
      "todo/issue",
      "todo/inspect",
      "todo/Retry",
      "watch/set",
      "model/test",
      "app/bug/report",
      "app/bug/list",
      "model/remove",
      "sandbox/run",
      "sandbox/read",
      "sandbox/write",
      "sandbox/list",
      "sandbox/status",
      "sandbox/diff",
    ])
  })
})

describe("names and placement", () => {
  test("each entry is registered under its own flow's tag, in a namespace only the app claims", () => {
    for (const name of names) {
      expect(registry[name].flow._tag).toBe(name)
      expect(name).toMatch(/^(app|auth|chat|repo|ui|view|flow|run|branch|conversation|terminal|issue|triage|pull|todo|watch|notification|alert|domain|model|sandbox|timeline|file)\//)
    }
  })

  test("each registered flow has one declaration, with the very tag and schemas the tab dispatches by", () => {
    expect(Object.keys(declarations)).toEqual(names)
    for (const name of names) {
      const reference = entryOf(name).flow
      const declaration = declarationOf(name)
      expect(Flow.isFlow(declaration)).toBe(true)
      expect(declaration._tag).toBe(reference._tag)
      expect(declaration.payloadSchema).toBe(reference.payloadSchema)
      expect(declaration.successSchema).toBe(reference.successSchema)
      expect(declaration.errorSchema).toBe(reference.errorSchema)
    }
    // The agent's flow is only a reference here: the tab never holds its body.
    expect(Flow.isFlow(registry["chat/Answer"].flow)).toBe(false)
  })

  test("every registered flow declares that it runs on this device", () => {
    for (const name of names) {
      const declared = Context.getOption(declarationOf(name).annotations, Flow.Placement)
      expect([name, declared]).toEqual([name, Option.some(Placement.client())])
    }
  })

  test("the engine runs every registered flow", () => {
    expect(clientFlows).toEqual(names.map(declarationOf))
    expect(clientFlows.map((flow) => flow._tag)).toEqual([
      "timeline/summarize",
      "auth/refresh",
      "app/theme/set",
      "conversation/new",
      "app/navigate",
      "file/open",
      "file/close",
      "app/web/open",
      "app/docs/search",
      "ui/form",
      "ui/render",
      "view/set-state",
      "ui/repo",
      "ui/issues",
      "chat/Answer",
      "chat/Close",
      "chat/pin",
      "chat/unpin",
      "chat/copy",
      "chat/edit",
      "app/memory/remember",
      "repo/tree",
      "repo/read",
      "repo/refs",
      "repo/about",
      "repo/clone",
      "repo/copy",
      "app/jev/classify",
      "app/jev/evaluate",
      "app/agent/ask",
      "run/answer",
      "run/deliver",
      "flow/new",
      "flow/answer",
      "flow/save",
      "flow/read",
      "flow/write",
      "flow/run",
      "flow/run/prompt",
      "flow/delete",
      "flow/draft/delete",
      "flow/drafts",
      "flow/list",
      "run/cancel",
      "run/retry",
      "run/retry/from",
      "run/resume",
      "run/list",
      "run/inspect",
      "run/steer",
      "branch/track",
      "branch/create",
      "branch/publish",
      "branch/update",
      "branch/resync",
      "conversation/archive",
      "branch/share",
      "terminal/open",
      "issue/create",
      "issue/comment",
      "issue/triage",
      "issue/commitment",
      "triage/run",
      "triage/enable",
      "triage/pause",
      "pull/review",
      "todo/draft",
      "todo/issue",
      "todo/inspect",
      "todo/commit",
      "todo/Retry",
      "todo/drop",
      "watch/set",
      "notification/ack",
      "alert/channel",
      "sandbox/limits",
      "domain/add",
      "domain/remove",
      "model/test",
      "app/bug/report",
      "app/bug/list",
      "model/remove",
      "sandbox/run",
      "sandbox/read",
      "sandbox/write",
      "sandbox/list",
      "sandbox/status",
      "sandbox/diff",
    ])
  })
})

describe("side effects (the registry's `changes`)", () => {
  // The flows the agent calls that change nothing: it may call them on the way to any answer. Every other flow it
  // calls changes something and says what, so a new flow is one or the other on purpose. The agent evals caught it
  // cloning a repository it was only asked to open, and saving and running a flow it was only asked to create
  // (docs/features/agent-evals.md, 2026-10-20).
  const READS = [
    "app/bug/list",
    "repo/tree",
    "repo/read",
    "repo/refs",
    "app/jev/classify",
    "app/jev/evaluate",
    "app/agent/ask",
    "flow/read",
    "flow/drafts",
    "flow/list",
    "run/list",
    "run/inspect",
    "todo/inspect",
    "sandbox/read",
    "sandbox/list",
    "sandbox/status",
    "sandbox/diff",
  ]

  test("every flow the agent may call is a read or says what it changes, and no flow only a person runs does", () => {
    for (const name of names) {
      const { changes } = entryOf(name)
      const declares = changes !== undefined && changes.length > 0
      expect([name, declares]).toEqual([name, modelInvocable(name) && !READS.includes(name)])
    }
    for (const name of READS) expect(agentFlows).toContain(name)
  })

  test("only a flow that says what it changes asks the person first: saving or deleting your flow, publishing a branch, removing your model", () => {
    const asking = names.filter((name) => entryOf(name).confirm !== undefined)
    expect(asking).toEqual(["flow/save", "flow/delete", "flow/draft/delete", "branch/publish", "model/remove"])
    for (const name of asking) expect([name, entryOf(name).changes !== undefined]).toEqual([name, true])
  })

  test("the catalog shows a flow's side effect after its own description, and nothing more for a read", () => {
    expect(catalogDescription("repo/clone")).toBe(
      `${declarationOf("repo/clone").description} Side effect: clones the repository, which spends the deployment's ` +
        "storage; only when the person asks for that.",
    )
    expect(catalogDescription("flow/save")).toContain("Side effect: saves a draft as the person's flow;")
    expect(catalogDescription("flow/run")).toContain("Side effect: runs the person's flow")
    expect(catalogDescription("repo/tree")).toBe(declarationOf("repo/tree").description)
  })

  test("every registered flow describes itself, which the catalog, the slash menu and the drafting agent read", () => {
    for (const name of names) {
      const { description } = declarationOf(name)
      expect([name, typeof description === "string" && description.length > 0]).toEqual([name, true])
    }
  })
})

describe("the agent's catalog", () => {
  test("tests and removes the person's own model, asking before a remove, and never saves one (decision 0096)", () => {
    // Saving takes the key, which never enters a model's context, a journal or the device: it is no flow at all.
    expect(names.filter((name) => name.startsWith("model/"))).toEqual(["model/test", "model/remove"])
    expect(agentFlows.filter((name) => name.startsWith("model/"))).toEqual(["model/test", "model/remove"])
    // Testing spends a call, a Member's; anyone signed in removes their own model, a person who lost their role included.
    expect(entryOf("model/test").minimum).toBe("member")
    expect(entryOf("model/remove").minimum).toBeUndefined()
    expect(catalogDescription("model/test")).toContain("Side effect: makes one tiny call with the person's own model")
    expect(catalogDescription("model/remove")).toContain('Approval: this call asks the person "Remove your model?"')
  })

  test("names each cell call's child execution by the call's replay-stable identity", () => {
    expect(childExecutionId({ session: "answer-1/chat/Respond@abc:1", frame: 2, ordinal: 0 } as never)).toBe(
      "answer-1/chat/Respond@abc:1/call/2.0",
    )
  })

  test("a cell call's child execution belongs to the answer whose run made it, which the asking tab dispatched", () => {
    const child = childExecutionId({ session: "answer-1/chat/Respond@abc:1", frame: 2, ordinal: 0 } as never)
    expect(requesterOf(child)).toBe("answer-1")
    // A tab's own dispatch is its own requester.
    expect(requesterOf("8a7f0c2e-5d1b-4c4a-9a43-0f2a1f7e9b10")).toBe("8a7f0c2e-5d1b-4c4a-9a43-0f2a1f7e9b10")
  })

  test("tells a cell a flow's failure by its kind, never its message", () => {
    expect(publicError({ _tag: "@smthrs/mvp/theme/PreferencesUnavailable", message: "secret" })).toBe(
      "PreferencesUnavailable",
    )
    expect(publicError(new Error("secret"))).toBe("failed")
  })
})


test("the registry service supplies the app's exact references and declaration order", async () => {
  const registered = await Effect.runPromise(Effect.gen(function* () {
    return yield* FlowRegistry
  }).pipe(Effect.provide(FlowRegistry.layer)))
  expect(registered.names).toEqual(names)
  for (const name of registered.names) {
    expect(registered.entryOf(name)).toBe(registered.entries[name])
    expect(registered.entries[name]!.flow).toBe(registry[name].flow)
  }
})
