import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as NodeBench from "../src/NodeBench.ts"
import * as Target from "../src/Target.ts"
import * as Verb from "../src/Verb.ts"
import * as VitestBench from "../src/VitestBench.ts"
import { plannedArgv, plannedCalls } from "./plan.ts"
import { packageManager, runtime } from "./toolchain.ts"

describe("VitestBench and NodeBench targets", () => {
  it("declares bench kind and Verb.Bench", () => {
    expect(Target.Kind.literals).toContain("bench")
    expect(Verb.Bench).toEqual({ name: "bench" })
    expect(Verb.all).not.toContain(Verb.Bench)
  })

  it("builds VitestBench arguments and honors cache attr", () => {
    const uncached = VitestBench.VitestBench({
      benches: [Input.glob("test/**/*.bench.ts")],
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      config: Input.file("vitest.config.ts"),
      environment: "node",
      cwd: "packages/example"
    })
    const cached = VitestBench.VitestBench({
      benches: [Input.glob("test/**/*.bench.ts")],
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      config: Input.file("vitest.config.ts"),
      environment: "jsdom",
      passWithNoTests: true,
      cache: true,
      hosts: ["darwin", "linux"],
      cwd: "packages/example"
    })

    const uncachedMeta = Target.metadata(uncached)
    const cachedMeta = Target.metadata(cached)
    expect(uncachedMeta.target).toBe("VitestBench")
    expect(uncachedMeta.kinds).toEqual(["bench"])
    expect(uncachedMeta.cacheable).toBe(false)
    expect(cachedMeta.cacheable).toBe(true)
    expect(cachedMeta.hosts).toEqual(["darwin", "linux"])

    const args = VitestBench.benchArguments(cachedMeta.attrs as VitestBench.Attrs)
    expect(args).toContain("bench")
    expect(args).toContain("--run")
    expect(args).toContain("--coverage.enabled=false")
    expect(args).toContain("--reporter=verbose")
    expect(args).toContain("--config")
    expect(args).toContain("vitest.config.ts")
    expect(args).toContain("--environment")
    expect(args).toContain("jsdom")
    expect(args).toContain("--passWithNoTests")
  })

  it("plans VitestBench execution through the declared package manager", () => {
    const target = VitestBench.VitestBench({
      packageManager,
      runtime,
      benches: [Input.glob("test/**/*.bench.ts")],
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      config: Input.file("vitest.config.ts"),
      environment: "node",
      cwd: "packages/example"
    })
    const calls = plannedCalls(target)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload["cwd"]).toBe("packages/example")
    expect(plannedArgv(target)).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "bench",
      "--run",
      "--coverage.enabled=false",
      "--reporter=verbose",
      "--config",
      "vitest.config.ts",
      "--environment",
      "node"
    ])
  })

  it("declares and plans NodeBench targets", () => {
    const target = NodeBench.NodeBench({
      runtime,
      entry: Input.file("bench/run.ts"),
      args: ["--quick"],
      timeout: "30s",
      srcs: [Input.glob("src/**/*.ts")],
      deps: [],
      cache: true,
      cwd: "apps/example"
    })
    const meta = Target.metadata(target)
    expect(meta.target).toBe("NodeBench")
    expect(meta.kinds).toEqual(["bench"])
    expect(meta.cacheable).toBe(true)

    const calls = plannedCalls(target)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload).toMatchObject({
      cwd: "apps/example",
      timeoutMs: 30_000
    })
    expect(plannedArgv(target)).toEqual(["node", "bench/run.ts", "--quick"])
  })
})
