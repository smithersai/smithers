import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Path, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Scope from "effect/Scope"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { afterAll } from "vitest"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { discover } from "./helpers/discover.ts"

// The suite drives a real container engine and records an explicit skip when
// none is running. A laptop without Docker or a CI shard without a daemon
// does not claim a real-engine conformance result.
const engineAvailable = discover("docker", ["info"]).status === 0
const missingEngine = engineAvailable
  ? undefined
  : "no container engine answers `docker info` on this host"
const image = "alpine:3.20"

// Session keys are suite-unique so a concurrently running vitest worker
// cannot collide on container names, and every name this suite can create is
// force-removed at the end even when a test failed mid-acquire.
const keys = [
  "conformance-suite",
  "machine-boundary",
  "crash-reattach",
  "host-bundle",
  "neutral-limits",
  "session-reuse",
  "open-network",
  "closed-network",
  "network-swap",
  "forged-network"
].map(
  (name) => `sandbox-it-${process.pid}-${name}`
)
const nameOf = (key: string): string => `smthrs-sbx-${sessionSlug(key)}`
afterAll(() => {
  if (!engineAvailable) return
  for (const key of keys) {
    spawnSync("docker", ["rm", "--force", nameOf(key)], { stdio: "ignore" })
  }
})

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

const provider = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner
  return ContainerSandbox.make({ spawner, image })
}).pipe(Effect.provide(platform))

// Each conformance check acquires and releases a container. Provisioning can
// exceed the ordinary 10-second conformance default, so each check uses the
// same allowance as a standalone real-container case. The outer ceiling still
// bounds the whole suite, including all acquisitions and releases.
const conformanceBudget = 900_000
const budget = 180_000

// Exits 0 only when the guest reaches the public internet. busybox wget ships
// in the image, so the probe runs on every machine this suite boots.
const egressProbe = "wget -q -T 5 -O /dev/null http://example.com"

// What the guest itself says about its network, needing no name service and no
// far end that could be down: its interfaces, whether it has a default route,
// and whether a TCP connection to a literal public address opens. Under
// `--network none` that is loopback alone, no route, and a refused connect;
// under the bridge it is `eth0`, a route, and an open one.
const networkReport = "ls /sys/class/net | sort | tr '\\n' ' '; echo; ip route | grep -c '^default'; " +
  "nc -z -w 5 1.1.1.1 80 >/dev/null 2>&1; echo connect=$?"

/** What the engine records for a container: its network mode and the networks attached to it. */
const engineNetwork = (name: string): string =>
  spawnSync("docker", [
    "container",
    "inspect",
    "--format",
    "{{.HostConfig.NetworkMode}} {{range $network, $_ := .NetworkSettings.Networks}}{{$network}},{{end}}",
    name
  ], { encoding: "utf8" }).stdout.trim()

const said = (session: Sandbox.Session, command: string) =>
  Effect.scoped(Effect.flatMap(
    session.spawn(command, {}),
    (process) => Stream.mkString(Stream.decodeText(process.stdout))
  ))

// The skip has to be visible, and it has to name what is missing: a case that
// silently disappears is indistinguishable from one that never existed, and one
// that disappears without a reason is indistinguishable from a suite quietly
// switched off.
describe.skipIf(engineAvailable)("ContainerSandbox against a real engine", () => {
  it(`is skipped because ${missingEngine ?? "this host runs a container engine"}`, () => {
    expect(missingEngine).toEqual(expect.any(String))
  })
})

