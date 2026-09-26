/**
 * The workspace lifecycle against real local Microsandbox microVMs: seed a
 * fixture repository's commit into a sticky workspace machine, change it
 * through the same session a role task's tools use, collect the diff from
 * the guest, run the checks in a fresh machine with and without the patch,
 * land the change on a branch of the host repository, and remove the
 * machine.
 *
 * The suite boots real microVMs on a host with a hypervisor and names its
 * skip on a host without one. Every machine it boots carries an owner no
 * other run shares, and the sweep after it removes exactly those.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow, Interpreter } from "@smthrs/flow"
import * as MicrosandboxSandbox from "@smthrs/sandbox/MicrosandboxSandbox"
import { Cause, Effect, Layer } from "effect"
import * as Microsandbox from "microsandbox"
import { spawnSync } from "node:child_process"
import { afterAll, describe, expect, it } from "vitest"
import * as Actions from "../src/Actions.ts"
import * as Authority from "../src/Authority.ts"
import * as Process from "../src/internal/process.ts"
import * as Profile from "../src/Profile.ts"
import * as Workspace from "../src/Workspace.ts"
import {
  agentStack,
  type Asked,
  done,
  loadSnapshot,
  memoryServices,
  payloadFor,
  type Recorded,
  scripted,
  task
} from "./dispatchSupport.ts"
import { checkoutState, fixtureRepo, git } from "./workspaceSupport.ts"

const run = `organization-workspace-${process.pid}-${Date.now()}`
const owner = `smithers-test-${run}`
const holder = `holder-${run}`
const image = "node:26-bookworm"

const machines = Workspace.microsandbox({
  sdk: Microsandbox,
  image,
  cpus: 1,
  memoryMib: 1024,
  owner,
  holder,
  labels: { "smithers.test": run },
  maxDurationSecs: 900,
  idleTimeoutSecs: 600
})

/**
 * Why this host cannot boot a microVM, or `undefined` when it can: the
 * platform binary must run, the host must expose a hypervisor and not be a
 * guest itself, and one probe machine must boot. Only a positive reading of
 * a missing capability skips.
 */
const unbootable = async (): Promise<string | undefined> => {
  if (spawnSync("microsandbox", ["--version"], { stdio: "ignore" }).status !== 0) {
    return "the microsandbox platform binary does not run here"
  }
  if (process.platform === "darwin") {
    const sysctl = (name: string) => spawnSync("sysctl", ["-n", name], { encoding: "utf8" }).stdout.trim()
    if (sysctl("kern.hv_support") !== "1") return "this macOS host reports no Hypervisor.framework support"
    if (sysctl("kern.hv_vmm_present") === "1") return "this macOS host is itself a guest without nested virtualization"
  } else if (process.platform === "linux") {
    if (spawnSync("test", ["-r", "/dev/kvm", "-a", "-w", "/dev/kvm"]).status !== 0) {
      return "this Linux host exposes no usable /dev/kvm"
    }
  } else {
    return `microsandbox reaches no hypervisor on ${process.platform}`
  }
  Microsandbox.setDefaultBackend("local")
  const refusal = await Effect.runPromise(
    Effect.scoped(Effect.asVoid(machines.fresh(`${run}-probe`))).pipe(
      Effect.timeoutOption(300_000),
      Effect.as(undefined),
      Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause)))
    )
  )
  return refusal !== undefined && refusal.includes("VmSetup(VmCreate)")
    ? "this host's hypervisor refused to create a VM"
    : undefined
}

const missing = await unbootable()

describe.skipIf(missing === undefined)("Workspace against real microVMs", () => {
  it(`is skipped because ${missing ?? "this host boots microVMs"}`, () => {
    expect(missing).toEqual(expect.any(String))
  })
})

