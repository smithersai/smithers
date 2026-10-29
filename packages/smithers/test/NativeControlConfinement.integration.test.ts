/** The shipped native executor keeps owner adapters separate from agent commands. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Checkpointed from "@smthrs/agent/Checkpointed"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Control } from "@smthrs/control"
import * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as Executable from "@smthrs/registry/Executable"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import { Effect, Layer, Option, type Schema } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const scratch = process.env.SMITHERS_CONFINEMENT_TEST_SCRATCH ?? join(process.cwd(), ".cache", "process-confinement")
const roots = new Set<string>()
const hostPath = process.env.PATH
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
  process.env.PATH = hostPath
})
const fixture = () => {
  mkdirSync(scratch, { recursive: true })
  const base = realpathSync(mkdtempSync(join(scratch, "native-boundary-")))
  roots.add(base)
  const workspace = join(base, "workspace")
  mkdirSync(workspace)
  return { base, workspace }
}
/**
 * A `docker` first on PATH that reaches no daemon: it records each call's argv
 * and daemon variables outside the workspace, where only an unconfined process
 * can write, and answers like a passing runner.
 */
const fakeDocker = (base: string) => {
  const record = join(base, "docker-calls")
  mkdirSync(join(base, "bin"))
  writeFileSync(
    join(base, "bin", "docker"),
    [
      `#!${process.execPath}`,
      `process.getBuiltinModule("node:fs").appendFileSync(${JSON.stringify(record)}, JSON.stringify({`,
      "  argv: process.argv.slice(2), host: process.env.DOCKER_HOST, config: process.env.DOCKER_CONFIG",
      "}) + \"\\n\")",
      "process.stdout.write(\"1 passed in 0.1s\\n\")"
    ].join("\n"),
    { mode: 0o755 }
  )
  process.env.PATH = `${join(base, "bin")}:${hostPath}`
  return (): Array<{ argv: Array<string>; host?: string; config?: string }> =>
    existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
}
/** The flows the native executor binds, read where a module catalog is registered. */
const offered = () => {
  const bound: Array<FlowBinding.Binding> = []
  const pins: Array<Checkpoints.Checkpoints> = []
  const modules = Layer.effect(Executable.Catalog)(Effect.gen(function*() {
    const host = yield* AgentAction.Host
    bound.push(...(yield* Effect.forEach(host.flows ?? [], (source) => source.bindings())).flat())
    const pinned = yield* Effect.serviceOption(Checkpoints.Checkpoints)
    if (Option.isSome(pinned)) pins.push(pinned.value)
    return Executable.Catalog.of({ executables: [], refused: [] })
  })).pipe(Layer.orDie)
  return {
    modules,
    bound,
    flow: (name: string) => bound.find((binding) => binding.descriptor.name === name),
    checkpoints: () => pins[0]!
  }
}
const spawnCount = (workspace: string) => {
  const database = new DatabaseSync(NodeControl.executionDatabasePath(workspace), { readOnly: true })
  try {
    return database.prepare(
      "SELECT COUNT(*) AS count FROM flows_journal_events WHERE event_type = 'flows.host.process-spawned.v1'"
    ).get()!.count
  } finally {
    database.close()
  }
}
/** The flows that read and write this host's files, which a sealed host never offers. */
const hostFilesystemFlows = ["read", "write", "edit", "apply_patch", "grep", "glob", "ls"]
/** The workspace tree and nothing beside it, and any command unless `spawn` is false. */
const workspaceGrants = (workspace: string, spawn = true) =>
  GrantStore.layer({
    attended: false,
    rules: [
      new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "fs:*", resource: workspace }) }),
      new Rule({
        effect: "allow",
        pattern: new CapabilityPattern({ action: "fs:*", resource: `${workspace}/**` })
      }),
      ...(spawn
        ? [new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "proc:spawn", resource: "**" }) })]
        : [])
    ]
  }).pipe(Layer.provide(Workspace.layer(workspace)), Layer.orDie)
const call = (input: Schema.Json, flowName = "bash", at?: string): Cell.Call =>
  new Cell.Call({
    ...(at === undefined ? {} : { at }),
    flowName,
    input,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({
      session: "native-boundary",
      frame: 0,
      cell: "cell",
      ordinal: 0,
      declaration: "declaration",
      layers: []
    })
  })
