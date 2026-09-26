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
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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
import { tempDir } from "./support.ts"
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
      MicrosandboxSandbox.reap({ sdk: Microsandbox, owner, isAlive: () => Effect.succeed(false) }).pipe(
        // The prepared bases this run captured are its own, by owner.
        Effect.andThen(
          MicrosandboxSandbox.pruneSnapshots(Microsandbox, Workspace.basePrefix(owner), 0)
        )
      )
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

  it("brings back a workspace whose machine died, with its checkout", async () => {
    const { repo, commit } = fixtureRepo()
    const key = `${run}/fixture/crash`
    const log = (line: string) => console.log(`[microvm-crash] ${line}`)
    /** The machine's host process dies, as a crashed guest's does. */
    const crash = (remoteId: string) => {
      const killed = spawnSync("pkill", ["-9", "-f", "--", `--name ${remoteId} `]).status
      log(`killed the process of ${remoteId}: ${killed === 0}`)
      expect(killed).toBe(0)
    }
    const guest = (command: string) =>
      within(Effect.scoped(Effect.gen(function*() {
        const session = yield* (yield* Workspace.Workspace).session(key, { commit })
        const result = yield* Process.guest(session, command, { limit: 4_096 })
        return { exitCode: result.exitCode, stdout: Process.text(result.stdout) }
      })))

    const prepared = await within(
      Effect.flatMap(Workspace.Workspace, (w) => w.prepare({ key, repoPath: repo, commit }))
    )
    // Dead between steps: the next session restarts it on its own disk.
    crash(prepared.remoteId)
    expect(await guest("printf 'hello world\\n' > lib.txt && sync && cat lib.txt")).toEqual({
      exitCode: 0,
      stdout: "hello world\n"
    })
    // Dead in the middle of a session: the next command's start brings it back.
    const midway = await within(Effect.scoped(Effect.gen(function*() {
      const session = yield* (yield* Workspace.Workspace).session(key, { commit })
      crash(prepared.remoteId)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 500)))
      const result = yield* Process.guest(session, "git status --short", { limit: 4_096 })
      return { exitCode: result.exitCode, stdout: Process.text(result.stdout) }
    })))
    expect(midway).toEqual({ exitCode: 0, stdout: " M lib.txt\n" })
    const diff = await within(Effect.flatMap(Workspace.Workspace, (w) => w.collect(prepared)))
    expect(diff.files).toEqual([{ path: "lib.txt", added: 1, deleted: 1 }])
    await within(Effect.flatMap(Workspace.Workspace, (w) => w.dispose(prepared)))
  }, 300_000)

  it("runs hundreds of commands in one session without its machine refusing them or restarting", async () => {
    const { repo, commit } = fixtureRepo()
    const key = `${run}/fixture/many`
    const prepared = await within(
      Effect.flatMap(Workspace.Workspace, (w) => w.prepare({ key, repoPath: repo, commit }))
    )
    // /tmp is the guest's memory: a restarted machine comes back without it.
    const outcome = await within(Effect.scoped(Effect.gen(function*() {
      const session = yield* (yield* Workspace.Workspace).session(key, { commit })
      yield* Process.guest(session, "echo kept > /tmp/marker", { limit: 1_024 })
      let failed = 0
      for (let n = 0; n < 400; n++) {
        const result = yield* Process.guest(session, `test -f README.md`, { limit: 1_024 })
        if (result.exitCode !== 0) failed++
      }
      const marker = yield* Process.guest(session, "cat /tmp/marker", { limit: 1_024 })
      return { failed, marker: Process.text(marker.stdout) }
    })))
    expect(outcome).toEqual({ failed: 0, marker: "kept\n" })
    await within(Effect.flatMap(Workspace.Workspace, (w) => w.dispose(prepared)))
  }, 300_000)

  /**
   * `SMITHERS_VM_STRESS=<cycles>`: prepare, two sessions of commands, collect
   * and dispose, `<cycles>` times one after another and again two at a time,
   * counting failures. Off by default; the qualification's failure rates came
   * from it.
   */
  const cycles = Number(process.env.SMITHERS_VM_STRESS ?? "0")
  it.skipIf(cycles === 0)(
    `survives ${cycles} sequential and ${cycles} two-way concurrent workspace cycles`,
    async () => {
      const { repo, commit } = fixtureRepo()
      const cycle = (label: string) =>
        Effect.gen(function*() {
          const workspace = yield* Workspace.Workspace
          const key = `${run}/stress/${label}`
          const prepared = yield* workspace.prepare({ key, repoPath: repo, commit })
          for (let round = 0; round < 2; round++) {
            yield* Effect.scoped(Effect.gen(function*() {
              const session = yield* workspace.session(key, { commit })
              for (let n = 0; n < 5; n++) {
                const result = yield* Process.guest(session, `echo ${round}-${n} >> notes.txt && git status --short`, {
                  limit: 4_096
                })
                if (result.exitCode !== 0) return yield* Effect.fail(new Error(Process.text(result.stderr)))
              }
            }))
          }
          yield* workspace.collect(prepared)
          yield* workspace.dispose(prepared)
        }).pipe(Effect.exit)
      const count = async (concurrency: number) => {
        const exits = await within(
          Effect.forEach(Array.from({ length: cycles }, (_, n) => `${concurrency}-${n}`), cycle, { concurrency })
        )
        const failed = exits.filter((exit) => exit._tag === "Failure")
        for (const exit of failed) {
          console.log(`[microvm-stress] ${Cause.pretty((exit as { cause: Cause.Cause<unknown> }).cause)}`)
        }
        console.log(`[microvm-stress] concurrency ${concurrency}: ${cycles - failed.length}/${cycles} cycles passed`)
        return failed.length
      }
      expect(await count(1)).toBe(0)
      expect(await count(2)).toBe(0)
    },
    3_600_000
  )

  it("prepares a pnpm project once with its registry allowed, and checks a builder's fix offline", async () => {
    const { commit, repo } = pnpmRepo()
    const log = (line: string) => console.log(`[microvm-env] ${line}`)
    const environment: Workspace.Environment = {
      prepare: {
        // The preparation proves its own allowlist: the registry answers,
        // any other host does not.
        run: "! curl -sS -o /dev/null --max-time 5 https://example.com && " +
          "npm install -g pnpm@11.25.0 && pnpm install --frozen-lockfile",
        key: ["pnpm-lock.yaml", "package.json"],
        network: ["registry.npmjs.org"]
      },
      network: "none",
      checks: [{ name: "tests", argv: ["sh", "-c", "pnpm test"], timeoutMs: 300_000 }]
    }
    const services = Workspace.layer({ machines, maxConcurrentVMs: 2, environments: { [repo]: environment } }).pipe(
      Layer.provideMerge(NodeServices.layer)
    )
    const inEnvironment = <A, E>(effect: Effect.Effect<A, E, Workspace.Workspace>) =>
      Effect.runPromise(effect.pipe(Effect.provide(services)))
    const timed = async <A>(label: string, run: () => Promise<A>) => {
      const started = Date.now()
      const value = await run()
      log(`${label} ${Date.now() - started} ms`)
      return value
    }

    const key = `${run}/pnpm/build`
    const prepared = await timed(
      "prepare cold (base + workspace)",
      () => inEnvironment(Effect.flatMap(Workspace.Workspace, (w) => w.prepare({ key, repoPath: repo, commit })))
    )
    await timed(
      "prepare warm (workspace from the base)",
      () =>
        inEnvironment(
          Effect.flatMap(Workspace.Workspace, (w) => w.prepare({ key: `${run}/pnpm/warm`, repoPath: repo, commit }))
        )
    )

    // The builder works with the installed dependency and no network: it
    // runs the failing test, fixes the code, and runs it again.
    const built = await inEnvironment(Effect.scoped(Effect.gen(function*() {
      const session = yield* (yield* Workspace.Workspace).session(key, { commit })
      const step = (command: string) =>
        Effect.map(
          Process.guest(session, command, { limit: 16_384, timeoutMs: 120_000 }),
          (result) => ({ exitCode: result.exitCode, output: Process.text(result.stdout) + Process.text(result.stderr) })
        )
      const offline = yield* step("curl -sS -o /dev/null --max-time 5 https://registry.npmjs.org/left-pad")
      const before = yield* step("pnpm test")
      const fixed = yield* step(`sed -i 's/3, " "/3, "0"/' src/code.js && cat src/code.js`)
      const after = yield* step("pnpm test")
      return { offline, before, fixed, after }
    })))
    log(
      `builder: offline exit ${built.offline.exitCode}, tests before ${built.before.exitCode}, after ${built.after.exitCode}`
    )
    expect(built.offline.exitCode).not.toBe(0)
    expect(built.before.exitCode).not.toBe(0)
    expect(built.fixed.output).toContain(`leftPad(String(n), 3, "0")`)
    expect(built.after.exitCode).toBe(0)

    const diff = await inEnvironment(Effect.flatMap(Workspace.Workspace, (w) => w.collect(prepared)))
    log(`diff files ${JSON.stringify(diff.files)}`)
    expect(diff.files).toEqual([{ path: "src/code.js", added: 1, deleted: 1 }])

    // A fresh check machine boots from the same base and runs the suite.
    const passing = await timed(
      "checks with the fix",
      () =>
        inEnvironment(
          Effect.flatMap(Workspace.Workspace, (w) =>
            w.runChecks({ key: `${run}/pnpm`, repoPath: repo, commit, patch: diff.patch, checks: [] }))
        )
    )
    log(`checks with the fix: ${passing.receipts.map((r) => `${r.name} exit ${r.exitCode}`).join(", ")}`)
    expect(passing.passed).toBe(true)
    expect(passing.receipts[0]!.stdout.text).toMatch(/pass 1/)
    const unfixed = await inEnvironment(
      Effect.flatMap(
        Workspace.Workspace,
        (w) => w.runChecks({ key: `${run}/pnpm`, repoPath: repo, commit, patch: "", checks: [] })
      )
    )
    expect(unfixed.passed).toBe(false)
    expect(unfixed.receipts[0]!.stdout.text).toMatch(/fail 1/)

    await inEnvironment(Effect.flatMap(Workspace.Workspace, (w) => w.dispose(prepared)))
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

/**
 * A pnpm project with one registry dependency and a failing test: the code
 * pads with spaces, the test expects zeros.
 */
const pnpmRepo = () => {
  const repo = tempDir()
  mkdirSync(join(repo, "src"))
  mkdirSync(join(repo, "test"))
  const files: Record<string, string> = {
    ".gitignore": "node_modules/\n",
    "package.json": JSON.stringify(
      {
        name: "organization-pnpm-fixture",
        private: true,
        type: "module",
        packageManager: "pnpm@11.25.0",
        scripts: { test: "node --test" },
        dependencies: { "left-pad": "1.3.0" }
      },
      null,
      2
    ) + "\n",
    "pnpm-lock.yaml": [
      "lockfileVersion: '9.0'",
      "",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "",
      "importers:",
      "",
      "  .:",
      "    dependencies:",
      "      left-pad:",
      "        specifier: 1.3.0",
      "        version: 1.3.0",
      "",
      "packages:",
      "",
      "  left-pad@1.3.0:",
      "    resolution: {integrity: sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==}",
      "    deprecated: use String.prototype.padStart()",
      "",
      "snapshots:",
      "",
      "  left-pad@1.3.0: {}",
      ""
    ].join("\n"),
    "src/code.js": [
      `import leftPad from "left-pad"`,
      "",
      "/** A three-digit ticket code. */",
      `export const code = (n) => leftPad(String(n), 3, " ")`,
      ""
    ].join("\n"),
    "test/code.test.js": [
      `import assert from "node:assert/strict"`,
      `import { test } from "node:test"`,
      `import { code } from "../src/code.js"`,
      "",
      `test("codes are zero-padded to three digits", () => {`,
      `  assert.equal(code(7), "007")`,
      "})",
      ""
    ].join("\n")
  }
  for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "initial")
  return { repo, commit: git(repo, "rev-parse", "HEAD") }
}
