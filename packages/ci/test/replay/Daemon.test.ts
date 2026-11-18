/**
 * A replayed step and a container daemon: the stand-ins first on its `PATH`,
 * the sockets the jail empties, the variable it is not told, and what the
 * person turns off by allowing Docker. Real sockets with a real listener, real
 * repositories, real `git`, real `smthrs`, and the targets the generator
 * writes.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { createServer, type Server } from "node:net"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { files } from "../../src/generate/index.ts"
import { confine } from "../../src/replay/Confine.vibe"
import {
  containerPrograms,
  daemonEnvironment,
  daemonVariables,
  guardedPrograms,
  guardScript,
  placeEnvironment,
  standIns,
  stepEnvironment,
  withoutAllowDocker
} from "../../src/replay/Environment.ts"
import { Options, Progress, run } from "../../src/replay/index.ts"
import { daemonSockets, jailed, type Probe, probe, unjailed } from "../../src/replay/Jail.ts"
import { inventoryWith, job, linkTargets, smthrs } from "./fixture.ts"
import { parts } from "./TestParts.vibe"

const created: Array<string> = []
const listening: Array<Server> = []
// A jailed step has a `/tmp` of its own, so what a test wants a step to find is kept beside it, by its real name.
const directory = (name: string): string => {
  const made = realpathSync(mkdtempSync(join("/var/tmp", `replay-daemon-${name}-`)))
  created.push(made)
  return made
}
afterAll(() => {
  for (const server of listening) server.close()
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

/** A socket something listens on, as a container daemon's is: whoever connects is answered. */
const daemon = async (path: string): Promise<string> => {
  const server = createServer((connection) => connection.end("the daemon\n"))
  listening.push(server)
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return path
}

/** Passes when something answers on the socket, and fails when nothing does. */
const connects = (socket: string): string =>
  `node -e 'require("net").connect(process.argv[1]).on("data", () => process.exit(0)).on("error", () => process.exit(1))' ${socket}`

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

type Jobs = ReadonlyArray<ReturnType<typeof job>>

/** A repository of one commit whose CI is `jobs`. */
const repository = (jobs: Jobs): string => {
  const root = directory("repository")
  git(root, "init", "--quiet", "--initial-branch=main")
  writeFileSync(join(root, ".gitignore"), "node_modules\n.flows\n")
  writeFileSync(join(root, "ci.json"), JSON.stringify({ ...inventoryWith(join(root, "unused")), jobs }))
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "one")
  return root
}

/** The real generator in place of the test one: its targets are the ones `smithers-ci` runs. */
const generating = { ...parts("none"), files } as unknown as ReplayParts<never>