const build = (workspace: string, options: Partial<Parameters<typeof NodeControl.layerExecutor>[3]>) => {
  const registry = NodeControl.layerRegistry(workspace)
  const engine = NodeControl.engineDurable(workspace, registry)
  const executor = NodeControl.layerExecutor(registry, engine, workspace, {
    evaluator: ScriptedJudge.layerAll,
    environment: {},
    grants: GrantStore.layerNoop,
    ...options
  })
  // This local application branch uses no RPC socket or remote HTTP transport.
  return Application.layer({ root: workspace }, registry, engine, executor) as Layer.Layer<Control.Control>
}

it("starts an explicitly configured owner MCP adapter with its host access", async () => {
  const { base, workspace } = fixture()
  const marker = join(base, "owner-adapter")
  const server = `
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'owner');
    process.stdin.setEncoding('utf8'); let buffer = '';
    process.stdin.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0,end); buffer = buffer.slice(end+1);
        if (!line.trim()) continue; const msg = JSON.parse(line);
        if (msg.id === undefined) continue;
        const result = msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {tools:{}}, serverInfo:{name:'owner',version:'0'} }
          : {tools:[]};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
      }
    });`
  await Effect.runPromise(Control.Control.pipe(
    Effect.provide(
      build(workspace, { mcpServers: [{ server: "owner", command: process.execPath, args: ["-e", server] }] })
    ),
    Effect.scoped,
    Effect.timeout("25 seconds")
  ))
  expect(existsSync(marker)).toBe(true)
})

it("refuses native baseline comparison before any process and keeps workspace tests confined", async () => {
  const { base, workspace } = fixture()
  const escaped = join(base, "test-escape")
  const control = join(workspace, "runner-control")
  // Even repository metadata directing Git outside the grant must never be consulted.
  writeFileSync(join(workspace, ".git"), `gitdir: ${base}/outside-repository\n`)
  writeFileSync(
    join(workspace, "runtests.sh"),
    [
      `printf escaped 2>/dev/null > '${escaped}' || true`,
      "printf allowed > runner-control",
      "printf '1 passed in 0.1s\\n'"
    ].join("\n")
  )
  let tests: FlowBinding.Binding | undefined
  const modules = Layer.effect(Executable.Catalog)(Effect.gen(function*() {
    const host = yield* AgentAction.Host
    const bindings = yield* Effect.forEach(host.flows ?? [], (source) => source.bindings())
    tests = bindings.flat().find((binding) => binding.descriptor.name === "test")
    return Executable.Catalog.of({ executables: [], refused: [] })
  })).pipe(Layer.orDie)
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      expect(tests).toBeDefined()
      const database = new DatabaseSync(NodeControl.executionDatabasePath(workspace), { readOnly: true })
      try {
        const spawned = () =>
          database.prepare(
            "SELECT COUNT(*) AS count FROM flows_journal_events WHERE event_type = 'flows.host.process-spawned.v1'"
          ).get()!.count
        const before = spawned()
        const baseline = yield* tests!.run(call({ against: "base" }, "test"))
        expect(baseline.outcome).toBe("failure")
        expect(JSON.stringify(baseline)).toContain("Baseline comparison is unavailable on this host")
        expect(spawned()).toBe(before)
        expect(existsSync(control)).toBe(false)
        expect(existsSync(escaped)).toBe(false)
        const result = yield* tests!.run(call({ against: "workspace" }, "test"))
        expect(result.outcome, JSON.stringify(result)).toBe("success")
        const value = result.value as { exitCode: number; passed: number }
        expect(value.exitCode).toBe(0)
        expect(value.passed, JSON.stringify(value)).toBe(1)
        expect(spawned()).not.toBe(before)
        expect(existsSync(control)).toBe(true)
        expect(existsSync(escaped)).toBe(false)
      } finally {
        database.close()
      }
    }).pipe(
      Effect.provide(build(workspace, {
        modules,
        environment: { SMITHERS_TEST_COMMAND: "bash runtests.sh" },
        grants: workspaceGrants(workspace)
      })),
      Effect.scoped
    )
  )
}, 60_000)

