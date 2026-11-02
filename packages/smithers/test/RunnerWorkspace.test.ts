// A runner's checkouts share one mirror per repository (src/runner/Workspace.ts). jj and git keep that mirror's
// operations, refs and worktrees in files, and ten `jj workspace add`s at once on one colocated mirror fail some of
// themselves ("Could not commit packed-ref transaction", or git's config lock). A runner with capacity above one starts
// jobs at once, so every command that changes a mirror runs one at a time per mirror.
import { resolveJjBinary } from "@smthrs/jj/node/resolveJjBinary"
import { Effect, Exit, Option } from "effect"
import { execFile, execFileSync, spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:http"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, expect, test } from "vitest"
import * as Workspace from "../src/runner/Workspace.ts"
import * as Host from "./fixtures/runner/host.ts"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-workspace-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const limits = { files: 10, bytes: 1024 }

test("ten checkouts of one mirror at once are each made, read and forgotten", async () => {
  const mirror = Host.mirror(root)
  const stateDir = join(root, "state")
  const checkouts = Array.from({ length: 10 }, (_, n) => Workspace.of(stateDir, `job-${n}`))
  const made = await Effect.runPromise(Effect.forEach(
    checkouts,
    (checkout) => Effect.exit(Workspace.create(mirror.path, mirror.base, checkout)),
    { concurrency: "unbounded" }
  ))
  expect(made.map((exit) => Exit.isSuccess(exit) ? "made" : String(exit.cause))).toEqual(checkouts.map(() => "made"))
  checkouts.forEach((checkout, n) => writeFileSync(join(checkout.dir, `file-${n}.txt`), `${n}\n`))
  const read = await Effect.runPromise(Effect.forEach(
    checkouts,
    (checkout) => Workspace.changes(checkout, mirror.base, limits, mirror.path),
    { concurrency: "unbounded" }
  ))
  expect(read.map((changes) => changes?.additions.map((file) => file.path))).toEqual(
    checkouts.map((_, n) => [`file-${n}.txt`])
  )
  await Effect.runPromise(Effect.forEach(checkouts, (checkout) => Workspace.remove(mirror.path, checkout), {
    concurrency: "unbounded"
  }))
  expect(checkouts.filter(Workspace.exists)).toEqual([])
}, 120_000)

// A private repository (decision 0148): the mirror is cloned and fetched over HTTPS with the host's credential, which
// git sends as a header from the command's own environment, never in its arguments or the URL. A real git smart-HTTP
// server on loopback (`git http-backend`) refuses any request without it.
const secret = "ghs_runner_workspace_secret"
const basic = Buffer.from(`x-access-token:${secret}`).toString("base64")

/** Plain git, for the fixtures: no system or global configuration. */
const git = (args: Array<string>, cwd?: string) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull }
  }).trim()

/** A private repository served at `remote`, which answers only `basic`; its first commit and its second. */
const serve = async () => {
  const source = join(root, "source")
  git(["init", "-q", "-b", "main", source])
  git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "--allow-empty", "-m", "base"], source)
  const first = git(["rev-parse", "HEAD"], source)
  writeFileSync(join(source, "README.md"), "private\n")
  git(["add", "README.md"], source)
  git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "readme"], source)
  const base = git(["rev-parse", "HEAD"], source)
  git(["clone", "-q", "--bare", source, join(root, "served", "private.git")])
  const seen: Array<string> = []
  const server = createServer((request, response) => {
    seen.push(request.url ?? "")
    if (request.headers.authorization?.toLowerCase() !== `basic ${basic}`.toLowerCase()) {
      response.writeHead(401, { "www-authenticate": "Basic realm=\"test\"" }).end()
      return
    }
    const url = new URL(request.url ?? "/", "http://localhost")
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: join(root, "served"),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        REMOTE_USER: "x-access-token"
      }
    })
    request.pipe(cgi.stdin)
    let head = Buffer.alloc(0)
    let started = false
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (started) return void response.write(chunk)
      head = Buffer.concat([head, chunk])
      const end = head.indexOf("\r\n\r\n")
      if (end < 0) return
      started = true
      const headers: Record<string, string> = {}
      let status = 200
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const [name, ...rest] = line.split(":")
        if (name!.toLowerCase() === "status") status = Number(rest.join(":").trim().split(" ")[0])
        else headers[name!] = rest.join(":").trim()
      }
      response.writeHead(status, headers)
      response.write(head.subarray(end + 4))
    })
    cgi.stdout.on("end", () => response.end())
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const remote = `http://127.0.0.1:${(server.address() as { port: number }).port}/private.git`
  const credential = { remote, username: "x-access-token", password: secret }
  const close = () => new Promise<void>((done) => server.close(() => done()))
  /** A new commit on the served repository, which a mirror cloned before lacks: its id. */
  const advance = () => {
    git(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "--allow-empty", "-m", "later"], source)
    git(["push", "-q", join(root, "served", "private.git"), "main"], source)
    return git(["rev-parse", "HEAD"], source)
  }
  return { remote, first, base, seen, credential, close, advance }
}