describe.skipIf(!engineAvailable)("ContainerSandbox against a real engine", () => {
  it.effect(
    "passes the sandbox conformance suite, kill and the default network's isolation included, against real containers",
    () =>
      Effect.gen(function*() {
        const container = yield* provider
        const violations = yield* SandboxConformance.check(container, {
          session: keys[0]!,
          checkTimeout: budget,
          provides: { kill: true, ping: true },
          // The provider names no network, so these prove the `--network none`
          // default and the host-path boundary on a real engine, not in argv.
          isolation: {
            // This file exists on the host and nowhere in the image.
            hostSentinel: fileURLToPath(import.meta.url),
            egressProbe
          }
        })
        expect(violations).toEqual([])
      }),
    conformanceBudget
  )

  it.effect("reaches the public internet when the network is explicitly open", () =>
    Effect.gen(function*() {
      // The positive control for `refuses-egress`: the same probe exits 0
      // once the network is opened, so its failure above is the network
      // mode's doing and not a probe that can never succeed.
      const spawner = yield* ChildProcessSpawner
      const open = ContainerSandbox.make({ spawner, image, network: "open" })
      const code = yield* Effect.scoped(
        Effect.flatMap(
          open.acquire(keys[6]!),
          (session) => Effect.scoped(Effect.flatMap(session.spawn(egressProbe, {}), (process) => process.exitCode))
        )
      )
      expect(code).toBe(0)
    }).pipe(Effect.provide(platform)), budget)

  it.effect(
    "gives the default container loopback alone and the open one a route out, by the engine's record and the guest's",
    () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        // The same report from the same image under both modes, in one test:
        // a host with no route out fails the open half instead of passing the
        // closed half for the wrong reason.
        const observe = (network: "open" | undefined, key: string) =>
          Effect.scoped(Effect.gen(function*() {
            const session = yield* ContainerSandbox.make({ spawner, image, network }).acquire(key)
            return { engine: engineNetwork(nameOf(key)), guest: yield* said(session, networkReport) }
          }))
        expect(yield* observe(undefined, keys[7]!)).toEqual({ engine: "none none,", guest: "lo \n0\nconnect=1\n" })
        const open = yield* observe("open", keys[6]!)
        expect(open.engine).toBe("bridge bridge,")
        expect(open.guest).toMatch(/^(?:eth0 lo|lo eth0) \n1\nconnect=0\n$/)
      }).pipe(Effect.provide(platform)),
    budget
  )

  it.effect(
    "never reattaches a leftover container that has a network when none was asked for",
    () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const key = keys[8]!
        // A crashed run that opted in to the network leaves its container
        // behind; a later run of the same key that names no network must not
        // inherit it.
        const leaked = yield* Scope.make()
        yield* Effect.provideService(
          ContainerSandbox.make({ spawner, image, network: "open" }).acquire(key),
          Scope.Scope,
          leaked
        )
        expect(engineNetwork(nameOf(key))).toBe("bridge bridge,")
        const refused = yield* Effect.flip(Effect.scoped(ContainerSandbox.make({ spawner, image }).acquire(key)))
        expect(refused.code).toBe("unavailable")
        expect(refused.message).toBe(
          `the container ${nameOf(key)} does not match the requested configuration or owner`
        )
        // The refusal took nothing over: the leftover is still its owner's to
        // reattach, with the network it was created with.
        expect(engineNetwork(nameOf(key))).toBe("bridge bridge,")
        yield* Scope.close(leaked, Exit.void)
      }).pipe(Effect.provide(platform)),
    budget
  )

  it.effect(
    "refuses a container that carries this session's fingerprint but was put on a network",
    () =>
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const closed = ContainerSandbox.make({ spawner, image })
        const key = keys[9]!
        const name = nameOf(key)
        // The fingerprint is a label anyone who can reach the engine can copy.
        // Read the genuine one off a real acquire, then plant a container under
        // the same name with that label, image and working directory, on the
        // bridge. Only the engine's own record of the network tells them apart.
        const fingerprint = yield* Effect.scoped(
          Effect.as(
            closed.acquire(key),
            undefined
          ).pipe(Effect.map(() =>
            spawnSync("docker", [
              "container",
              "inspect",
              "--format",
              "{{index .Config.Labels \"smithers.dev/sandbox-fingerprint\"}}",
              name
            ], { encoding: "utf8" }).stdout.trim()
          ))
        )
        expect(fingerprint).toMatch(/\S/)
        const absent = () => spawnSync("docker", ["container", "inspect", name], { stdio: "ignore" }).status !== 0
        for (let poll = 0; poll < 300 && !absent(); poll++) yield* Effect.sleep("100 millis")
        expect(absent()).toBe(true)
        const planted = spawnSync("docker", [
          "run",
          "--detach",
          "--name",
          name,
          "--workdir",
          "/workspace",
          "--network",
          "bridge",
          "--label",
          `smithers.dev/sandbox-fingerprint=${fingerprint}`,
          image,
          "sleep",
          "infinity"
        ], { encoding: "utf8" })
        expect(planted.status).toBe(0)
        const refused = yield* Effect.flip(Effect.scoped(closed.acquire(key)))
        expect(refused.message).toBe(`the container ${name} does not match the requested configuration or owner`)
        // The control: with the planted container gone, the same provider and
        // key acquire a machine that reaches nothing.
        spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" })
        const guest = yield* Effect.scoped(
          Effect.flatMap(closed.acquire(key), (session) => said(session, networkReport))
        )
        expect(guest).toBe("lo \n0\nconnect=1\n")
      }).pipe(Effect.provide(platform)),
    budget
  )

  it.effect("really places file IO and processes on the container's machine", () =>
    Effect.gen(function*() {
      const container = yield* provider
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* container.acquire(keys[1]!)
          const files = Sandbox.fileSystem(session)
          // The image pins the answer: whatever this host runs, the session's
          // /etc/os-release is Alpine's.
          const release = yield* files.readFileString("/etc/os-release")
          expect(release).toContain("Alpine Linux")
          // A file a guest process writes is the file the session reads, and
          // a binary payload survives the exec transport in both directions.
          const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13, 0])
          yield* session.writeFile(`${session.workdir}/in.bin`, bytes)
          const copied = yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn("cp in.bin out.bin && wc -c < out.bin", {})
              const stdout = yield* Stream.mkString(Stream.decodeText(process.stdout))
              yield* process.exitCode
              return stdout
            })
          )
          expect(copied.trim()).toBe(String(bytes.length))
          expect(Array.from(yield* session.readFile(`${session.workdir}/out.bin`))).toEqual(Array.from(bytes))
          // The probe dialect against real busybox sh.
          yield* files.makeDirectory(`${session.workdir}/nested/deep`, { recursive: true })
          yield* files.rename(`${session.workdir}/out.bin`, `${session.workdir}/nested/deep/out.bin`)
          expect(yield* files.readDirectory(session.workdir, { recursive: true })).toEqual([
            "in.bin",
            "nested",
            "nested/deep",
            "nested/deep/out.bin"
          ])
          const stat = yield* files.stat(`${session.workdir}/nested/deep/out.bin`)
          expect(stat.type).toBe("File")
          expect(stat.size).toBe(BigInt(bytes.length))
          // Exclusive writes preserve an existing entry of every kind and
          // leave no private staging directories behind after a collision.
          yield* files.writeFile("private.bin", bytes, { flag: "wx", mode: 0o600 })
          expect((yield* files.stat("private.bin")).mode & 0o7777).toBe(0o600)
          yield* Effect.scoped(Effect.flatMap(
            session.spawn("ln -s private.bin alias.bin; ln -s absent dangling.bin; mkfifo pipe.bin; mkdir dir.bin", {}),
            (process) => process.exitCode
          ))
          for (const path of ["private.bin", "alias.bin", "dangling.bin", "pipe.bin", "dir.bin"]) {
            const error = yield* Effect.flip(files.writeFile(path, new Uint8Array([99]), { flag: "wx" }))
            expect(error.reason._tag).toBe("AlreadyExists")
          }
          expect(yield* files.readFile("private.bin")).toEqual(bytes)
          expect((yield* files.readDirectory(session.workdir)).some((name) => name.startsWith(".smithers-write.")))
            .toBe(false)
          yield* Effect.scoped(
            Effect.flatMap(session.spawn("ln -s nested/deep/out.bin link.bin", {}), (process) => process.exitCode)
          )
          expect(yield* files.readLink(`${session.workdir}/link.bin`)).toBe("nested/deep/out.bin")
          expect(yield* files.realPath(`${session.workdir}/link.bin`)).toBe(
            `${session.workdir}/nested/deep/out.bin`
          )
          yield* files.remove(`${session.workdir}/nested`, { recursive: true })
          expect(yield* files.exists(`${session.workdir}/nested`)).toBe(false)
        })
      )
    }), budget)

  it.effect("reattaches the machine a crashed run left behind, workspace intact", () =>
    Effect.gen(function*() {
      const container = yield* provider
      const key = keys[2]!
      // A crash is a scope whose finalizers never ran: leak the first scope on
      // purpose, then acquire the same key again.
      const leaked = yield* Scope.make()
      const first = yield* Effect.provideService(container.acquire(key), Scope.Scope, leaked)
      yield* first.writeFile(`${first.workdir}/survivor.txt`, new TextEncoder().encode("still here"))
      const survived = yield* Effect.scoped(
        Effect.gen(function*() {
          const second = yield* container.acquire(key)
          const bytes = yield* second.readFile(`${second.workdir}/survivor.txt`)
          return new TextDecoder().decode(bytes)
        })
      )
      expect(survived).toBe("still here")
      // The reacquire's release already removed the container; closing the
      // leaked scope must tolerate that.
      const closed = yield* Effect.exit(Scope.close(leaked, Exit.void))
      expect(Exit.isSuccess(closed)).toBe(true)
    }), budget)

  it.effect("reuses a session key immediately after its container was released", () =>
    Effect.gen(function*() {
      const container = yield* provider
      const key = keys[5]!
      // An engine may still be finishing the force removal when the same name
      // is created again; every round must acquire, run, and release cleanly.
      for (let round = 0; round < 5; round++) {
        const echoed = yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* container.acquire(key)
            const process = yield* session.spawn(`echo round-${round}`, {})
            return yield* Stream.mkString(Stream.decodeText(process.stdout))
          })
        )
        expect(echoed).toBe(`round-${round}\n`)
      }
    }), budget)

  it.effect("serves the host bundle from the container through layerHost", () =>
    Effect.gen(function*() {
      const container = yield* provider
      const outcome = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const files = yield* FileSystem.FileSystem
        yield* files.writeFileString("/workspace/tool-input.txt", "for the guest tool")
        const answer = yield* spawner.string(
          ChildProcess.make("tr a-z A-Z < /workspace/tool-input.txt && echo && uname -s", { shell: true })
        )
        return answer
      }).pipe(Effect.provide(Sandbox.layerHost(container, { session: keys[3]! })))
      expect(outcome).toBe("FOR THE GUEST TOOL\nLinux\n")
    }), budget)

  it.effect("neutral ceilings reach real container", () =>
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const limited = ContainerSandbox.make({
        spawner,
        image,
        limits: { cpus: 0.5, memoryMib: 64, timeoutSecs: 600 }
      })
      const key = keys[4]!
      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* limited.acquire(key)
          const inspected = spawnSync("docker", [
            "container",
            "inspect",
            "--format",
            "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{json .Config.Cmd}}",
            nameOf(key)
          ], { encoding: "utf8" })
          expect(inspected.stdout.trim()).toBe(`500000000 ${64 * 1024 * 1024} ["sleep","600"]`)
        })
      )
    }).pipe(Effect.provide(platform)), budget)
})