it("keeps registered agent shell confined and refuses a named Docker transport", async () => {
  const { base, workspace } = fixture()
  // A reachable CLI and daemon change nothing: an unsealed host binds no transport.
  const dockerCalls = fakeDocker(base)
  const { modules, bound, flow } = offered()
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      const shell = flow("bash")
      expect(shell).toBeDefined()
      expect(bound.map((binding) => binding.descriptor.name)).toEqual(expect.arrayContaining(hostFilesystemFlows))
      const result = yield* shell!.run(
        call({ mode: "unhermetic", command: "printf escaped > ../agent-escape", cwd: workspace })
      )
      expect(result.outcome).toBe("success")
      expect((result.value as { exitCode: number }).exitCode, JSON.stringify(result)).not.toBe(0)
      expect(existsSync(join(base, "agent-escape"))).toBe(false)
      const database = new DatabaseSync(NodeControl.executionDatabasePath(workspace), { readOnly: true })
      const spawned = () =>
        database.prepare(
          "SELECT COUNT(*) AS count FROM flows_journal_events WHERE event_type = 'flows.host.process-spawned.v1'"
        ).get()!.count
      const before = spawned()
      const container = yield* shell!.run(call({ mode: "unhermetic", command: "true", container: "unowned-container" }))
      expect(container.outcome).toBe("failure")
      expect(JSON.stringify(container)).toContain("has no container transport")
      expect(spawned()).toBe(before)
      expect(dockerCalls()).toEqual([])
      database.close()
    }).pipe(
      Effect.provide(build(workspace, { modules, environment: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" } })),
      Effect.scoped
    )
  )
})

const sealed = {
  SMITHERS_BASH_CONTAINER: "benchmark-cell",
  DOCKER_HOST: "unix:///run/user/1000/docker.sock",
  DOCKER_CONFIG: "/home/bench/.docker"
}

it("runs a sealed host's bash and test in its one container through the docker CLI (#3802)", async () => {
  const { base, workspace } = fixture()
  const dockerCalls = fakeDocker(base)
  const { modules, flow } = offered()
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      const result = yield* flow("bash")!.run(
        call({ mode: "unhermetic", container: "benchmark-cell", cwd: "/app", command: "ls -la" })
      )
      expect(result.outcome, JSON.stringify(result)).toBe("success")
      expect(result.value).toMatchObject({ exitCode: 0, stdout: "1 passed in 0.1s\n" })
      // The measurement of /app before and after the command travels the same route.
      expect(dockerCalls().map((entry) => entry.argv.slice(0, 6))).toEqual([
        ["exec", "-w", "/app", "--", "benchmark-cell", "sh"],
        ["exec", "-w", "/app", "--", "benchmark-cell", "bash"],
        ["exec", "-w", "/app", "--", "benchmark-cell", "sh"]
      ])
      expect(dockerCalls()[1]!.argv).toEqual(["exec", "-w", "/app", "--", "benchmark-cell", "bash", "-lc", "ls -la"])
      const tested = yield* flow("test")!.run(call({ against: "workspace" }, "test"))
      expect(tested.outcome, JSON.stringify(tested)).toBe("success")
      expect(tested.value).toMatchObject({ exitCode: 0, passed: 1 })
      expect(dockerCalls()[3]!.argv).toEqual(
        ["exec", "-w", "/app", "--", "benchmark-cell", "bash", "-c", "pytest -q \"$@\"", "pytest -q"]
      )
      // A rootless daemon is found only through these; every transport process carries them.
      for (const entry of dockerCalls()) {
        expect(entry).toMatchObject({ host: sealed.DOCKER_HOST, config: sealed.DOCKER_CONFIG })
      }
    }).pipe(
      Effect.provide(build(workspace, {
        modules,
        environment: {
          ...sealed,
          SMITHERS_TEST_COMMAND: "pytest -q",
          SMITHERS_TEST_CONTAINER: "benchmark-cell",
          SMITHERS_TEST_CWD: "/app"
        }
      })),
      Effect.scoped
    )
  )
}, 60_000)

/**
 * A `docker` first on PATH that runs each `exec` here, in the directory `-w`
 * names or else in `workdir`: a container whose filesystem the host
 * workspace never sees, as on the 2026-10-14 benchmark host.
 */
const runningDocker = (base: string, workdir: string) => {
  mkdirSync(join(base, "bin"))
  const record = join(base, "docker-calls")
  writeFileSync(
    join(base, "bin", "docker"),
    [
      `#!${process.execPath}`,
      "const argv = process.argv.slice(2)",
      `process.getBuiltinModule("node:fs").appendFileSync(${JSON.stringify(record)}, JSON.stringify({`,
      "  argv, host: process.env.DOCKER_HOST",
      "}) + \"\\n\")",
      `let cwd = ${JSON.stringify(workdir)}, input = false, at = 1`,
      "for (; argv[at] !== \"--\"; at++) {",
      "  if (argv[at] === \"-i\") input = true",
      "  else if (argv[at] === \"-w\") cwd = argv[++at]",
      "  else if (argv[at] === \"-e\") at++",
      "}",
      "const [, file, ...args] = argv.slice(at + 1)",
      "const stdio = [input ? \"inherit\" : \"ignore\", \"inherit\", \"inherit\"]",
      "const result = process.getBuiltinModule(\"node:child_process\").spawnSync(file, args, { cwd, stdio })",
      "process.exit(result.status ?? 1)"
    ].join("\n"),
    { mode: 0o755 }
  )
  process.env.PATH = `${join(base, "bin")}:${hostPath}`
  return (): Array<{ argv: Array<string>; host?: string }> =>
    existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
}

