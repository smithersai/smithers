import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { CheckFailed, layer, Smoketest } from "../../../examples/use-cases/smoketest.vibe"

const directory = mkdtempSync(join(tmpdir(), "smoketest-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** The smoke test calls no agent. */
const noAgents: Kit.Script = () => undefined

type Outcome = { readonly passed: boolean; readonly error?: string } | "cannot-run"

/**
 * A host whose setup reports `ready`, and whose check `name` settles with
 * `outcomes[name]` (passing when unnamed). Each check's duration is its
 * command's length, so the report's sum is checkable. Every request is
 * recorded in order.
 */
const host = (ready: boolean, outcomes: Readonly<Record<string, Outcome>> = {}) => {
  const log: Array<string> = []
  const actions = layer({
    setup: ({ directory, setupCmd }) =>
      Effect.sync(() => {
        log.push(`setup ${setupCmd} in ${directory}`)
        return { environment: directory, ready, details: ready ? "installed" : "registry unreachable" }
      }),
    runCheck: ({ cmd, directory, name, timeoutMs }) =>
      Effect.suspend(() => {
        log.push(`check ${name}: ${cmd} in ${directory} within ${timeoutMs}`)
        const outcome = outcomes[name] ?? { passed: true }
        return outcome === "cannot-run"
          ? Effect.fail(new CheckFailed({ name, reason: `ran past ${timeoutMs}ms` }))
          : Effect.succeed({
            name,
            passed: outcome.passed,
            duration: cmd.length,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
            output: ""
          })
      })
  })
  return { actions, log }
}

it.effect("runs the default checks after a ready setup and reports what they returned", () =>
  Effect.gen(function*() {
    const { actions, log } = host(true, {
      lint: { passed: false, error: "2 problems" },
      test: "cannot-run"
    })
    const report = yield* Kit.run(Smoketest, { directory: "app" }, {
      filename: join(directory, "defaults.sqlite"),
      executionId: "smoketest-defaults",
      script: noAgents,
      actions
    })

    expect(log[0]).toBe("setup npm install in app")
    expect([...log.slice(1)].sort()).toEqual([
      "check build: npm run build in app within 120000",
      "check lint: npx eslint . in app within 120000",
      "check test: npm test in app within 120000",
      "check typecheck: npx tsc --noEmit in app within 120000"
    ])
    // The check that could not run is dropped, not failed, as 0.x's continueOnFail did.
    expect(report).toEqual({
      totalChecks: 3,
      passed: 2,
      failed: 1,
      duration: "npx tsc --noEmit".length + "npx eslint .".length + "npm run build".length,
      verdict: "fail",
      failures: ["lint: 2 problems"],
      summary: "2/3 checks passed"
    })
  }))

it.effect("runs no checks when setup is not ready, and the empty report passes as in 0.x", () =>
  Effect.gen(function*() {
    const { actions, log } = host(false)
    const report = yield* Kit.run(Smoketest, { directory: "app", setupCmd: "pnpm install" }, {
      filename: join(directory, "not-ready.sqlite"),
      executionId: "smoketest-not-ready",
      script: noAgents,
      actions
    })

    expect(log).toEqual(["setup pnpm install in app"])
    expect(report).toEqual({
      totalChecks: 0,
      passed: 0,
      failed: 0,
      duration: 0,
      verdict: "pass",
      failures: [],
      summary: "0/0 checks passed"
    })
  }))

it.effect("runs the given checks one at a time and names a failure that carries no error", () =>
  Effect.gen(function*() {
    const { actions, log } = host(true, { e2e: { passed: false } })
    const report = yield* Kit.run(Smoketest, {
      directory: "web",
      checks: [{ name: "unit", cmd: "pnpm vitest run" }, { name: "e2e", cmd: "pnpm playwright test" }],
      maxParallel: 1,
      timeoutMs: 5_000
    }, {
      filename: join(directory, "given.sqlite"),
      executionId: "smoketest-given",
      script: noAgents,
      actions
    })

    expect(log).toEqual([
      "setup npm install in web",
      "check unit: pnpm vitest run in web within 5000",
      "check e2e: pnpm playwright test in web within 5000"
    ])
    expect(report).toMatchObject({
      totalChecks: 2,
      passed: 1,
      failed: 1,
      verdict: "fail",
      failures: ["e2e: failed"],
      summary: "1/2 checks passed"
    })
  }))