describe.skipIf(missing !== undefined)("Workspace against real microVMs", () => {
  afterAll(() =>
    Effect.runPromise(
      MicrosandboxSandbox.reap({ sdk: Microsandbox, owner, isAlive: () => Effect.succeed(false) })
    ), 120_000)

  const services = Workspace.layer({ machines, maxConcurrentVMs: 2 }).pipe(Layer.provideMerge(NodeServices.layer))
  const within = <A, E>(effect: Effect.Effect<A, E, Workspace.Workspace>) =>
    Effect.runPromise(effect.pipe(Effect.provide(services)))

  it("seeds, changes, collects, checks, lands, and disposes", async () => {
    const { repo, commit } = fixtureRepo()
    const before = checkoutState(repo)
    const key = `${run}/fixture/build`
    const log = (line: string) => console.log(`[microvm] ${line}`)

    const prepared = await within(
      Effect.flatMap(Workspace.Workspace, (w) => w.prepare({ key, repoPath: repo, commit: "main" }))
    )
    log(`prepared ${prepared.remoteId} at ${prepared.commit} base ${prepared.base} in ${prepared.workdir}`)
    expect(prepared.commit).toBe(commit)
    expect(prepared.workdir).toBe("/workspace")
    expect(prepared.remoteId).toMatch(/^smthrs-msb-/)

    // The machine records its workspace key, which a restarted host reads
    // to keep the machine of a run that resumes.
    const config = JSON.parse((await Microsandbox.Sandbox.get(prepared.remoteId)).configJson) as {
      readonly labels: Record<string, string>
    }
    expect(config.labels[Workspace.workspaceLabel]).toBe(key)

    // Seeding the same key at the same commit reattaches and reuses it.
    const again = await within(Effect.flatMap(Workspace.Workspace, (w) => w.prepare({ key, repoPath: repo, commit })))
    expect(again).toEqual(prepared)

    // A role task's tools act through this same session.
    const edited = await within(Effect.scoped(Effect.gen(function*() {
      const session = yield* (yield* Workspace.Workspace).session(key, { commit })
      const result = yield* Process.guest(
        session,
        "printf 'hello world\\n' > lib.txt && mkdir -p docs && printf 'notes\\n' > docs/notes.md && uname -s && cat /etc/os-release | head -1",
        { limit: 4_096 }
      )
      return { exitCode: result.exitCode, stdout: Process.text(result.stdout) }
    })))
    log(`guest edit exit ${edited.exitCode}: ${edited.stdout.trim().replaceAll("\n", " | ")}`)
    expect(edited.exitCode).toBe(0)
    expect(edited.stdout).toContain("Linux")

    const diff = await within(Effect.flatMap(Workspace.Workspace, (w) => w.collect(prepared)))
    log(`diff ${diff.bytes} bytes, files ${JSON.stringify(diff.files)}`)
    expect(diff.commit).toBe(commit)
    expect(diff.files).toEqual([
      { path: "docs/notes.md", added: 1, deleted: 0 },
      { path: "lib.txt", added: 1, deleted: 1 }
    ])
    expect(diff.patch).toContain("+hello world")
    expect(diff.added).toBe(2)
    expect(diff.deleted).toBe(1)

    const checks: ReadonlyArray<Workspace.Check> = [
      { name: "fixture", argv: ["sh", "check.sh"] },
      { name: "toolchain", argv: ["node", "--version"] }
    ]
    const passing = await within(
      Effect.flatMap(
        Workspace.Workspace,
        (w) => w.runChecks({ key, repoPath: repo, commit, patch: diff.patch, checks })
      )
    )
    log(`checks with patch: ${JSON.stringify(passing.receipts.map((r) => [r.name, r.exitCode, r.stdout.text.trim()]))}`)
    expect(passing.passed).toBe(true)
    expect(passing.receipts[0]!.stdout.text).toBe("ok\n")
    expect(passing.receipts[1]!.stdout.text).toMatch(/^v26\./)

    const failing = await within(Effect.flatMap(Workspace.Workspace, (w) =>
      w.runChecks({
        key,
        repoPath: repo,
        commit,
        patch: "",
        checks: [...checks, { name: "deadline", argv: ["sleep", "60"], timeoutMs: 2_000 }]
      })))
    log(
      `checks without patch: ${
        JSON.stringify(failing.receipts.map((r) => [r.name, r.exitCode, r.timedOut, r.stderr.text.trim()]))
      }`
    )
    expect(failing.passed).toBe(false)
    expect(failing.receipts[0]!.exitCode).toBe(1)
    expect(failing.receipts[0]!.stderr.text).toBe("lib.txt is wrong\n")
    expect(failing.receipts[2]).toMatchObject({ exitCode: null, timedOut: true })

    const applied = await within(Effect.flatMap(Workspace.Workspace, (w) =>
      w.applyChange({
        repoPath: repo,
        branch: "smithers/fixture",
        parent: commit,
        patch: diff.patch,
        message: "Say hello world",
        runId: run,
        principal: "builder",
        at: 1_790_000_000_000
      })))
    log(`landed ${applied.commit} on ${applied.branch}`)
    expect(applied).toMatchObject({ branch: "smithers/fixture", parent: commit, created: true })
    expect(git(repo, "show", `${applied.commit}:lib.txt`)).toBe("hello world")
    expect(git(repo, "log", "-1", "--format=%B", applied.commit)).toBe(
      `Say hello world\n\nSmithers-Run: ${run}\nSmithers-Principal: builder`
    )
    expect(checkoutState(repo)).toEqual(before)

    await within(Effect.flatMap(Workspace.Workspace, (w) => w.dispose(prepared)))
    const gone = await Microsandbox.Sandbox.get(prepared.remoteId).then(() => false, () => true)
    log(`disposed ${prepared.remoteId}: ${gone ? "gone" : "still present"}`)
    expect(gone).toBe(true)
  }, 900_000)

  it("runs a builder's role task with shell and file tools inside the microVM", async () => {
    const { repo, commit } = fixtureRepo()
    const snapshot = await loadSnapshot()
    const executionId = `${run}-role`
    const key = `${executionId}/example/demo/build`
    const asked: Array<Asked> = []
    const recorded: Array<Recorded> = []
    const cell =
      `const probe = await ctx.call("bash", { command: "uname -s && head -1 /etc/os-release && test ! -e ${repo} && echo host-path-hidden" });
const wrote = await ctx.call("write", { path: "/workspace/lib.txt", content: "hello there\\n" });
const edited = await ctx.call("edit", { path: "/workspace/lib.txt", oldString: "there", newString: "world" });
const edit = { exitCode: wrote.created === false && edited.replacements === 1 ? 0 : 1 };
const page = await ctx.call("read", { path: "/workspace/lib.txt" });
const result = ${JSON.stringify(done({ summary: "", commands: "" }))};
result.fields.summary = probe.stdout;
result.fields.commands = "bash exit " + probe.exitCode + "; edit exit " + edit.exitCode + "; read " + page.content;
ctx.done(JSON.stringify(result))`
    const stack = Layer.mergeAll(Authority.layer(Actions.RoleTask.layer), Interpreter.layer(Build)).pipe(
      Layer.provideMerge(
        Workspace.layer({ machines, maxConcurrentVMs: 2 }).pipe(Layer.provideMerge(NodeServices.layer))
      ),
      Layer.provideMerge(agentStack({
        snapshot,
        resources: { memory: memoryServices, claimCap: 0 },
        model: scripted([cell], asked),
        recorded
      }))
    )
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const workspace = yield* Workspace.Workspace
        const prepared = yield* workspace.prepare({ key, repoPath: repo, commit })
        const result = yield* Build.execute(
          { ...payloadFor(snapshot, "builder", task()), workspace: { key, repository: "example/demo" } },
          { executionId }
        )
        const diff = yield* workspace.collect(prepared)
        yield* workspace.dispose(prepared)
        return { prepared, result, diff }
      }).pipe(Effect.provide(stack))
    )
    console.log(`[microvm] role task ${JSON.stringify(outcome.result.fields)} in ${outcome.prepared.remoteId}`)
    console.log(`[microvm] role flows ${recorded[0]!.flows.join(",")}; envelope ${recorded[0]!.envelope.join(",")}`)
    expect(outcome.result.fields["summary"]).toBe(
      "Linux\nPRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nhost-path-hidden\n"
    )
    expect(outcome.result.fields["commands"]).toBe("bash exit 0; edit exit 0; read hello world")
    expect(outcome.diff.files).toEqual([{ path: "lib.txt", added: 1, deleted: 1 }])
    expect(recorded[0]!.flows).toContain("bash")
  }, 900_000)
})

const Build = Flow.make("test/microvm-build", {
  payload: Authority.RoleTaskPayload,
  success: Profile.RoleResult,
  error: AgentAction.AgentFailure,
  body: (payload) => Actions.RoleTask.call(payload)
})