/**
 * A container's userland is GNU or BusyBox; the file operations use `stat -c`
 * and `ln -T`, which macOS's own utilities lack. Off Linux the stand-in runs
 * with GNU coreutils first on its PATH, when this host has them.
 */
const gnuUserland = process.platform === "linux"
  ? ""
  : ["/opt/homebrew/opt/coreutils/libexec/gnubin", "/usr/local/opt/coreutils/libexec/gnubin"].find(existsSync)

it.skipIf(gnuUserland === undefined)(
  "runs a sealed host's file flows on its container's files through the docker CLI (#3998)",
  async () => {
    const { base, workspace } = fixture()
    // The repository lives only in the container, named by SMITHERS_TEST_CWD.
    const app = join(base, "app")
    mkdirSync(join(app, "src"), { recursive: true })
    writeFileSync(join(app, "src", "mod.py"), "def needle():\n    return 'naïve'\n")
    const dockerCalls = runningDocker(base, app)
    if (gnuUserland) process.env.PATH = `${join(base, "bin")}:${gnuUserland}:${hostPath}`
    const { modules, bound, flow } = offered()
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Control.Control
        const names = bound.map((binding) => binding.descriptor.name)
        for (const name of hostFilesystemFlows) expect(names).toContain(name)
        // Binding the flows touched nothing: no command runs until a flow is called.
        expect(dockerCalls()).toEqual([])
        const read = yield* flow("read")!.run(call({ path: "src/mod.py" }, "read"))
        expect(read).toMatchObject({ outcome: "success", value: { content: "def needle():\n    return 'naïve'" } })
        const edited = yield* flow("edit")!.run(
          call({ path: "src/mod.py", oldString: "'naïve'", newString: "'café'" }, "edit")
        )
        expect(edited).toMatchObject({ outcome: "success", value: { hunk: "def needle():\n    return 'café'" } })
        const patched = yield* flow("apply_patch")!.run(call({
          input: "*** Begin Patch\n*** Add File: src/new.py\n+value = 1\n*** End Patch"
        }, "apply_patch"))
        expect(patched).toMatchObject({ outcome: "success", value: { added: ["src/new.py"] } })
        const found = yield* flow("grep")!.run(call({ pattern: "needle" }, "grep"))
        expect(found).toMatchObject({ outcome: "success", value: { matches: [{ file: "src/mod.py", line: 1 }] } })
        expect(readFileSync(join(app, "src", "mod.py"), "utf8")).toBe("def needle():\n    return 'café'\n")
        expect(readFileSync(join(app, "src", "new.py"), "utf8")).toBe("value = 1\n")
        expect(existsSync(join(workspace, "src"))).toBe(false)
        // Every operation was one exec in the sealed container, carrying the daemon's address.
        const calls = dockerCalls()
        expect(calls.length).toBeGreaterThan(4)
        for (const entry of calls) {
          expect(entry.argv.slice(entry.argv.indexOf("--"), entry.argv.indexOf("--") + 3)).toEqual([
            "--",
            "benchmark-cell",
            "/bin/sh"
          ])
          expect(entry.host).toBe(sealed.DOCKER_HOST)
        }
      }).pipe(
        Effect.provide(build(workspace, { modules, environment: { ...sealed, SMITHERS_TEST_CWD: app } })),
        Effect.scoped
      )
    )
  },
  60_000
)

