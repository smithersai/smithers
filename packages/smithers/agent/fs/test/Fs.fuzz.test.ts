import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Arbitrary, Effect, Layer, Logger, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Command, CommandTree, Directive, FileRouter, FlowInvoker, FsError, Incur, Route } from "../src/index.ts"
import { hiddenRecordRoot, hiddenRuntimeRoot, routerRoot } from "./fixtureRoots.ts"
import { invalidModule, recordedImports, recordedModule, refinedModule, visibleModule } from "./modules.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "150"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const silentLayer = Logger.layer([])
const platformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, silentLayer)

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeRoute = (
  name: string,
  sourcePath = visibleModule,
  overrides: Partial<Route.Route> = {}
): Route.Route => ({
  name,
  segments: name.split("/"),
  kind: "module",
  sourcePath,
  description: Option.some(`${name} description`),
  input: new Descriptor.SchemaRefModule({ path: sourcePath, field: "input" }),
  output: new Descriptor.SchemaRefModule({ path: sourcePath, field: "output" }),
  capabilities: ["fs:read"],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  modelInvocable: true,
  placement: Option.none(),
  ui: Option.none(),
  ...overrides
})

describe("@smthrs/fs Directive, Route & CommandTree fuzz invariants", () => {
  it("Directive.compile and Route.snapshot validate valid routes and reject invalid/traversal/schema variants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        literal: Schema.Literals(["client", "local", "sandbox", "remote"]),
        seg: Schema.Literals(["alpha", "beta", "caf\u0065\u0301", ".", "..", "a/b"]),
        kind: Schema.Literals(["module", "markdown", "skill"]),
        schemaRefKind: Schema.Literals(["None", "MarkdownArgs", "MarkdownOutput", "Module", "Inline", "BadTag"]),
        relativeSource: Schema.Boolean,
        mismatchName: Schema.Boolean,
        modelInvocable: Schema.Boolean,
        mode: Schema.Literals(["hermetic", "expected"]),
        onConflict: Schema.Literals(["serialize", "lane", "fail"]),
        tier: Schema.Literals(["sealed", "compensable", "irreversible"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({
          literal,
          seg,
          kind,
          schemaRefKind,
          relativeSource,
          mismatchName,
          modelInvocable,
          mode,
          onConflict,
          tier
        }) =>
          Effect.gen(function*() {
            const placement = Directive.compile(literal)
            if (placement === undefined) return false

            const inputRef = schemaRefKind === "None"
              ? { _tag: "None" }
              : schemaRefKind === "MarkdownArgs"
              ? { _tag: "MarkdownArgs" }
              : schemaRefKind === "MarkdownOutput"
              ? { _tag: "MarkdownOutput" }
              : schemaRefKind === "Module"
              ? { _tag: "Module", path: "/flows/a.ts", field: "input" }
              : schemaRefKind === "Inline"
              ? { _tag: "Inline", document: { type: "object", properties: { n: { type: "number" } } } }
              : { _tag: "Bogus" }

            const route = {
              name: mismatchName ? "wrong-name" : seg,
              segments: [seg],
              kind,
              sourcePath: relativeSource ? "relative/flow.ts" : `/flows/${seg}/flow.ts`,
              description: Option.some("fuzz"),
              input: inputRef,
              output: { _tag: "None" },
              capabilities: ["fs:read"],
              effects: { reads: ["a"], writes: ["b"], mode, onConflict, tier },
              modelInvocable,
              placement: Option.some(literal),
              ui: Option.none()
            } as unknown as Route.Route
            const snapRes = yield* Effect.result(Route.snapshot(route))
            const badSeg = seg === "." || seg === ".." || seg.includes("/")
            const shouldFail = badSeg || relativeSource || mismatchName || schemaRefKind === "BadTag"
            if (shouldFail) return Result.isFailure(snapRes)
            if (Result.isFailure(snapRes)) return false
            const snap = snapRes.success
            if (snap.name !== seg.normalize("NFC") || snap.kind !== kind) return false
            if (Route.isCommandRoute(snap) !== (kind === "module" && modelInvocable)) return false
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)

    // Route.load valid & error paths (non-module, invalid module, missing file)
    await Effect.runPromise(
      Effect.gen(function*() {
        const loaded = yield* Route.load(makeRoute("review", visibleModule))
        expect(loaded.name).toBe("visible")
        const refLoaded = yield* Route.load(makeRoute("refined", refinedModule))
        expect(refLoaded.name).toBe("refined")

        const mdFail = yield* Effect.result(Route.load(makeRoute("doc", "/tmp/doc.md", { kind: "markdown" })))
        expect(Result.isFailure(mdFail) && mdFail.failure.code === "unsupported_body").toBe(true)

        const invFail = yield* Effect.result(Route.load(makeRoute("bad", invalidModule)))
        expect(Result.isFailure(invFail) && invFail.failure.code === "load_failed").toBe(true)

        const missFail = yield* Effect.result(Route.load(makeRoute("miss", "/nonexistent/path/flow.ts")))
        expect(Result.isFailure(missFail) && missFail.failure.code === "load_failed").toBe(true)
      })
    )
  })

  it("CommandTree.make, traverse, resolve (longest-prefix + NFC) & resolveExact obey trie invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        extraArgs: Schema.Array(Schema.Literals(["--flag", "val", "pos", ""])).pipe(
          Schema.check(Schema.isMaxLength(4))
        ),
        useNested: Schema.Boolean,
        useDecomposed: Schema.Boolean,
        unknownFirst: Schema.Boolean
      })
    )
    const tree = await Effect.runPromise(
      CommandTree.make([
        makeRoute("domains"),
        makeRoute("domains/list"),
        makeRoute("caf\u00e9")
      ])
    )
    expect(CommandTree.traverse(tree).map((r) => r.name)).toEqual(["caf\u00e9", "domains", "domains/list"])

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ extraArgs, useNested, useDecomposed, unknownFirst }) =>
          Effect.gen(function*() {
            if (unknownFirst) {
              const u = yield* Effect.result(CommandTree.resolve(tree, ["nope", ...extraArgs]))
              return Result.isFailure(u) && u.failure.code === "unknown_command"
            }
            const prefix = useDecomposed
              ? ["caf\u0065\u0301"]
              : useNested
              ? ["domains", "list"]
              : ["domains"]
            const expectedName = useDecomposed ? "caf\u00e9" : useNested ? "domains/list" : "domains"
            const argv = [...prefix, ...extraArgs]
            const resolved = yield* CommandTree.resolve(tree, argv)
            if (resolved.route.name !== expectedName) return false
            if (resolved.rest.length !== extraArgs.length) return false

            const exact = yield* Effect.result(CommandTree.resolveExact(tree, argv))
            if (extraArgs.length === 0) {
              return Result.isSuccess(exact) && exact.success.name === expectedName
            }
            return Result.isFailure(exact) && exact.failure.code === "unknown_command"
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)

    // Duplicate route, non-array, sparse array, oversized route count, invalid token NUL/empty
    await Effect.runPromise(
      Effect.gen(function*() {
        const dup = yield* Effect.result(CommandTree.make([makeRoute("a"), makeRoute("a")]))
        expect(Result.isFailure(dup) && dup.failure.code === "duplicate_route").toBe(true)

        const notArr = yield* Effect.result(CommandTree.make("bad" as unknown as ReadonlyArray<Route.Route>))
        expect(Result.isFailure(notArr) && notArr.failure.code === "invalid_route").toBe(true)

        const sparse = new Array<Route.Route>(2)
        sparse[0] = makeRoute("a")
        const spRes = yield* Effect.result(CommandTree.make(sparse))
        expect(Result.isFailure(spRes) && spRes.failure.code === "invalid_route").toBe(true)

        const nulTok = yield* Effect.result(CommandTree.resolve(tree, ["domains\0bad"]))
        expect(Result.isFailure(nulTok) && nulTok.failure.code === "parse_failed").toBe(true)

        const emptyFirst = yield* Effect.result(CommandTree.resolve(tree, [""]))
        expect(Result.isFailure(emptyFirst) && emptyFirst.failure.code === "resource_limit").toBe(true)
      })
    )
  })
})