/** A credential the checkout asks for, counted. */
const counted = (credential: Workspace.GitCredential | undefined) => {
  const asked = { count: 0 }
  const effect = Effect.sync(() => {
    asked.count++
    return Option.fromNullishOr(credential)
  })
  return { asked, effect }
}

const made = (exit: Exit.Exit<unknown, unknown>) => Exit.isSuccess(exit) ? "made" : String(exit.cause)

/** Runs `body` with `env` set on this process, as the runner's own environment, then puts it back. */
const withEnv = async <A>(env: Record<string, string>, body: () => Promise<A>): Promise<A> => {
  const before = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]))
  Object.assign(process.env, env)
  try {
    return await body()
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test(
  "a missing mirror is cloned with the job's credential; without it, or with a wrong one, nothing is fetched",
  async () => {
    const served = await serve()
    try {
      const stateDir = join(root, "state")
      const missing = (name: string) => join(root, `mirror-${name}`)
      // No credential: a missing mirror is never cloned.
      const none = counted(undefined)
      expect(
        made(
          await Effect.runPromise(
            Effect.exit(Workspace.create(missing("none"), served.base, Workspace.of(stateDir, "none"), none.effect))
          )
        )
      )
        .not.toBe("made")
      expect(none.asked.count).toBe(1)
      // A wrong credential: git is refused.
      const wrong = counted({ ...served.credential, password: "wrong" })
      expect(
        made(
          await Effect.runPromise(
            Effect.exit(Workspace.create(missing("wrong"), served.base, Workspace.of(stateDir, "wrong"), wrong.effect))
          )
        )
      )
        .not.toBe("made")
      // The job's credential: cloned, checked out at the base, never in a URL.
      const right = counted(served.credential)
      const checkout = Workspace.of(stateDir, "right")
      expect(
        made(
          await Effect.runPromise(Effect.exit(Workspace.create(missing("right"), served.base, checkout, right.effect)))
        )
      ).toBe("made")
      expect(readFileSync(join(checkout.dir, "README.md"), "utf8")).toBe("private\n")
      expect(served.seen.every((path) => !path.includes(secret))).toBe(true)
    } finally {
      await served.close()
    }
  },
  120_000
)

test("the credential is asked for only when the mirror must fetch, and a refusal stops the fetch", async () => {
  const served = await serve()
  try {
    const stateDir = join(root, "state")
    const mirror = join(root, "mirror")
    // A missing mirror is cloned with it.
    const cloned = counted(served.credential)
    expect(
      made(
        await Effect.runPromise(
          Effect.exit(Workspace.create(mirror, served.first, Workspace.of(stateDir, "a"), cloned.effect))
        )
      )
    )
      .toBe("made")
    expect(cloned.asked.count).toBe(1)
    // A base the mirror has: no credential is asked for, so a host that would refuse is never asked.
    const unused = Effect.sync(() => {
      throw new Error("never asked")
    })
    expect(
      made(
        await Effect.runPromise(
          Effect.exit(Workspace.create(mirror, served.first, Workspace.of(stateDir, "b"), unused))
        )
      )
    )
      .toBe("made")
    // A refusal: the error is the refusal's, and nothing is fetched.
    const before = served.seen.length
    const refused = await Effect.runPromise(
      Effect.exit(
        Workspace.create(mirror, "f".repeat(40), Workspace.of(stateDir, "c"), Effect.fail("refused" as const))
      )
    )
    expect(refused).toEqual(Exit.fail("refused"))
    expect(served.seen.length).toBe(before)
  } finally {
    await served.close()
  }
}, 120_000)

// Astra's finding: with GIT_TRACE2_EVENT and GIT_TRACE2_ENV_VARS=GIT_CONFIG_VALUE_0 in the runner's environment, git
// wrote the reversible header to the trace file. The control proves the same environment makes plain git write it.
test("git tracing in the runner's environment or git's global configuration never records the credential", async () => {
  const served = await serve()
  const traces = join(root, "traces")
  mkdirSync(traces)
  const home = join(root, "home")
  mkdirSync(home)
  writeFileSync(
    join(home, ".gitconfig"),
    `[trace2]\n\teventTarget = ${join(traces, "global-event")}\n\tenvVars = GIT_CONFIG_VALUE_0\n`
  )
  const tracing = {
    HOME: home,
    GIT_TRACE: join(traces, "trace"),
    GIT_TRACE2: join(traces, "trace2"),
    GIT_TRACE2_EVENT: join(traces, "event"),
    GIT_TRACE2_PERF: join(traces, "perf"),
    GIT_TRACE2_ENV_VARS: "GIT_CONFIG_VALUE_0,GIT_CONFIG_PARAMETERS",
    GIT_TRACE_CURL: join(traces, "curl"),
    GIT_TRACE_CURL_NO_DATA: "0",
    GIT_TRACE_REDACT: "0",
    GIT_CURL_VERBOSE: "1",
    GIT_TRACE_PACKET: join(traces, "packet")
  }
  const recorded = () => readdirSync(traces).map((name) => readFileSync(join(traces, name), "utf8")).join("\n")
  try {
    // The control: plain git, with the credential's environment, records it.
    // Asynchronously: the server answering it runs on this process's event loop.
    await promisify(execFile)("git", ["ls-remote", served.remote], {
      env: { ...process.env, ...tracing, ...Workspace.gitAuthEnv(served.credential) }
    })
    expect(recorded()).toContain(basic)
    rmSync(traces, { recursive: true, force: true })
    mkdirSync(traces)
    const exit = await withEnv(
      tracing,
      () =>
        Effect.runPromise(
          Effect.exit(
            Workspace.create(
              join(root, "mirror"),
              served.base,
              Workspace.of(join(root, "state"), "t"),
              Effect.succeed(Option.some(served.credential))
            )
          )
        )
    )
    expect(made(exit)).toBe("made")
    const written = recorded()
    expect(written).not.toContain(secret)
    expect(written).not.toContain(basic)
  } finally {
    await served.close()
  }
}, 120_000)

// Sol's finding: an agent running as the runner's user can set `git.executable-path` in the mirror's jj configuration
// (`jj config set --repo` from its checkout) to a wrapper that reads the next fetch's environment.
test(
  "jj configuration an agent writes for the mirror can't run another git, or a hook, with the credential",
  async () => {
    const served = await serve()
    const xdg = join(root, "xdg")
    const captured = join(root, "captured")
    const evil = join(root, "evil-git")
    writeFileSync(evil, `#!/bin/sh\nenv > "${captured}"\nexec git "$@"\n`)
    chmodSync(evil, 0o755)
    try {
      await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
        const mirror = join(root, "mirror")
        const stateDir = join(root, "state")
        expect(
          made(
            await Effect.runPromise(
              Effect.exit(
                Workspace.create(
                  mirror,
                  served.first,
                  Workspace.of(stateDir, "a"),
                  Effect.succeed(Option.some(served.credential))
                )
              )
            )
          )
        )
          .toBe("made")
        // The agent, from its checkout, with the runner's own user configuration directory.
        execFileSync(resolveJjBinary().path, ["config", "set", "--repo", "git.executable-path", evil], {
          cwd: Workspace.of(stateDir, "a").dir,
          env: { ...process.env, XDG_CONFIG_HOME: xdg },
          stdio: "ignore"
        })
        // The control: the mirror's jj configuration does name the wrapper.
        expect(
          execFileSync(resolveJjBinary().path, ["config", "get", "git.executable-path"], {
            cwd: mirror,
            env: { ...process.env, XDG_CONFIG_HOME: xdg },
            encoding: "utf8"
          }).trim()
        ).toBe(evil)
        // A fetch for a commit the mirror lacks: the runner's own git, whatever the mirror's jj configuration names.
        const later = served.advance()
        const exit = await Effect.runPromise(
          Effect.exit(
            Workspace.create(
              mirror,
              later,
              Workspace.of(stateDir, "b"),
              Effect.succeed(Option.some(served.credential))
            )
          )
        )
        expect(made(exit)).toBe("made")
        expect(existsSync(captured)).toBe(false)
        // A hook in the mirror's git store, which a fetch's ref updates would run with the credential's environment.
        // The mirror is colocated (`.git`) or keeps its git store under `.jj`: a hook in whichever it has.
        for (const store of [join(mirror, ".git"), join(mirror, ".jj", "repo", "store", "git")]) {
          if (!existsSync(join(store, "HEAD"))) continue
          mkdirSync(join(store, "hooks"), { recursive: true })
          writeFileSync(join(store, "hooks", "reference-transaction"), `#!/bin/sh\nenv > "${captured}"\n`)
          chmodSync(join(store, "hooks", "reference-transaction"), 0o755)
        }
        const again = served.advance()
        const second = await Effect.runPromise(
          Effect.exit(
            Workspace.create(
              mirror,
              again,
              Workspace.of(stateDir, "c"),
              Effect.succeed(Option.some(served.credential))
            )
          )
        )
        expect(made(second)).toBe("made")
        // jj may run git for its own bookkeeping, which runs the hook; never a command with the credential.
        const seen = existsSync(captured) ? readFileSync(captured, "utf8") : ""
        expect(seen).not.toContain(secret)
        expect(seen).not.toContain(basic)
      })
    } finally {
      await served.close()
    }
  },
  120_000
)

test("a credentialed command's environment drops git's tracing and outside configuration; any other keeps the runner's", () => {
  const base = {
    PATH: "/bin",
    GIT_TRACE2_EVENT: "/tmp/e",
    GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'",
    GIT_EXEC_PATH: "/x",
    JJ_USER: "u",
    GIT_SSH_COMMAND: "ssh -i key"
  }
  const credentialed = Workspace.commandEnv(base, { GIT_CONFIG_COUNT: "1" }, true)
  expect(credentialed).toMatchObject({
    PATH: "/bin",
    GIT_TRACE2_EVENT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_COUNT: "1",
    GIT_SSH_COMMAND: "ssh -i key"
  })
  expect(Object.keys(credentialed)).not.toContain("GIT_CONFIG_PARAMETERS")
  expect(Object.keys(credentialed)).not.toContain("GIT_EXEC_PATH")
  expect(Object.keys(credentialed)).not.toContain("JJ_USER")
  // A public repository's fetch keeps the runner's own git setup, such as a deploy key's.
  expect(Workspace.commandEnv(base, {}, false)).toMatchObject({
    GIT_SSH_COMMAND: "ssh -i key",
    GIT_CONFIG_PARAMETERS: base.GIT_CONFIG_PARAMETERS
  })
})