it("runs a sealed host's call at ctx.base in its container, against the opening tree (#3952)", async () => {
  const { base, workspace } = fixture()
  // The repository lives only in the container; the workspace holds none.
  const app = join(base, "app")
  mkdirSync(app)
  writeFileSync(join(app, "mod.py"), "value = 'pristine'\n")
  const git = (args: ReadonlyArray<string>) => execFileSync("git", ["-C", app, ...args], { encoding: "utf8" })
  git(["init", "-q"])
  git(["add", "-A"])
  git(["-c", "user.name=rig", "-c", "user.email=rig@localhost", "commit", "-qm", "base"])
  writeFileSync(join(app, "mod.py"), "value = 'fixed'\n")
  runningDocker(base, app)
  const { modules, flow, checkpoints } = offered()
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      const runner = Checkpointed.checkpointed(checkpoints(), { run: flow("bash")!.run })
      const input = { mode: "unhermetic", container: "benchmark-cell", command: "cat mod.py" }
      const before = yield* runner.run(call(input, "bash", Checkpoints.baseId))
      const after = yield* runner.run(call(input))
      expect(before.outcome, JSON.stringify(before)).toBe("success")
      expect(before.value).toMatchObject({ exitCode: 0, stdout: "value = 'pristine'\n" })
      expect(after.value).toMatchObject({ exitCode: 0, stdout: "value = 'fixed'\n" })
      expect(git(["status", "--porcelain"])).toBe(" M mod.py\n")
    }).pipe(Effect.provide(build(workspace, { modules, environment: sealed })), Effect.scoped)
  )
}, 60_000)

it("keeps a sealed host out of every other container and off its own filesystem (#3802)", async () => {
  const { base, workspace } = fixture()
  const dockerCalls = fakeDocker(base)
  const { modules, bound, flow } = offered()
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      const names = bound.map((binding) => binding.descriptor.name)
      expect(names).toContain("bash")
      for (const host of hostFilesystemFlows) expect(names).not.toContain(host)
      const before = spawnCount(workspace)
      const refusals = [
        yield* flow("bash")!.run(call({ mode: "unhermetic", container: "other-task", command: "true" })),
        yield* flow("bash")!.run(call({ mode: "unhermetic", command: "true", cwd: workspace })),
        // The runner shares the transport, which answers for one container only.
        yield* flow("test")!.run(call({ against: "workspace" }, "test"))
      ]
      for (const refusal of refusals) {
        expect(refusal.outcome).toBe("failure")
        expect(JSON.stringify(refusal)).toContain("runs commands only inside container \\\"benchmark-cell\\\"")
      }
      expect(spawnCount(workspace)).toBe(before)
      expect(dockerCalls()).toEqual([])
    }).pipe(
      Effect.provide(build(workspace, {
        modules,
        environment: { ...sealed, SMITHERS_TEST_COMMAND: "pytest -q", SMITHERS_TEST_CONTAINER: "other-task" }
      })),
      Effect.scoped
    )
  )
}, 60_000)

it("keeps a sealed host's own runner inside the OS profile (#3802)", async () => {
  const { base, workspace } = fixture()
  const dockerCalls = fakeDocker(base)
  const escaped = join(base, "test-escape")
  writeFileSync(
    join(workspace, "runtests.sh"),
    [
      `printf escaped 2>/dev/null > '${escaped}' || true`,
      "printf allowed > runner-control",
      "printf '1 passed in 0.1s\\n'"
    ]
      .join("\n")
  )
  const { modules, flow } = offered()
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      // No container is declared for the runner, so it starts here and no transport process does.
      const result = yield* flow("test")!.run(call({ against: "workspace" }, "test"))
      expect(result.outcome, JSON.stringify(result)).toBe("success")
      expect(result.value).toMatchObject({ exitCode: 0, passed: 1 })
      expect(existsSync(join(workspace, "runner-control"))).toBe(true)
      expect(existsSync(escaped)).toBe(false)
      expect(dockerCalls()).toEqual([])
    }).pipe(
      Effect.provide(build(workspace, {
        modules,
        environment: { ...sealed, SMITHERS_TEST_COMMAND: "bash runtests.sh" },
        grants: workspaceGrants(workspace)
      })),
      Effect.scoped
    )
  )
}, 60_000)

it("asks the grant store before a sealed transport process starts (#3802)", async () => {
  const { base, workspace } = fixture()
  const dockerCalls = fakeDocker(base)
  const { modules, flow } = offered()
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      const result = yield* flow("bash")!.run(
        call({ mode: "unhermetic", container: "benchmark-cell", command: "true" })
      )
      // No rule allows `proc:spawn`, and nobody attends this host to grant it.
      expect(result.outcome).toBe("failure")
      expect(dockerCalls()).toEqual([])
    }).pipe(
      Effect.provide(build(workspace, { modules, environment: sealed, grants: workspaceGrants(workspace, false) })),
      Effect.scoped
    )
  )
}, 60_000)