const replay = async (root: string, confined: () => Probe, allowDocker: boolean) => {
  const said: Array<string> = []
  const host = Layer.mergeAll(
    Layer.succeed(Options, {
      smthrs: [smthrs],
      reruns: 1,
      prepare: (checkout) => Effect.sync(() => linkTargets(checkout)),
      confine: confined
    }),
    Layer.succeed(Progress, { say: (line) => Effect.sync(() => void said.push(line)) })
  )
  const report = await Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"], ...(allowDocker ? { allowDocker } : {}) }, generating).pipe(
      Effect.provide(Layer.provideMerge(host as never, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )
  return { report, said }
}

/** Runs `work` with the person's `DOCKER_HOST` and `PATH` as given, and puts both back. */
const withPerson = async <A>(variables: Readonly<Record<string, string>>, work: () => Promise<A>): Promise<A> => {
  const before = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]))
  Object.assign(process.env, variables)
  try {
    return await work()
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const found = probe()
const jailable = !("refusal" in found)
// The stand-ins are beside the homes of the ways, in the replay's own directory.
const standIn = (program: string): string => `"$(cd "$HOME/../.." && pwd)/guard/${program}"`
/** What a container program's stand-in prints when a step starts it with `args`. */
const refused = (program: string, args: string): string =>
  `smithers-ci does not run ${program} without --allow-docker: ${args}`

describe.skipIf(!jailable)("a step in the jail", () => {
  it("finds no container daemon: no socket, no variable, and a stand-in where docker is", async () => {
    const socket = await daemon(join(directory("daemon"), "docker.sock"))
    const passing: Jobs = [
      // The daemon's socket is no socket for a step.
      job("hidden", `test -e ${socket} && test ! -S ${socket}`),
      job("variable", `test -z "\${DOCKER_HOST+set}"`),
      job("standin", `test "$(command -v docker)" = ${standIn("docker")} && test ! -w ${standIn("docker")}`)
    ]
    const failing: Jobs = [
      job("connects", connects(socket)),
      job("docker", "docker ps"),
      job("compose", "docker-compose up -d"),
      job("podman", "podman info"),
      job("nerdctl", "nerdctl ps")
    ]
    const root = repository([...passing, ...failing])
    const asked = () => ({ ...found, daemons: [socket] })

    const { report } = await withPerson({ DOCKER_HOST: `unix://${socket}` }, () => replay(root, asked, false))

    const counts = { hit: 0, ran: passing.length, failed: failing.length, skipped: 0 }
    expect(report.commits.map((commit) => commit.baseline.counts)).toEqual([counts])
    expect(report.commits.map((commit) => commit.normal.counts)).toEqual([counts])
    expect(report.commits.flatMap((commit) => commit.mismatches)).toEqual([])
  }, 1_200_000)

  it(
    "reaches the daemon when the person allows Docker: the socket, the variable and the machine's docker",
    async () => {
      const socket = await daemon(join(directory("daemon"), "docker.sock"))
      const root = repository([
        job("connects", connects(socket)),
        job("variable", `test "$DOCKER_HOST" = unix://${socket}`),
        // Whatever `docker` the machine has, or none: it is not the replay's.
        job("standin", `test "$(command -v docker)" != ${standIn("docker")} && test ! -e ${standIn("docker")}`)
      ])
      const asked = () => ({ ...found, daemons: [socket] })

      const { report } = await withPerson({ DOCKER_HOST: `unix://${socket}` }, () => replay(root, asked, true))

      const counts = { hit: 0, ran: 3, failed: 0, skipped: 0 }
      expect(report.commits.map((commit) => commit.baseline.counts)).toEqual([counts])
      expect(report.commits.map((commit) => commit.normal.counts)).toEqual([counts])
      expect(report.commits.flatMap((commit) => commit.mismatches)).toEqual([])
    },
    1_200_000
  )
})

describe("a step on a machine with no jail", () => {
  /** A machine's own `docker`: it says it ran, and passes. */
  const machine = () => {
    const tools = directory("tools")
    const log = join(tools, "calls")
    writeFileSync(join(tools, "docker"), `#!/bin/sh\necho "docker $*" >> ${log}\nexit 0\n`)
    chmodSync(join(tools, "docker"), 0o755)
    return { log, path: `${tools}:${process.env["PATH"]}` }
  }
  const refusal = "bwrap is not on PATH (install the bubblewrap package)"

  it("starts a stand-in that refuses with one line where docker is, in the baseline and as a target", async () => {
    const out = directory("out")
    const { log, path } = machine()
    const root = repository([
      job("variable", `test -z "\${DOCKER_HOST+set}"`),
      job("docker", `docker compose up -d 2>> ${out}/docker`),
      job("podman", `podman info 2>> ${out}/podman`),
      // A script the reader cannot see into starts it the same way.
      job("script", `sh -c 'exec nerdctl ps' 2>> ${out}/nerdctl`)
    ])

    const { report, said } = await withPerson(
      { DOCKER_HOST: "unix:///var/run/docker.sock", PATH: path },
      () => replay(root, () => ({ refusal }), false)
    )

    const counts = { hit: 0, ran: 1, failed: 3, skipped: 0 }
    expect(report.commits.map((commit) => commit.baseline.counts)).toEqual([counts])
    expect(report.commits.map((commit) => commit.normal.counts)).toEqual([counts])
    expect(report.commits.flatMap((commit) => commit.mismatches)).toEqual([])
    for (const [program, args] of [["docker", "compose up -d"], ["podman", "info"], ["nerdctl", "ps"]] as const) {
      // The baseline's step and the target's each said so, at first and as a rerun, and nothing else.
      const lines = readFileSync(join(out, program), "utf8").trim().split("\n")
      expect([...new Set(lines)]).toEqual([refused(program, args)])
      expect(lines.length).toBeGreaterThanOrEqual(4)
    }
    // The machine's own docker, next on `PATH`, was never started.
    expect(existsSync(log)).toBe(false)
    expect(said.filter((line) => line.includes("jail"))).toEqual([unjailed(refusal)])
    expect(unjailed(refusal)).toContain("cannot push with git or start docker or podman by name")
  }, 1_200_000)

  it("starts the machine's docker and passes on DOCKER_HOST when the person allows Docker", async () => {
    const { log, path } = machine()
    const host = "tcp://daemon.example:2375"
    const root = repository([
      job("variable", `test "$DOCKER_HOST" = ${host}`),
      job("docker", "docker compose up -d")
    ])

    const { report, said } = await withPerson(
      { DOCKER_HOST: host, PATH: path },
      () => replay(root, () => ({ refusal }), true)
    )

    const counts = { hit: 0, ran: 2, failed: 0, skipped: 0 }
    expect(report.commits.map((commit) => commit.baseline.counts)).toEqual([counts])
    expect(report.commits.map((commit) => commit.normal.counts)).toEqual([counts])
    expect(report.commits.flatMap((commit) => commit.mismatches)).toEqual([])
    // The baseline's step and the target's each started it.
    const calls = readFileSync(log, "utf8").trim().split("\n")
    expect([...new Set(calls)]).toEqual(["docker compose up -d"])
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(said.filter((line) => line.includes("jail"))).toEqual([unjailed(refusal, true)])
    expect(unjailed(refusal, true)).toMatch(/cannot push with git$/)
  }, 1_200_000)
})

describe("the sockets of the container daemons", () => {
  it("are Docker's two names, the session's two, and the one DOCKER_HOST names", () => {
    expect(daemonSockets(1000, {})).toEqual([
      "/var/run/docker.sock",
      "/run/docker.sock",
      "/run/user/1000/docker.sock",
      "/run/user/1000/podman/podman.sock"
    ])
    expect(daemonSockets(1000, { XDG_RUNTIME_DIR: "/session", DOCKER_HOST: "unix:///srv/docker.sock" })).toEqual([
      "/var/run/docker.sock",
      "/run/docker.sock",
      "/session/docker.sock",
      "/session/podman/podman.sock",
      "/srv/docker.sock"
    ])
    // A socket named twice is hidden once, and a daemon on the network has no socket to hide.
    expect(daemonSockets(1000, { DOCKER_HOST: "unix:///run/docker.sock" })).toHaveLength(4)
    expect(daemonSockets(1000, { DOCKER_HOST: "tcp://daemon.example:2375" })).toHaveLength(4)
    expect(daemonSockets(1000, { DOCKER_HOST: "unix://" })).toHaveLength(4)
  })
})

describe("confine", () => {
  const scoped = <A>(work: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(Effect.scoped(work).pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A>)

  /** A machine with a daemon's socket under two names, another in the session's runtime directory, and one absent. */
  const machine = async () => {
    const home = directory("person")
    const runtime = directory("runtime")
    const run = directory("run")
    const socket = await daemon(join(run, "docker.sock"))
    const linked = join(directory("var-run"), "docker.sock")
    symlinkSync(socket, linked)
    const session = await daemon(join(runtime, "docker.sock"))
    const asked = () => ({
      bwrap: "/usr/bin/bwrap",
      home,
      hidden: [runtime],
      daemons: [linked, socket, session, join(run, "podman.sock")],
      tmp: "/tmp",
      caches: []
    })
    return { asked, runtime, session, socket }
  }

  it("hides each daemon's socket where it really is, once, and puts a stand-in for each container program", async () => {
    const { asked, runtime, socket } = await machine()
    const work = directory("work")
    const places = await withPerson(
      { DOCKER_HOST: `unix://${socket}` },
      () => scoped(confine(work, asked, () => Effect.void, [], false))
    )

    for (const place of Object.values(places)) {
      // The session's socket is out of sight with the runtime directory it lies in.
      expect(place.jail?.masks).toEqual([{ path: runtime, directory: true }, { path: socket, directory: false }])
      expect(place.daemon).toEqual({})
      expect(readdirSync(place.guard).sort()).toEqual([...guardedPrograms, ...containerPrograms].sort())
      for (const program of containerPrograms) {
        const said = execFileSync("sh", ["-c", `"$1" ps -a 2>&1; echo "exit $?"`, "sh", join(place.guard, program)], {
          encoding: "utf8"
        })
        expect(said).toBe(`${refused(program, "ps -a")}\nexit 1\n`)
      }
    }
  })

  it("hides no socket, keeps the session's, and puts no stand-in when the person allows Docker", async () => {
    const { asked, runtime, session, socket } = await machine()
    const work = directory("work")
    const places = await withPerson(
      { DOCKER_HOST: `unix://${socket}` },
      () => scoped(confine(work, asked, () => Effect.void, [], true))
    )

    for (const place of Object.values(places)) {
      expect(place.jail?.masks).toEqual([{ path: runtime, directory: true, kept: [session] }])
      expect(place.daemon).toEqual({ DOCKER_HOST: `unix://${socket}` })
      expect(readdirSync(place.guard).sort()).toEqual([...guardedPrograms].sort())
    }
  })
})

describe("the jail", () => {
  it("keeps what a hidden directory is told to keep, and seals the directory after", () => {
    const jail = {
      bwrap: "/usr/bin/bwrap",
      masks: [{ path: "/run/user/1000", directory: true, kept: ["/run/user/1000/docker.sock"] }],
      tmp: "/work/tmp",
      temporary: ["/tmp"],
      visible: [],
      filter: "/work/keyring-filter"
    }
    expect(jailed(jail, [], [], ["true"]).slice(15, 22)).toEqual([
      "--tmpfs",
      "/run/user/1000",
      "--bind",
      "/run/user/1000/docker.sock",
      "/run/user/1000/docker.sock",
      "--remount-ro",
      "/run/user/1000"
    ])
  })
})

describe("what a step is told", () => {
  const place = { home: "/replay/home/normal", tmp: "/replay/tmp/normal", guard: "/replay/guard" }

  it("looks for a program among the stand-ins first, also with a PATH of its own", () => {
    expect(placeEnvironment(place)["PATH"]?.split(":")[0]).toBe("/replay/guard")
    expect(stepEnvironment({}, place)["PATH"]?.split(":")[0]).toBe("/replay/guard")
    expect(stepEnvironment({ PATH: "/mine" }, place)["PATH"]).toBe("/replay/guard:/mine")
  })

  it("has a stand-in for each container program beside sudo's, and none for them when the person allows Docker", () => {
    expect(containerPrograms).toEqual(["docker", "docker-compose", "podman", "nerdctl"])
    expect(standIns(false).map(([program]) => program)).toEqual([...guardedPrograms, ...containerPrograms])
    expect(new Map(standIns(false)).get("podman")).toBe(guardScript("podman", withoutAllowDocker))
    expect(new Map(standIns(false)).get("sudo")).toBe(guardScript("sudo"))
    expect(standIns(true)).toEqual(guardedPrograms.map((program) => [program, guardScript(program)]))
  })

  it("is told where the person's container daemon is only when the person allows Docker", () => {
    expect(daemonVariables).toEqual(["DOCKER_HOST"])
    expect(daemonEnvironment(false, { DOCKER_HOST: "unix:///run/docker.sock" })).toEqual({})
    expect(daemonEnvironment(true, { DOCKER_HOST: "unix:///run/docker.sock" })).toEqual({
      DOCKER_HOST: "unix:///run/docker.sock"
    })
    expect(daemonEnvironment(true, {})).toEqual({})
    expect(stepEnvironment({}, place)["DOCKER_HOST"]).toBeUndefined()
  })
})
