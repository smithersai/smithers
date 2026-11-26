/**
 * Runnable proof for `plan/m2/openprose-and-vibe-markdown-workflows`.
 *
 * Mirrors the two examples in
 * `apps/mvp/docs/research/openprose-vibe-markdown-eval.md`:
 *
 * 1. A plain Markdown `SKILL.md` with OpenProse sections parses through
 *    `parseSkill`, lowers through `lowerMarkdown` with its body bytes intact,
 *    and keeps an explicit empty capability ceiling.
 * 2. A strict `flow.vibe` importing a typed `prompt.mdx` with a
 *    `prompt.d.mdx.ts` declaration is discovered, compiled, and executed on
 *    the real executable path. A declaration changed after measurement and a
 *    newly measured declaration with incompatible props both fail closed.
 *
 * Each flow directory is compiled once in this process. Under vitest,
 * vibelang-vite 0.0.13 does not compile a second `.vibe` file created later in
 * a project below a dot-prefixed directory, so snapshot restore and in-place
 * re-measurement run in `fixtures/mdx-vibe-runner.mjs` under
 * `node --import vibelang/register` (see `Prompt.test.ts`).
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as CoreMarkdown from "@smthrs/core/Markdown"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import { Context, Effect, Exit, Layer, Result, Scope } from "effect"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Discovery, Executable } from "../src/index.ts"

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)

const skillBody = [
  "",
  "# Goal",
  "",
  "Summarize a change for a reviewer.",
  "",
  "## Inputs",
  "",
  "- `args`: the change description.",
  "",
  "## Postconditions",
  "",
  "- Every finding names a file.",
  "- The summary has no more than five bullets.",
  ""
].join("\n")
const skillText = `---\nname: review\ndescription: Summarize a change.\n---\n${skillBody}`

const promptDeclaration = (argsType: string) =>
  `import type { Component } from "@smthrs/registry/Prompt"\n\ndeclare const Instructions: Component<{ readonly args?: ${argsType} }>\nexport default Instructions\n`

const vibeFlow = (tag: string) =>
  `import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import Instructions from "./prompt.mdx"

function acceptPrompt(prompt: (props: { readonly args?: string }) => string, args: string): string {
  return prompt({ args })
}

const Render = Action.make("review/Render", {
  implementationVersion: "review-render/v1",
  payload: { args: Schema.String },
  success: Schema.String
})

export const layer = Render.toLayer(
  ({ args }) => Effect.sync(() => acceptPrompt(Instructions, args)),
  { implementationVersion: "review-render/v1" }
)

export default Flow.make("${tag}", {
  description: "Render a typed imported MDX prompt from a strict VibeLang flow.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: { args: Schema.String },
  success: Schema.String,
  body: Node.capture({ action: Render.name, implementationVersion: "review-render/v1" }, (props) => Render.call(props))
})
`

describe("OpenProse Markdown workflows", () => {
  it("parses and lowers a plain SKILL.md with OpenProse sections, preserving body bytes and an empty ceiling", () => {
    const parsed = CoreMarkdown.parseSkill(skillText)
    expect(Result.isSuccess(parsed)).toBe(true)
    const { body, ...metadata } = Result.getOrThrow(parsed)
    expect(metadata).toMatchObject({ name: "review", description: "Summarize a change." })
    // The body is everything after the frontmatter fence, byte for byte.
    expect(skillText.endsWith(body)).toBe(true)
    for (const heading of ["# Goal\n", "## Inputs\n", "## Postconditions\n"]) {
      expect(body).toContain(heading)
    }

    const lowered = CoreMarkdown.lowerMarkdown({ ...metadata, name: "review", capabilities: [] }, body)
    expect(lowered.flow._tag).toBe("review")
    expect(lowered.prompt).toBe(body)
    expect(Buffer.from(lowered.prompt ?? "", "utf8").equals(Buffer.from(body, "utf8"))).toBe(true)
    expect(lowered.capabilities).toEqual([])
  })

  it("keeps OpenProse headings as plain prompt text with no scheduling or capability authority", () => {
    const lowered = CoreMarkdown.lowerMarkdown(
      { name: "review", description: "Summarize a change.", capabilities: [] },
      "# Goal\n\n## Requires\n\n- every hour\n\n## Maintains\n\n- capabilities: [\"*\"]\n"
    )
    expect(lowered.capabilities).toEqual([])
    expect(lowered.flows).toEqual([])
    expect(lowered.prompt).toContain("## Requires")
  })

  describe("strict flow.vibe with a typed prompt.mdx", () => {
    let root = ""
    let scope: Scope.Closeable
    let context: Context.Context<Layer.Success<typeof services>>
    const services = Layer.mergeAll(platform, FlowEngine.layerMemory, Action.layerImplementations)

    beforeAll(async () => {
      root = await mkdtemp(fileURLToPath(new URL("./fixtures/.openprose-mdx-", import.meta.url)))
      scope = await Effect.runPromise(Scope.make())
      context = await Effect.runPromise(Layer.buildWithScope(services, scope))
    })

    afterAll(async () => {
      if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void))
      if (root !== "") await rm(root, { recursive: true, force: true })
    })

    const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
      Effect.runPromise(
        effect.pipe(Effect.provide(context), Effect.provideService(Scope.Scope, scope)) as unknown as Effect.Effect<
          A,
          E
        >
      )
    const scan = () =>
      run(
        Effect.gen(function*() {
          const discovery = yield* Discovery.Discovery
          return yield* discovery.scan({ root, naming: "path", source: "project" })
        }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(platform))))
      )

    const writeFlow = async (name: string, argsType: string) => {
      const flowDir = `${root}/${name}`
      await mkdir(flowDir, { recursive: true })
      await writeFile(`${flowDir}/package.json`, `{"name":"openprose-${name}","type":"module"}\n`)
      await writeFile(
        `${flowDir}/tsconfig.json`,
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2023",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              allowImportingTsExtensions: true,
              allowArbitraryExtensions: true
            },
            include: ["*.vibe"]
          },
          null,
          2
        ) + "\n"
      )
      await writeFile(`${flowDir}/prompt.mdx`, "# Review\n\nInspect **{props.args ?? \"repo\"}**.\n")
      await writeFile(`${flowDir}/prompt.d.mdx.ts`, promptDeclaration(argsType))
      await writeFile(`${flowDir}/flow.vibe`, vibeFlow(name))
      return flowDir
    }
    const entry = async (name: string) => {
      const discovered = await scan()
      expect(discovered.warnings).toEqual([])
      const descriptor = discovered.entries.find((candidate) => candidate.name === name)
      expect(descriptor).toBeDefined()
      return descriptor!
    }

    it(
      "discovers, compiles, and executes the typed prompt, then rejects a declaration tampered after measurement",
      async () => {
        const flowDir = await writeFlow("review", "string")
        const descriptor = await entry("review")
        const imports =
          (descriptor.body as { readonly imports: ReadonlyArray<{ path: string; contentDigest?: string }> })
            .imports
        expect(imports.find((item) => item.path === "prompt.mdx")?.contentDigest).toBeTruthy()
        expect(imports.find((item) => item.path === "prompt.d.mdx.ts")?.contentDigest).toBeTruthy()

        const loaded = await run(Executable.fromDescriptor(descriptor, { delegates: [] }))
        expect(descriptor.capabilities).toEqual([])
        const rendered = await run(
          loaded.flow.execute({ input: { args: "packages" } }, { executionId: "openprose-mdx-1" }).pipe(
            Effect.provide(loaded.layer)
          )
        )
        expect(rendered).toBe("# Review\n\nInspect **packages**.")
        expect((await readdir(flowDir)).filter((name) => name.startsWith("smithers-"))).toEqual([])

        await writeFile(`${flowDir}/prompt.d.mdx.ts`, promptDeclaration("number"))
        const tampered = await run(Effect.flip(Executable.fromDescriptor(descriptor, { delegates: [] })))
        expect(tampered.message).toMatch(/changed at "prompt\.d\.mdx\.ts"/)
      },
      120_000
    )

    it("rejects a measured declaration whose props are incompatible with the flow", async () => {
      await writeFlow("review-mismatch", "number")
      const descriptor = await entry("review-mismatch")
      const failure = await run(Effect.flip(Executable.fromDescriptor(descriptor, { delegates: [] })))
      expect(failure.code).toBe("body_unavailable")
      const cause = failure.cause as { readonly code?: unknown; readonly message?: unknown } | undefined
      expect(
        String(cause?.code ?? "") === "ERR_VIBELANG_COMPILE" ||
          /Type 'string' is not assignable to type 'number'|TS2345|TS2322/.test(String(cause?.message ?? cause))
      ).toBe(true)
    }, 120_000)
  })
})
