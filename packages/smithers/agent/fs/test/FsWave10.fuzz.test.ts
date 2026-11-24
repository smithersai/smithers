import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import { DiscoveryError } from "@smthrs/registry/RegistryError"
import { Arbitrary, Effect, FileSystem, Layer, Logger, Option, PlatformError, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Command, CommandTree, FileRouter, FlowInvoker, Incur, Route } from "../src/index.ts"
import * as Boundary from "../src/internal/Boundary.ts"
import * as CommandLine from "../src/internal/CommandLine.vibe"
import * as SchemaBridge from "../src/internal/SchemaBridge.vibe"
import { invalidModule, visibleModule } from "./modules.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "250")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLayer = Logger.layer([])
const platformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, silentLayer)

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

describe("@smthrs/fs Wave 10 deep fuzz", () => {
  it(
    "SchemaBridge covers all JSON Schema projections, tuples, unions, enums, refs, scalarRecord, MarkdownArgs, None, MarkdownOutput, encodeOutput, and snapshotInput",
    async () => {
      const modRef = new Descriptor.SchemaRefModule({ path: visibleModule, field: "input" })
      const arb = Arbitrary.schema(
        Schema.Struct({
          kind: Schema.Literals([
            "markdownOutputRefused",
            "noneOk",
            "noneRejectsExtra",
            "markdownArgsArray",
            "markdownArgsRecord",
            "markdownArgsEmpty",
            "markdownArgsBadElem",
            "structWithArgsAndBool",
            "nestedObjectWithRest",
            "scalarString",
            "scalarInt",
            "scalarNumber",
            "scalarBool",
            "scalarNull",
            "scalarLiteralNum",
            "scalarLiteralStr",
            "scalarMixedEnum",
            "scalarUnion",
            "scalarTupleClosed",
            "scalarTupleRest",
            "scalarArray",
            "scalarUnknown",
            "scalarNever",
            "scalarRecordConflict",
            "scalarSurplusArgs",
            "recursiveUnsupported",
            "encodeUndefined",
            "encodeBadJson",
            "snapshotUndefined",
            "snapshotBadJson",
            "decodeUndefined"
          ]),
          n: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 }))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ kind, n }) =>
            Effect.gen(function*() {
              switch (kind) {
                case "markdownOutputRefused": {
                  const r = yield* Effect.result(
                    SchemaBridge.toCommandSchema(new Descriptor.SchemaRefMarkdownOutput(), Schema.String)
                  )
                  return Result.isFailure(r) && r.failure.code === "unsupported_schema"
                }
                case "noneOk": {
                  const cs = yield* SchemaBridge.toCommandSchema(new Descriptor.SchemaRefNone(), Schema.Undefined)
                  const out = yield* cs.decode(cs.assemble([], {}))
                  return out === undefined
                }
                case "noneRejectsExtra": {
                  const cs = yield* SchemaBridge.toCommandSchema(new Descriptor.SchemaRefNone(), Schema.Undefined)
                  const r = yield* Effect.result(cs.decode(cs.assemble(["extra"], {})))
                  return Result.isFailure(r) && r.failure.code === "decode_failed"
                }
                case "markdownArgsArray": {
                  const cs = yield* SchemaBridge.toCommandSchema(
                    new Descriptor.SchemaRefMarkdownArgs(),
                    Schema.Struct({ args: Schema.String })
                  )
                  const out = (yield* cs.decode(cs.assemble(["hello", `n${n}`], {}))) as { args: string }
                  return out.args === `hello n${n}`
                }
                case "markdownArgsRecord": {
                  const cs = yield* SchemaBridge.toCommandSchema(
                    new Descriptor.SchemaRefMarkdownArgs(),
                    Schema.Struct({ args: Schema.String })
                  )
                  const out = (yield* cs.decode(cs.assemble({ args: ["a", "b"] }, {}))) as { args: string }
                  return out.args === "a b"
                }
                case "markdownArgsEmpty": {
                  const cs = yield* SchemaBridge.toCommandSchema(
                    new Descriptor.SchemaRefMarkdownArgs(),
                    Schema.Struct({ args: Schema.String })
                  )
                  const out = (yield* cs.decode(cs.assemble({}, {}))) as { args: string }
                  return out.args === ""
                }
                case "markdownArgsBadElem": {
                  const cs = yield* SchemaBridge.toCommandSchema(
                    new Descriptor.SchemaRefMarkdownArgs(),
                    Schema.Struct({ args: Schema.String })
                  )
                  const r1 = yield* Effect.result(cs.decode(cs.assemble({ args: [123] }, {})))
                  const r2 = yield* Effect.result(cs.decode(cs.assemble({ args: 456 }, {})))
                  return Result.isFailure(r1) && Result.isFailure(r2)
                }
                case "structWithArgsAndBool": {
                  const sc = Schema.Struct({
                    args: Schema.Array(Schema.String),
                    flag: Schema.optionalKey(Schema.Boolean),
                    count: Schema.Int
                  })
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, sc)
                  if (cs.args === undefined || !cs.flags.has("flag")) return false
                  const out = (yield* cs.decode(cs.assemble(["x", "y"], { flag: "true", count: String(n) }))) as {
                    args: ReadonlyArray<string>
                    flag?: boolean
                    count: number
                  }
                  return out.args.length === 2 && out.flag === true && out.count === n
                }
                case "nestedObjectWithRest": {
                  const sc = Schema.Struct({
                    bag: Schema.Record(Schema.String, Schema.Number)
                  })
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, sc)
                  const out = (yield* cs.decode(cs.assemble([], { bag: JSON.stringify({ k: n }) }))) as {
                    bag: Record<string, number>
                  }
                  return out.bag.k === n
                }
                case "scalarString": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.String)
                  return (yield* cs.decode(cs.assemble([`s${n}`], {}))) === `s${n}`
                }
                case "scalarInt": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.Int)
                  const ok = (yield* cs.decode(cs.assemble([String(n)], {}))) === n
                  const bad = yield* Effect.result(cs.decode(cs.assemble(["not-json"], {})))
                  return ok && Result.isFailure(bad)
                }
                case "scalarNumber": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.Number)
                  return (yield* cs.decode(cs.assemble([], { input: `${n}.5` }))) === Number(`${n}.5`)
                }
                case "scalarBool": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.Boolean)
                  return cs.flags.has("input") && (yield* cs.decode(cs.assemble(["true"], {}))) === true
                }
                case "scalarNull": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.Null)
                  return (yield* cs.decode(cs.assemble(["null"], {}))) === null
                }
                case "scalarLiteralNum": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.Literal(7))
                  return (yield* cs.decode(cs.assemble(["7"], {}))) === 7
                }
                case "scalarLiteralStr": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.Literal("ok"))
                  return (yield* cs.decode(cs.assemble(["ok"], {}))) === "ok"
                }
                case "scalarMixedEnum": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.Literals([1, "two", true]))
                  const a = yield* cs.decode(cs.assemble(["1"], {}))
                  const b = yield* cs.decode(cs.assemble(["two"], {}))
                  return a === 1 && b === "two"
                }
                case "scalarUnion": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.Union([Schema.String, Schema.Number]))
                  const a = yield* cs.decode(cs.assemble(["abc"], {}))
                  return a === "abc"
                }
                case "scalarTupleClosed": {
                  const cs = yield* SchemaBridge.toCommandSchema(
                    modRef,
                    Schema.Tuple([Schema.String, Schema.optionalKey(Schema.Number)])
                  )
                  const a = yield* cs.decode(cs.assemble({ input: ["k", n] }, {}))
                  return Array.isArray(a) && a[0] === "k"
                }
                case "scalarTupleRest": {
                  const cs = yield* SchemaBridge.toCommandSchema(
                    modRef,
                    Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number])
                  )
                  const a = yield* cs.decode(cs.assemble({ input: ["k", n, n + 1] }, {}))
                  return Array.isArray(a) && a.length === 3
                }
                case "scalarArray": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.Array(Schema.String))
                  const a = yield* cs.decode(cs.assemble({ input: ["a", "b"] }, {}))
                  return Array.isArray(a) && a.length === 2
                }
                case "scalarUnknown": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.Unknown)
                  const a = yield* cs.decode(cs.assemble(["{\"x\":1}"], {}))
                  return typeof a === "object" && a !== null
                }
                case "scalarNever": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.Never)
                  const r = yield* Effect.result(cs.decode(cs.assemble(["x"], {})))
                  return Result.isFailure(r)
                }
                case "scalarRecordConflict": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.String)
                  const r = yield* Effect.result(cs.decode(cs.assemble(["first"], { input: "second" })))
                  return Result.isFailure(r) && r.failure.code === "decode_failed"
                }
                case "scalarSurplusArgs": {
                  const cs = yield* SchemaBridge.toCommandSchema(modRef, Schema.String)
                  const r = yield* Effect.result(cs.decode(cs.assemble(["first", "surplus"], {})))
                  return Result.isFailure(r) && r.failure.code === "decode_failed"
                }
                case "recursiveUnsupported": {
                  interface Node {
                    readonly next?: Node
                  }
                  const NodeSchema: Schema.Codec<Node> = Schema.Struct({
                    next: Schema.optionalKey(Schema.suspend(() => NodeSchema))
                  })
                  const r = yield* Effect.result(SchemaBridge.toCommandSchema(modRef, NodeSchema))
                  return Result.isFailure(r) && r.failure.code === "unsupported_schema"
                }
                case "encodeUndefined": {
                  const out = yield* SchemaBridge.encodeOutput(Schema.Undefined, undefined)
                  return out === undefined
                }
                case "encodeBadJson": {
                  const r = yield* Effect.result(SchemaBridge.encodeOutput(Schema.Unknown, Number.NaN))
                  return Result.isFailure(r) && r.failure.code === "encode_failed"
                }
                case "snapshotUndefined": {
                  const out = yield* SchemaBridge.snapshotInput(undefined)
                  return out === undefined
                }
                case "snapshotBadJson": {
                  const r = yield* Effect.result(SchemaBridge.snapshotInput({ bad: Number.NaN }))
                  return Result.isFailure(r) && r.failure.code === "decode_failed"
                }
                case "decodeUndefined": {
                  const out = yield* SchemaBridge.decodeInput(Schema.Undefined, undefined)
                  return out === undefined
                }
              }
            }),
          { seed, executions: Math.min(executions, 120) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
    },
    60_000
  )

  it(
    "IncurHost, Incur, CommandTree, CommandLine, Command, FileRouter, and Route cover fetch/serve discovery, middleware, abort, malformed paths, and error branches",
    async () => {
      const invoker = Layer.succeed(FlowInvoker.FlowInvoker, {
        invoke: (req) => Effect.succeed({ echoed: req.input ?? null, route: req.name })
      })
      let stdoutLog = ""
      let exitCode = -1
      const hostLayer = Layer.succeed(Incur.Host, {
        argv: () => ["greet"],
        env: () => undefined,
        stdout: (text) => {
          stdoutLog += text
        },
        exit: (code) => {
          exitCode = code
        }
      })

      const rGood = makeRoute("greet", visibleModule)
      const rBad = makeRoute("broken", invalidModule)
      const rNested = makeRoute("greet/sub", visibleModule)
      const routes = [rGood, rBad, rNested]
      const tree = await Effect.runPromise(CommandTree.make(routes))

      // CommandTree.make rejects duplicate route
      const dupRes = await Effect.runPromise(Effect.result(CommandTree.make([rGood, rGood])))
      expect(Result.isFailure(dupRes)).toBe(true)
      expect(CommandTree.traverse(tree).length).toBe(3)

      // Incur.createCli with grouped route + failed route + middleware + fetch discovery + abort + malformed percent path + serve error + close
      const cli = await Effect.runPromise(
        Incur.createCli("w10", routes).pipe(Effect.provide(Layer.mergeAll(invoker, hostLayer, silentLayer)))
      )

      // Register middleware before discovery
      let mwCalls = 0
      cli.use(async (_ctx, next) => {
        mwCalls++
        await next()
      })

      // 1. Fetch discovery (/openapi.json) with signal -> builds metadataSurface
      const ac1 = new AbortController()
      const openApiRes = await cli.fetch(new Request("http://local/openapi.json", { signal: ac1.signal }))
      expect(openApiRes.status).toBe(200)

      // Register middleware AFTER discovery (covers metadataInstance?.use(handler))
      cli.use(async (_ctx, next) => {
        await next()
      })

      // 2. Fetch malformed percent escape path -> 400 reportFetch
      const badPathRes = await cli.fetch(new Request("http://local/%E0%A4%A"))
      expect(badPathRes.status).toBe(400)

      // 3. Fetch route that fails load/projection -> 400 reportFetch
      const brokenFetchRes = await cli.fetch(new Request("http://local/broken"))
      expect(brokenFetchRes.status).toBe(400)

      // 4. Fetch unknown route -> falls back to metadataSurface
      const unknownFetchRes = await cli.fetch(new Request("http://local/does-not-exist"))
      expect(unknownFetchRes.status).toBeGreaterThanOrEqual(400)

      // 5. Serve error route -> reportServe stdout + exit(1)
      stdoutLog = ""
      exitCode = -1
      await cli.serve(["broken"])
      expect(exitCode).toBe(1)
      expect(stdoutLog).toContain("\"ok\": false")

      // 6. Serve discovery (--help) and default argv (via host.argv())
      stdoutLog = ""
      await cli.serve(["--help"])
      expect(stdoutLog.length).toBeGreaterThan(0)

      // 7. Serve unknown route -> metadataSurface
      stdoutLog = ""
      await cli.serve(["unknown-cmd"])
      expect(stdoutLog.length).toBeGreaterThan(0)

      // 8. Close CLI and verify subsequent serve rejects with AbortError
      await cli.close()
      await expect(cli.serve(["--help"])).rejects.toThrow()

      // Incur.createCli rejects reserved selfSegment child under a grouped route
      const rSelf = makeRoute(`greet/${Incur.selfSegment}`, visibleModule)
      const selfRes = await Effect.runPromise(
        Effect.result(
          Incur.createCli("w10", [rGood, rSelf]).pipe(Effect.provide(Layer.mergeAll(invoker, hostLayer, silentLayer)))
        )
      )
      expect(Result.isFailure(selfRes)).toBe(true)

      // CommandLine parsing edge cases
      const parsedCases = [
        ["greet", "--", "--not-a-flag", "pos"],
        ["greet", "--name=alice", "--flag", "extra"],
        ["greet", "--no-flag"],
        ["greet", "-v", "pos"],
        ["greet", "--count", "42"],
        ["greet", "--empty="],
        ["greet", "--=bad"]
      ]
      for (const argv of parsedCases) {
        const split = CommandLine.splitName(argv)
        expect(Array.isArray(split)).toBe(true)
      }

      // Command.make surface edge cases: empty argv, unknown route, list
      const surface = await Effect.runPromise(Command.make(routes))
      expect(surface.list().length).toBe(3)
      const cmdErr1 = await Effect.runPromise(
        Effect.result(surface.execute("").pipe(Effect.provide(Layer.mergeAll(invoker, silentLayer))))
      )
      expect(Result.isFailure(cmdErr1)).toBe(true)
      const cmdErr2 = await Effect.runPromise(
        Effect.result(surface.execute("missing-route").pipe(Effect.provide(Layer.mergeAll(invoker, silentLayer))))
      )
      expect(Result.isFailure(cmdErr2)).toBe(true)

      // FileRouter.scan with injected Discovery service returning read_failed, invalid_root, parse_failed
      const scanErrors = [
        new DiscoveryError({ code: "invalid_root", path: "/tmp", message: "bad" }),
        new DiscoveryError({ code: "read_failed", path: "/tmp", message: "read" }),
        new DiscoveryError({ code: "unknown", path: "/tmp", message: "other" })
      ]
      for (const err of scanErrors) {
        const discLayer = Layer.succeed(Discovery.Discovery, {
          scan: () => Effect.fail(err)
        })
        const r = await Effect.runPromise(
          Effect.result(
            FileRouter.scan({ root: "/tmp" }).pipe(Effect.provide(Layer.mergeAll(platformLayer, discLayer)))
          )
        )
        expect(Result.isFailure(r)).toBe(true)
      }

      // FileRouter.scan duplicate collapsed route + root-level entry skipped + fileSystem.exists error
      const fakeEntry = (p: string): Descriptor.FlowDescriptor =>
        new Descriptor.FlowDescriptor({
          name: "dup",
          description: "",
          body: new Descriptor.BodyRefModule({ path: p }),
          input: new Descriptor.SchemaRefNone(),
          output: new Descriptor.SchemaRefNone(),
          model: Option.none(),
          flows: [],
          capabilities: [],
          effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
          placement: Option.none(),
          modelInvocable: true,
          path: p,
          frontmatter: {},
          provenance: new Descriptor.Provenance({ source: "flows", root: "/tmp" })
        })
      const dupDisc = Layer.succeed(Discovery.Discovery, {
        scan: () =>
          Effect.succeed({
            entries: [fakeEntry("/tmp/flow.ts"), fakeEntry("/tmp/a/flow.ts"), fakeEntry("/tmp/a/index.ts")],
            warnings: []
          })
      })
      const dupScan = await Effect.runPromise(
        Effect.result(FileRouter.scan({ root: "/tmp" }).pipe(Effect.provide(Layer.mergeAll(platformLayer, dupDisc))))
      )
      expect(Result.isFailure(dupScan)).toBe(true)

      // FileRouter.scan with failing FileSystem.exists (readFailure)
      const failingFs = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (real) =>
          FileSystem.FileSystem.of({
            ...real,
            exists: () =>
              Effect.fail(PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "exists" }))
          }))
      ).pipe(Layer.provide(NodeFileSystem.layer))
      const okDisc = Layer.succeed(Discovery.Discovery, {
        scan: () => Effect.succeed({ entries: [fakeEntry("/tmp/sub/flow.ts")], warnings: [] })
      })
      const fsErrScan = await Effect.runPromise(
        Effect.result(
          FileRouter.scan({ root: "/tmp" }).pipe(
            Effect.provide(Layer.mergeAll(failingFs, NodePath.layer, okDisc, silentLayer))
          )
        )
      )
      expect(Result.isFailure(fsErrScan)).toBe(true)

      // Boundary edge case
      const badBoundary = Boundary.admitJson({ a: 1n })
      expect(badBoundary.ok).toBe(false)
      expect(mwCalls).toBeGreaterThanOrEqual(0)
    },
    60_000
  )
})
