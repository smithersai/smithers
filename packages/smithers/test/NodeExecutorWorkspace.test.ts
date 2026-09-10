/**
 * A resumed history fork executes in its own checkout, so every capability the
 * executor equips the run with has to be equipped from that checkout. The test
 * runner is the one that grades the work: built from the project root instead,
 * the `test` flow runs against files the forked agent never touched and reports
 * the result as the fork's own.
 */
import { Control } from "@smthrs/control"
import type * as TestRunner from "@smthrs/std/TestRunner"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const observed = vi.hoisted(() => ({ runners: [] as Array<TestRunner.Runner | undefined> }))

// The declaration is built inside the executor's registration phase and handed
// to the flow sources, which no service exposes afterwards. Recording what the
// composition constructed is the only way to ask which tree it named.
vi.mock("../src/internal/NativeEquipment.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/internal/NativeEquipment.ts")>()
  return {
    ...actual,
    testRunner: (...parameters: Parameters<typeof actual.testRunner>) => {
      const runner = actual.testRunner(...parameters)
      observed.runners.push(runner)
      return runner
    }
  }
})

describe("NodeControl.layerExecutor over a fork's checkout", () => {
  it("declares the test runner against the workspace it executes in", async () => {
    const root = await mkdtemp(join(tmpdir(), "flows-cli-fork-runner-"))
    const workspace = join(root, ".flows", "forks", "child")
    try {
      await mkdir(workspace, { recursive: true })
      observed.runners.length = 0
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const executor = NodeControl.layerExecutor(registry, engine, root, {
        environment: { SMITHERS_TEST_COMMAND: "project-test-command" },
        executionRoot: workspace
      })
      // Building the composition runs the registration phase, which is where
      // the declaration is constructed.
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          yield* control.plan({ flowId: "system/test", input: {} })
        }).pipe(
          Effect.provide(Application.layer({}, registry, engine, executor) as Layer.Layer<Control.Control>),
          Effect.scoped,
          Effect.orDie
        )
      )

      // `TestRun` executes at `cwd` and checks the pristine baseline out of
      // `root`, so a fork's runner has to name the fork under both.
      expect(observed.runners.at(-1)).toEqual({
        command: "project-test-command",
        cwd: workspace,
        root: workspace
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
