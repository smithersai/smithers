import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Fault } from "@smthrs/flow"
import { Unreachable } from "@smthrs/kernel"
import { Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  hostFailed,
  output,
  repository,
  ridingOutages,
  run,
  staleWorkspace,
  tail,
  workspaceName,
  workspaceOf,
  workspaces
} from "../host.ts"

import { withRetryInstance, withRetryRuntime } from "./retry-runtime.ts"

const outageOptions = (name: string) => ({
  name: `issue-sweep/test/${name}`,
  implementationVersion: "host-test/v1",
  idempotencyKey: name,
  success: Schema.String,
  error: Schema.Struct({
    message: Schema.String,
    code: Schema.optional(Schema.Number),
    detail: Schema.optional(Schema.String),
    _tag: Schema.optional(Schema.String)
  })
})

const refused = (stderr: string) => ({ stdout: "", stderr, code: 255 })
const sibling = "Internal error: The repo was loaded at operation 3798008d8429, which seems to be a sibling of " +
  "the working copy's operation baea8ee8ed27\nHint: Run `jj op integrate baea8ee8ed27`"

// #3228: one such refusal failed a workspace and stopped the whole round.
test("a jj -R command refused for a sibling or stale working-copy operation names its workspace", () => {
  assert.equal(staleWorkspace(["-R", "/w/issue-1", "log", "-r", "@"], refused(sibling)), "/w/issue-1")
  assert.equal(
    staleWorkspace(["-R", "/w/issue-2", "st"], refused("Error: The working copy is stale (not updated since op 1)")),
    "/w/issue-2"
  )
})

test("other failures, successes and commands without -R are left alone", () => {
  assert.equal(staleWorkspace(["-R", "/w", "log"], refused("Error: Revision `x` doesn't exist")), undefined)
  assert.equal(staleWorkspace(["-R", "/w", "log"], { stdout: "", stderr: sibling, code: 0 }), undefined)
  assert.equal(staleWorkspace(["git", "fetch"], refused(sibling)), undefined)
  assert.equal(staleWorkspace(["-R"], refused(sibling)), undefined)
})

// 2026-10-01: a 75-minute DNS outage failed 109 landings and 9 adoptions as final.
const dns = "Error: Git process failed: External git program failed: fatal: unable to access " +
  "'https://github.com/smithersai/smithers.git/': Could not resolve host: github.com"

test("a failure names a network outage only when git or curl says the network failed", () => {
  assert.equal(Unreachable.classifyExit(dns) instanceof Unreachable.Unreachable, true)
  assert.equal(
    Unreachable.classifyExit("fatal: Failed to connect to github.com port 443: Operation timed out") instanceof
      Unreachable.Unreachable,
    true
  )
  assert.equal(Unreachable.classifyExit("Error: Revision `main@origin` doesn't exist"), undefined)
  assert.equal(Unreachable.classifyExit("! [rejected] main -> main (fetch first)"), undefined)
})

test("a network outage retries with transient backoff; other failures fail at once", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      let calls = 0
      const flaky = Effect.suspend(() => ++calls < 3 ? Effect.fail({ message: dns }) : Effect.succeed("fetched"))
      const fiber = yield* ridingOutages(flaky, outageOptions("flaky")).pipe(Effect.forkChild)
      yield* TestClock.adjust(4999)
      assert.equal(calls, 1)
      yield* TestClock.adjust(1)
      assert.equal(calls, 2)
      yield* TestClock.adjust(10000)
      assert.equal(yield* Fiber.join(fiber), "fetched")
      assert.equal(calls, 3)
      let refusals = 0
      const failure = { message: "conflict in a.txt", detail: "original typed error" }
      const refused = Effect.suspend(() => (refusals++, Effect.fail(failure)))
      const exit = yield* ridingOutages(refused, outageOptions("refused")).pipe(Effect.exit)
      assert.ok(Exit.isFailure(exit))
      assert.equal(refusals, 1)
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        assert.deepEqual(reason?._tag === "Fail" && reason.error, failure)
      }
    }).pipe(withRetryRuntime, Effect.provide(TestClock.layer()))
  )
})

test("identical network commands run at each invocation and replay without running again", async () => {
  let commands = 0
  const fetch = () => ridingOutages(Effect.sync(() => `fetched-${++commands}`), outageOptions("fetch"))
  const sequence = () => Effect.all([fetch(), fetch()], { concurrency: 1 }).pipe(withRetryInstance)
  await Effect.runPromise(
    Effect.gen(function*() {
      assert.deepEqual(yield* sequence(), ["fetched-1", "fetched-2"])
      assert.equal(commands, 2)
      assert.deepEqual(yield* sequence(), ["fetched-1", "fetched-2"])
      assert.equal(commands, 2)
    }).pipe(Effect.provide(FlowEngine.layerMemory), Effect.provide(NodeCrypto.layer))
  )
})