describe("@smthrs/fs Command, FlowInvoker, FileRouter & Incur fuzz invariants", () => {
  it("Command.make lex/parseFlags/execute/call & FlowInvoker enforce schema, quoting & boundary invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        num: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -50, maximum: 50 }))),
        enabledMode: Schema.Literals(["omit", "flag", "noflag", "eqTrue", "eqFalse"]),
        tags: Schema.Array(Schema.Literals(["alpha", "hello world", "a\\b", "x'y"])).pipe(
          Schema.check(Schema.isMaxLength(3))
        ),
        useSlash: Schema.Boolean,
        useSpecial: Schema.Boolean
      })
    )

    const surface = await Effect.runPromise(
      Command.make([
        makeRoute("group/review", visibleModule),
        makeRoute("refined", refinedModule),
        makeRoute("recorded", recordedModule),
        makeRoute("hidden", visibleModule, { modelInvocable: false }),
        makeRoute("doc", "/tmp/doc.md", { kind: "markdown" })
      ])
    )
    // Listing NEVER imports recordedModule and filters non-command routes
    expect(surface.list().map((c) => c.name)).toEqual(["group/review", "recorded", "refined"])
    expect(recordedImports()).toBe(0)

    const invokerLayer = Layer.succeed(FlowInvoker.FlowInvoker)(
      FlowInvoker.make({
        invoke: (invocation) =>
          Effect.sync(() => {
            if (invocation.name === "refined") return { accepted: true, number: 1 }
            const n = (invocation.input as { number: number }).number
            return { accepted: true, number: n }
          })
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ num, enabledMode, tags, useSlash, useSpecial }) =>
          Effect.gen(function*() {
            if (useSpecial) {
              const cmd = `refined --title 'hello\\world ${num}'`
              const parsed = yield* surface.parse(cmd)
              if ((parsed.input as { title: string }).title !== `hello\\world ${num}`) return false
              const out = yield* surface.execute(cmd).pipe(Effect.provide(invokerLayer))
              return JSON.stringify(out) === JSON.stringify({ accepted: true, number: 1 })
            }

            const parts: Array<string> = [useSlash ? "group/review" : "group review", `--number=${num}`]
            if (enabledMode === "flag") parts.push("--enabled")
            else if (enabledMode === "noflag") parts.push("--no-enabled")
            else if (enabledMode === "eqTrue") parts.push("--enabled=true")
            else if (enabledMode === "eqFalse") parts.push("--enabled=false")
            if (tags.length >= 2) {
              for (const tag of tags) {
                const escaped = tag.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
                parts.push("--tags", `"${escaped}"`)
              }
            }
            const cmd = parts.join(" ")
            const parsed = yield* surface.parse(cmd)
            const inp = parsed.input as { number: number; enabled?: boolean; tags?: ReadonlyArray<string> }
            if (inp.number !== num) return false
            if (enabledMode === "flag" || enabledMode === "eqTrue") {
              if (inp.enabled !== true) return false
            } else if (enabledMode === "noflag" || enabledMode === "eqFalse") {
              if (inp.enabled !== false) return false
            }
            const out = yield* surface.execute(cmd).pipe(Effect.provide(invokerLayer))
            if (JSON.stringify(out) !== JSON.stringify({ accepted: true, number: num })) return false

            const called = yield* surface.call("group/review", { number: num }).pipe(Effect.provide(invokerLayer))
            return JSON.stringify(called) === JSON.stringify({ accepted: true, number: num })
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)

    // Cover parse errors, reserved flags, end-of-flags, refinement decode failure, FlowInvoker errors & sanitization
    await Effect.runPromise(
      Effect.gen(function*() {
        expect(Result.isFailure(yield* Effect.result(surface.parse("group review --number 'unterminated")))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(surface.parse("group review --__proto__=1")))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(surface.parse("group review --123bad=1")))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(surface.parse("group review -- pos1")))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(surface.parse("refined --title ''")))).toBe(true)

        // Command.call boundary & output validation failures
        const badCall = yield* Effect.result(
          surface.call("group/review", { number: Number.NaN }).pipe(Effect.provide(invokerLayer))
        )
        expect(Result.isFailure(badCall) && badCall.failure.code === "decode_failed").toBe(true)

        // FlowInvoker noop & defect sanitization
        const noopErr = yield* Effect.result(
          surface.execute("group review --number 7").pipe(Effect.provide(FlowInvoker.layerNoop()))
        )
        expect(Result.isFailure(noopErr) && noopErr.failure.code === "invocation_unavailable").toBe(true)

        const dyingLayer = Layer.succeed(FlowInvoker.FlowInvoker)(
          FlowInvoker.make({ invoke: () => Effect.die(new Error("secret crash")) })
        )
        const sanitized = yield* Effect.result(
          surface.execute("group review --number 7").pipe(Effect.provide(dyingLayer))
        )
        expect(Result.isFailure(sanitized) && sanitized.failure.code === "invocation_unavailable").toBe(true)

        // FlowInvoker invalid constructors throw TypeError
        expect(() => FlowInvoker.make({} as unknown as FlowInvoker.FlowInvoker.Shape)).toThrow(TypeError)
        expect(() => FlowInvoker.make(null as unknown as FlowInvoker.FlowInvoker.Shape)).toThrow(TypeError)
        const inherited = Object.create({ invoke: () => Effect.succeed(1) })
        expect(() => FlowInvoker.makeNoop(inherited as Partial<FlowInvoker.FlowInvoker.Shape>)).toThrow(TypeError)
        const accessor = Object.defineProperty({}, "invoke", { get: () => () => Effect.succeed(1) })
        expect(() => FlowInvoker.make(accessor as unknown as FlowInvoker.FlowInvoker.Shape)).toThrow(TypeError)
      }).pipe(Effect.provide(silentLayer))
    )
  })

  it("FileRouter.scan discovers real fixtures, rejects hidden/bad roots, and Incur.createCli serves commands & discovery", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        // FileRouter.scan on routerRoot, hiddenRuntimeRoot, hiddenRecordRoot
        const scanned = yield* FileRouter.scan({ root: routerRoot })
        expect(scanned.routes.length).toBeGreaterThanOrEqual(5)
        expect(scanned.routes.some((r) => Option.isSome(r.ui))).toBe(true)
        expect(scanned.routes.some((r) => r.kind === "skill")).toBe(true)
        expect(scanned.warnings.length).toBeGreaterThan(0)

        // Hidden runtime & hidden record flows fail Route.load when marked modelInvocable: true
        const hRun = yield* FileRouter.scan({ root: hiddenRuntimeRoot })
        for (const r of hRun.routes) {
          if (r.kind === "module") {
            const forced = { ...r, modelInvocable: true }
            const res = yield* Effect.result(Route.load(forced))
            expect(Result.isFailure(res)).toBe(true)
          }
        }
        const hRec = yield* FileRouter.scan({ root: hiddenRecordRoot })
        for (const r of hRec.routes) {
          if (r.kind === "module") {
            const forced = { ...r, modelInvocable: true }
            const res = yield* Effect.result(Route.load(forced))
            expect(Result.isSuccess(res)).toBe(r.modelInvocable)
          }
        }

        // Invalid & missing roots
        const missRoot = yield* Effect.result(FileRouter.scan({ root: "/nonexistent/smithers/fs/root" }))
        expect(Result.isFailure(missRoot) && missRoot.failure.code === "root_missing").toBe(true)
        const emptyRoot = yield* Effect.result(FileRouter.scan({ root: "" }))
        expect(Result.isFailure(emptyRoot) && emptyRoot.failure.code === "invalid_root").toBe(true)
        const fileAsRoot = yield* Effect.result(FileRouter.scan({ root: visibleModule }))
        expect(Result.isFailure(fileAsRoot) && fileAsRoot.failure.code === "invalid_root").toBe(true)

        // Incur.createCli: grouped + ungrouped routes, serve, fetch GET/POST, --llms discovery, refuse, close
        const invokerLayer = Layer.succeed(FlowInvoker.FlowInvoker)(
          FlowInvoker.make({
            invoke: (inv) => {
              if (inv.name === "fail") {
                return Effect.fail(
                  new FsError.FsError({ code: "invocation_unavailable", method: "test", description: "nope" })
                )
              }
              if (inv.name === "domains/sub") return Effect.succeed({ accepted: true, number: 77 })
              return Effect.succeed({ accepted: true, number: (inv.input as { number: number }).number })
            }
          })
        )

        // Reserved self segment conflict fails createCli
        const dupSelf = yield* Effect.result(
          Incur.createCli("flows", [
            makeRoute("domains"),
            makeRoute(`domains/${Incur.selfSegment}`)
          ]).pipe(Effect.provide(invokerLayer))
        )
        expect(Result.isFailure(dupSelf) && dupSelf.failure.code === "duplicate_route").toBe(true)

        const cli = yield* Incur.createCli("flows", [
          makeRoute("review", visibleModule),
          makeRoute("domains", visibleModule),
          makeRoute("domains/sub", refinedModule),
          makeRoute("fail", visibleModule)
        ]).pipe(Effect.provide(invokerLayer))

        try {
          const capture = () => {
            const writes: Array<string> = []
            const exits: Array<number> = []
            return {
              writes,
              exits,
              options: {
                stdout: (chunk: string) => {
                  writes.push(chunk)
                },
                exit: (code: number) => {
                  exits.push(code)
                }
              }
            }
          }

          // Serve normal route
          const run1 = capture()
          yield* Effect.promise(() =>
            cli.serve(["review", "--number", "42", "--enabled=true", "--format", "json"], run1.options)
          )
          expect(run1.writes.join("")).toContain("42")

          // Serve grouped self route & sub route
          const runSelf = capture()
          yield* Effect.promise(() =>
            cli.serve(["domains", Incur.selfSegment, "--number", "9", "--format", "json"], runSelf.options)
          )
          expect(runSelf.writes.join("")).toContain("9")

          const runSub = capture()
          yield* Effect.promise(() =>
            cli.serve(["domains", "sub", "--title", "hi", "--format", "json"], runSub.options)
          )
          expect(runSub.writes.join("")).toContain("77")

          // Serve erroring route -> refuse
          const runFail = capture()
          yield* Effect.promise(() => cli.serve(["fail", "--number", "1", "--format", "json"], runFail.options))
          expect(runFail.exits).toContain(1)

          // HTTP GET & POST via cli.fetch
          const getRes = yield* Effect.promise(() => cli.fetch(new Request("http://localhost/review?number=11")))
          expect(getRes.status).toBe(200)
          const postRes = yield* Effect.promise(() =>
            cli.fetch(
              new Request("http://localhost/review", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ number: 12, enabled: true })
              })
            )
          )
          expect(postRes.status).toBe(200)

          // Discovery (--llms) exercises projectAll
          const runLlms = capture()
          yield* Effect.promise(() => cli.serve(["--llms"], runLlms.options))
          expect(runLlms.writes.join("")).toContain("review")
        } finally {
          yield* Effect.promise(() => cli.close())
        }
      }).pipe(Effect.provide(platformLayer))
    )
  })
})