test("exhausting transient retries restores the final original typed host error", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      let attempts = 0
      let last: { message: string; code: number } | undefined
      const failed = Effect.suspend(() => {
        last = { message: dns, code: ++attempts }
        return Effect.fail(last)
      })
      const fiber = yield* ridingOutages(failed, outageOptions("failed")).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(7200000)
      const exit = yield* Fiber.join(fiber)
      assert.ok(Exit.isFailure(exit))
      assert.ok(attempts > 20)
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        assert.deepEqual(reason?._tag === "Fail" && reason.error, last)
      }
    }).pipe(withRetryRuntime, Effect.provide(TestClock.layer()))
  )
})

test("network signatures retry even when the original host error is registered as a bug", async () => {
  Fault.register("test/HostOutageBug", "bug")
  await Effect.runPromise(
    Effect.gen(function*() {
      let attempts = 0
      const failure = { _tag: "test/HostOutageBug", message: dns }
      const fiber = yield* ridingOutages(
        Effect.suspend(() =>
          ++attempts < 3
            ? Effect.fail(failure) :
            Effect.succeed("recovered")
        ),
        outageOptions("registered-bug")
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust(15000)
      assert.equal(yield* Fiber.join(fiber), "recovered")
      assert.equal(attempts, 3)
      assert.equal(Fault.of(failure).class, "bug")
    }).pipe(withRetryRuntime, Effect.provide(TestClock.layer()))
  )
})

test("host process output, failures and workspace helpers retain their contracts", async () => {
  assert.equal(await Effect.runPromise(output("sh", ["-c", "printf hello"])), "hello")
  assert.equal((await Effect.runPromise(run("sh", ["-c", "exit 7"]))).code, 7)
  for (
    const [command, args] of [["sh", ["-c", "echo refused >&2; exit 1"]], ["nodejj-missing-command", []], [
      "false",
      []
    ]] as const
  ) {
    const result = await Effect.runPromise(Effect.result(output(command, args)))
    assert.equal(result._tag, "Failure")
  }
  assert.equal(hostFailed(dns).code, "unreachable")
  assert.equal(tail("a\nb\nc\n", 2), "b\nc")
  assert.equal(workspaceName(12), "sweep-12")
  assert.equal(workspaceOf(12), `${workspaces}/issue-12`)
  assert.ok(repository.endsWith("/smithers"))
})

for (const mode of ["root", "cwd", "locked"] as const) {
  const useRoot = mode !== "cwd"
  test(`stale host jj fails without recovery or retry (${mode})`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "sweep-stale-"))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const binary = join(root, "jj")
    if (mode === "locked") {
      writeFileSync(join(root, "lockf"), "#!/bin/sh\nshift 4\nexec \"$@\"\n", { mode: 0o755 })
    }
    writeFileSync(
      binary,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${root}/calls"
echo "Error: The working copy is stale (not updated since op 1)" >&2
exit 255
`,
      { mode: 0o755 }
    )
    writeFileSync(join(root, "precious"), "keep")
    const result = await Effect.runPromise(Effect.result(run(mode === "locked" ? "lockf" : "jj", [
      ...(mode === "locked" ? ["-k", "-t", "900", join(root, "lock"), "jj"] : []),
      ...(useRoot ? ["-R", root, "status"] : ["status"])
    ], {
      ...(useRoot ? {} : { cwd: root }),
      env: { PATH: `${root}:${process.env.PATH}` }
    })))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "stale_workspace")
      assert.ok(result.failure.message.includes(root))
      assert.ok(result.failure.message.includes("commit or back up"))
    }
    const calls = readFileSync(join(root, "calls"), "utf8").trim().split("\n")
    assert.equal(calls.length, 1)
    assert.ok(calls[0]!.includes("snapshot.auto-update-stale=false"))
    assert.equal(readFileSync(join(root, "precious"), "utf8"), "keep")
  })
}

test("unrelated lockf commands retain their original result", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sweep-lockf-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, "lockf"), "#!/bin/sh\nprintf unchanged\n", { mode: 0o755 })
  assert.equal(
    await Effect.runPromise(output("lockf", [], { env: { PATH: `${root}:${process.env.PATH}` } })),
    "unchanged"
  )
})
