// A runner's checkouts share one mirror per repository (src/runner/Workspace.ts). jj and git keep that mirror's
// operations, refs and worktrees in files, and ten `jj workspace add`s at once on one colocated mirror fail some of
// themselves ("Could not commit packed-ref transaction", or git's config lock). A runner with capacity above one starts
// jobs at once, so every command that changes a mirror runs one at a time per mirror.
import { resolveJjBinary } from "@smthrs/jj/node/resolveJjBinary"
import { Effect, Exit, Fiber, Option } from "effect"
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

// Issue #5144: an added path was read with `statSync` and `readFileSync`, which follow symbolic links, so a checkout
// path linked to a file outside it (the runner's token, a provider login) uploaded that file's bytes as its contents.
const refusedAt = (
  checkout: Workspace.Checkout,
  mirror: { readonly path: string; readonly base: string }
) =>
  Effect.runPromise(
    Workspace.changes(checkout, mirror.base, limits, mirror.path).pipe(
      Effect.match({ onFailure: (error) => error.step, onSuccess: (changes) => JSON.stringify(changes) })
    )
  )

test("an added symbolic link fails the read and uploads nothing of its target", async () => {
  const mirror = Host.mirror(root)
  const checkout = Workspace.of(join(root, "state"), "linked")
  expect(made(await Effect.runPromise(Effect.exit(Workspace.create(mirror.path, mirror.base, checkout))))).toBe("made")
  writeFileSync(join(root, "runner-token"), "synthetic-runner-secret")
  symlinkSync(join(root, "runner-token"), join(checkout.dir, "result.txt"))
  writeFileSync(join(checkout.dir, "plain.txt"), "plain\n")
  expect(await refusedAt(checkout, mirror)).toBe("read")
  // A link that stays inside the checkout is still a link the change can't carry, never its target's copy.
  rmSync(join(checkout.dir, "result.txt"))
  symlinkSync("plain.txt", join(checkout.dir, "result.txt"))
  expect(await refusedAt(checkout, mirror)).toBe("read")
  rmSync(join(checkout.dir, "result.txt"))
  const read = await Effect.runPromise(Workspace.changes(checkout, mirror.base, limits, mirror.path))
  expect(read?.additions).toEqual([{ path: "plain.txt", contents: Buffer.from("plain\n").toString("base64") }])
}, 120_000)

test("a parent directory swapped for a symbolic link after the diff fails the read", async () => {
  const mirror = Host.mirror(root)
  const checkout = Workspace.of(join(root, "state"), "parent")
  expect(made(await Effect.runPromise(Effect.exit(Workspace.create(mirror.path, mirror.base, checkout))))).toBe("made")
  mkdirSync(join(checkout.dir, "sub"))
  writeFileSync(join(checkout.dir, "sub", "result.txt"), "in the checkout\n")
  const outside = join(root, "outside")
  mkdirSync(outside)
  writeFileSync(join(outside, "result.txt"), "synthetic-runner-secret")
  // The diff lists `sub/result.txt` from a real directory; then `sub` becomes a link to a directory outside.
  const fake = join(root, "fake-jj")
  writeFileSync(
    fake,
    `#!/bin/sh\n"${resolveJjBinary().path}" "$@" || exit $?\nif [ "$3" = diff ]; then rm -rf "${checkout.dir}/sub" && ln -s "${outside}" "${checkout.dir}/sub"; fi\n`
  )
  chmodSync(fake, 0o755)
  expect(await withEnv({ SMITHERS_JJ_PATH: fake }, () => refusedAt(checkout, mirror))).toBe("read")
}, 120_000)

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

test("a credentialed command's environment has none of the runner's GIT_* or jj's; any other keeps the runner's", () => {
  const base = {
    PATH: "/bin",
    HTTPS_PROXY: "http://proxy.internal:3128",
    GIT_TRACE2_EVENT: "/tmp/e",
    GIT_CURL_VERBOSE: "0",
    GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'",
    GIT_EXEC_PATH: "/x",
    GIT_SSH_COMMAND: "ssh -i key",
    GIT_ASKPASS: "/x/askpass",
    GIT_SSL_NO_VERIFY: "1",
    SSH_ASKPASS: "/x/askpass",
    JJ_USER: "u",
    RUST_LOG: "trace"
  }
  const credentialed = Workspace.commandEnv(base, { GIT_CONFIG_COUNT: "1" }, true)
  expect(credentialed).toEqual({
    PATH: "/bin",
    HTTPS_PROXY: "http://proxy.internal:3128",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_COUNT: "1"
  })
  // Astra: git turns curl's tracing on when GIT_CURL_VERBOSE is set at all, "0" included; it is never set.
  expect(Object.keys(credentialed)).not.toContain("GIT_CURL_VERBOSE")
  // A public repository's fetch keeps the runner's own git setup, such as a deploy key's.
  expect(Workspace.commandEnv(base, {}, false)).toMatchObject({
    GIT_SSH_COMMAND: "ssh -i key",
    GIT_CONFIG_PARAMETERS: base.GIT_CONFIG_PARAMETERS
  })
})

test("a credential goes only to an HTTPS remote, or HTTP on loopback, with nothing but a host and path", () => {
  expect(Workspace.trustedRemote("https://github.com/acme/app.git")?.href).toBe("https://github.com/acme/app.git")
  expect(Workspace.trustedRemote("http://127.0.0.1:8080/app.git")?.href).toBe("http://127.0.0.1:8080/app.git")
  for (
    const remote of [
      "http://github.com/acme/app.git",
      "ssh://git@github.com/acme/app.git",
      "git@github.com:acme/app.git",
      "file:///tmp/app.git",
      "https://user:pass@github.com/acme/app.git",
      "https://github.com/acme/app.git?x=1",
      "https://github.com/acme/app.git#x",
      "not a url"
    ]
  ) expect(Workspace.trustedRemote(remote)).toBeUndefined()
})

/** A server that records each request's path and Authorization header, and answers 401. */
const capturing = async () => {
  const requests: Array<string> = []
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`)
    response.writeHead(401, { "www-authenticate": "Basic realm=\"capture\"" }).end()
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { url, requests, close: () => new Promise<void>((done) => server.close(() => done())) }
}

/** The mirror's git store, colocated (`.git`) or under `.jj`. */
const gitStoreOf = (mirror: string) =>
  [join(mirror, ".git"), join(mirror, ".jj", "repo", "store", "git")].find((store) => existsSync(join(store, "HEAD")))!

// Astra's review of 5fc33348: the credentialed fetch ran in the mirror, whose git configuration an agent writes from its
// checkout. A remote changed to SSH with `core.sshCommand`, a remote that answers 401 with `credential.helper`, a proxy,
// a CA, a URL rewrite or an included file each ran a program with the credential's environment or sent the header
// elsewhere. The fetch now runs in a store only the runner writes, against the credential's own remote.
test("git configuration an agent plants in the mirror or the fetch store never sees the credential", async () => {
  const served = await serve()
  const capture = await capturing()
  const captured = join(root, "captured")
  mkdirSync(captured)
  const spy = (name: string) => {
    const path = join(root, `spy-${name}`)
    writeFileSync(path, `#!/bin/sh\nenv > "${join(captured, name)}"\nexit 1\n`)
    chmodSync(path, 0o755)
    return path
  }
  try {
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
    ).toBe("made")
    const store = gitStoreOf(mirror)
    const plant = (file: string, key: string, value: string) => git(["config", "--file", file, "--add", key, value])
    const included = join(root, "included.gitconfig")
    writeFileSync(included, `[core]\n\tsshCommand = ${spy("included-ssh")}\n`)
    const mirrorConfig = join(store, "config")
    git(["config", "--file", mirrorConfig, "remote.origin.url", `ssh://git@127.0.0.1:1/private.git`])
    plant(mirrorConfig, "core.sshCommand", spy("ssh"))
    plant(mirrorConfig, "credential.helper", spy("helper"))
    plant(mirrorConfig, "core.askPass", spy("askpass"))
    plant(mirrorConfig, "http.proxy", capture.url)
    plant(mirrorConfig, "http.sslCAInfo", join(root, "evil-ca.pem"))
    plant(mirrorConfig, "include.path", included)
    plant(mirrorConfig, "core.fsmonitor", spy("fsmonitor"))
    // The control: plain git in the mirror, with the credential's environment, sends the header to the capture's
    // proxy, and on its 401 runs the planted helper with the credential in its environment.
    await promisify(execFile)("git", [`--git-dir=${store}`, "ls-remote", served.remote], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
        ...Workspace.gitAuthEnv(served.credential)
      }
    }).catch(() => undefined)
    expect(capture.requests.join("\n")).toContain(basic)
    expect(readFileSync(join(captured, "helper"), "utf8")).toContain(basic)
    capture.requests.length = 0
    rmSync(captured, { recursive: true, force: true })
    mkdirSync(captured)
    // A rewrite of the credential's remote to the capture, after the control so it doesn't hide the proxy there.
    plant(mirrorConfig, `url.${capture.url}/.insteadOf`, served.remote.replace(/private\.git$/, ""))
    // The fetch store, as an agent that found it would leave it.
    const fetchStore = Workspace.fetchStoreOf(realpathSync(stateDir), mirror)
    expect(existsSync(join(fetchStore, "HEAD"))).toBe(true)
    plant(join(fetchStore, "config"), "http.proxy", capture.url)
    plant(join(fetchStore, "config"), "credential.helper", spy("store-helper"))
    plant(join(fetchStore, "config"), "include.path", included)
    mkdirSync(join(fetchStore, "hooks"), { recursive: true })
    writeFileSync(join(fetchStore, "hooks", "reference-transaction"), `#!/bin/sh\nenv > "${join(captured, "hook")}"\n`)
    chmodSync(join(fetchStore, "hooks", "reference-transaction"), 0o755)
    mkdirSync(join(fetchStore, "objects", "info"), { recursive: true })
    writeFileSync(join(fetchStore, "objects", "info", "alternates"), `${join(root, "nowhere")}\n`)
    // A fetch for a commit the mirror lacks: the credential's own remote, the runner's configuration.
    const later = served.advance()
    const exit = await Effect.runPromise(
      Effect.exit(
        Workspace.create(mirror, later, Workspace.of(stateDir, "b"), Effect.succeed(Option.some(served.credential)))
      )
    )
    expect(made(exit)).toBe("made")
    expect(capture.requests).toEqual([])
    const seen = readdirSync(captured).map((name) => readFileSync(join(captured, name), "utf8")).join("\n")
    expect(seen).not.toContain(secret)
    expect(seen).not.toContain(basic)
    expect(served.seen.every((path) => !path.includes(secret))).toBe(true)
    // The mirror's own configuration is the agent's still: the runner leaves it as it found it.
    expect(git(["config", "--file", mirrorConfig, "http.proxy"])).toBe(capture.url)
  } finally {
    await Promise.all([served.close(), capture.close()])
  }
}, 120_000)

/** Every link under `dir`, walked without following one. */
const linksUnder = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isSymbolicLink()
      ? [join(dir, entry.name)]
      : entry.isDirectory()
      ? linksUnder(join(dir, entry.name))
      : []
  )

// Astra's review of 4cd69527: only the store's own directory was checked, so a link planted on the way to it, or in its
// retained objects, `objects/info` or refs, made the cleanup remove files elsewhere and the fetch write there.
test(
  "a link planted on the way to the fetch store or inside it is never followed: removed, and the store made anew",
  async () => {
    const served = await serve()
    const outside = join(root, "outside")
    mkdirSync(join(outside, "fetch-target"), { recursive: true })
    mkdirSync(join(outside, "info-target"), { recursive: true })
    mkdirSync(join(outside, "refs-target", "heads"), { recursive: true })
    writeFileSync(join(outside, "fetch-target", "keep"), "keep\n")
    writeFileSync(join(outside, "info-target", "alternates"), "keep\n")
    writeFileSync(join(outside, "info-target", "http-alternates"), "keep\n")
    writeFileSync(join(outside, "refs-target", "heads", "keep"), "keep\n")
    const snapshot = () =>
      ["fetch-target/keep", "info-target/alternates", "info-target/http-alternates", "refs-target/heads/keep"].map(
        (path) => existsSync(join(outside, path)) ? readFileSync(join(outside, path), "utf8") : "gone"
      )
    try {
      const mirror = join(root, "mirror")
      const stateDir = join(root, "state")
      // On the way: the stores' own directory is a link to elsewhere before the first fetch.
      mkdirSync(stateDir, { recursive: true })
      symlinkSync(join(outside, "fetch-target"), join(stateDir, "fetch"))
      const first = await Effect.runPromise(
        Effect.exit(
          Workspace.create(
            mirror,
            served.first,
            Workspace.of(stateDir, "a"),
            Effect.succeed(Option.some(served.credential))
          )
        )
      )
      expect(made(first)).toBe("made")
      expect(readdirSync(join(outside, "fetch-target"))).toEqual(["keep"])
      const store = Workspace.fetchStoreOf(realpathSync(stateDir), mirror)
      expect(existsSync(join(store, "HEAD"))).toBe(true)
      // Inside: `objects/info` and `refs` are links to elsewhere.
      rmSync(join(store, "objects", "info"), { recursive: true, force: true })
      symlinkSync(join(outside, "info-target"), join(store, "objects", "info"))
      rmSync(join(store, "refs"), { recursive: true, force: true })
      symlinkSync(join(outside, "refs-target"), join(store, "refs"))
      const later = served.advance()
      const second = await Effect.runPromise(
        Effect.exit(
          Workspace.create(mirror, later, Workspace.of(stateDir, "b"), Effect.succeed(Option.some(served.credential)))
        )
      )
      expect(made(second)).toBe("made")
      expect(snapshot()).toEqual(["keep\n", "keep\n", "keep\n", "keep\n"])
      expect(readdirSync(join(outside, "refs-target", "heads"))).toEqual(["keep"])
      expect(linksUnder(join(realpathSync(stateDir), "fetch"))).toEqual([])
    } finally {
      await served.close()
    }
  },
  120_000
)

test("a remote that isn't HTTPS, or HTTP on loopback, is never fetched with a credential", async () => {
  const capture = await capturing()
  try {
    for (const remote of [capture.url.replace("127.0.0.1", "localhost.invalid"), "ssh://git@127.0.0.1:1/x.git"]) {
      const exit = await Effect.runPromise(
        Effect.exit(
          Workspace.create(
            join(root, `mirror-${capture.requests.length}-${remote.length}`),
            "f".repeat(40),
            Workspace.of(join(root, "state"), remote),
            Effect.succeed(Option.some({ remote, username: "x-access-token", password: secret }))
          )
        )
      )
      expect(made(exit)).not.toBe("made")
    }
    expect(capture.requests).toEqual([])
  } finally {
    await capture.close()
  }
})

/** Whether `name` is a workspace of `mirror`, as jj lists them. */
const listed = (mirror: string, name: string) =>
  execFileSync(resolveJjBinary().path, ["-R", mirror, "workspace", "list", "-T", "name ++ \"\\n\""], {
    encoding: "utf8",
    env: { ...process.env, JJ_CONFIG: join(root, "jj-config-for-listing") }
  }).split("\n").includes(name)

const until = async (condition: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`not within ${timeoutMs} ms`)
    await new Promise((done) => setTimeout(done, 25))
  }
}

// Astra's review of 8ff1df66: the forget's exit code was ignored, so a forget that failed (the mirror's lock held, or
// out of time) still deleted the checkout and the owed removal's record, and the mirror kept the workspace for good.
test("a removal whose forget fails stays owed, and a later sweep, after a restart too, does it", async () => {
  const mirror = Host.mirror(root)
  const stateDir = join(root, "state")
  const checkout = Workspace.of(stateDir, "owed")
  expect(made(await Effect.runPromise(Effect.exit(Workspace.create(mirror.path, mirror.base, checkout))))).toBe("made")
  await Effect.runPromise(Workspace.scheduleRemoval(mirror.path, checkout))
  const record = join(stateDir, "removals", `${checkout.name}.json`)
  const failing = join(root, "failing")
  const fake = join(root, "fake-jj")
  writeFileSync(
    fake,
    `#!/bin/sh\nif [ -f "${failing}" ] && [ "$3" = workspace ] && [ "$4" = forget ]; then echo "lock held" >&2; exit 1; fi\nexec "${resolveJjBinary().path}" "$@"\n`
  )
  chmodSync(fake, 0o755)
  writeFileSync(failing, "")
  await withEnv({ SMITHERS_JJ_PATH: fake }, async () => {
    await Effect.runPromise(Workspace.sweep(stateDir))
    expect(existsSync(record)).toBe(true)
    expect(existsSync(checkout.dir)).toBe(true)
    expect(listed(mirror.path, checkout.name)).toBe(true)
    // The lock let go; a runner started again sweeps what is owed from disk.
    rmSync(failing)
    await Effect.runPromise(Workspace.sweep(stateDir))
  })
  expect(existsSync(record)).toBe(false)
  expect(existsSync(checkout.dir)).toBe(false)
  expect(listed(mirror.path, checkout.name)).toBe(false)
}, 120_000)

// Astra's review of 8ff1df66: a checkout was deleted with a synchronous `rmSync`, so a large one, or a slow filesystem,
// stopped the runner's event loop (Stop, lost claims, deadlines, every job's heartbeat) and no timeout could interrupt it.
test("a slow deletion leaves the event loop free, and an interrupted one is killed whole and stays owed", async () => {
  const mirror = Host.mirror(root)
  const stateDir = join(root, "state")
  const checkout = Workspace.of(stateDir, "slow")
  expect(made(await Effect.runPromise(Effect.exit(Workspace.create(mirror.path, mirror.base, checkout))))).toBe("made")
  const bin = join(root, "bin")
  mkdirSync(bin)
  const pids = join(root, "rm-pids")
  writeFileSync(join(bin, "rm"), `#!/bin/sh\necho $$ >> "${pids}"\nsleep 60\nexec /bin/rm "$@"\n`)
  chmodSync(join(bin, "rm"), 0o755)
  await withEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` }, async () => {
    const removing = Effect.runFork(Workspace.remove(mirror.path, checkout))
    await until(() => existsSync(pids), 30_000)
    // The loop answers a timer on time while `rm` runs.
    const asked = Date.now()
    await new Promise((done) => setTimeout(done, 100))
    expect(Date.now() - asked).toBeLessThan(1_000)
    const interrupted = Date.now()
    await Effect.runPromise(Fiber.interrupt(removing))
    expect(Date.now() - interrupted).toBeLessThan(15_000)
  })
  const pid = Number(readFileSync(pids, "utf8").trim().split("\n")[0])
  expect(alive(pid)).toBe(false)
  // Interrupted, nothing was deleted: the removal is done again later.
  expect(existsSync(checkout.dir)).toBe(true)
}, 120_000)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Astra's review of f7b3de5f and 281a40d4: `existsSync` answers false for a path it can't stat (EACCES, EIO) as for one
// that isn't there, so a mirror or checkout the runner couldn't read was taken as gone, and its owed removal dropped.
test(
  "a mirror or checkout the runner can't stat is not taken as gone: the removal stays owed until it can",
  async () => {
    // The mirror in a directory of its own, which is made unreadable.
    const box = join(root, "box")
    mkdirSync(box)
    const mirror = Host.mirror(box)
    const stateDir = join(root, "state")
    const checkout = Workspace.of(stateDir, "unreadable")
    expect(made(await Effect.runPromise(Effect.exit(Workspace.create(mirror.path, mirror.base, checkout))))).toBe(
      "made"
    )
    await Effect.runPromise(Workspace.scheduleRemoval(mirror.path, checkout))
    const record = join(stateDir, "removals", `${checkout.name}.json`)
    chmodSync(box, 0o000)
    try {
      await Effect.runPromise(Workspace.sweep(stateDir))
      expect(existsSync(record)).toBe(true)
    } finally {
      chmodSync(box, 0o755)
    }
    expect(existsSync(checkout.dir)).toBe(true)
    expect(listed(mirror.path, checkout.name)).toBe(true)
    // Readable again: done.
    await Effect.runPromise(Workspace.sweep(stateDir))
    expect(existsSync(record)).toBe(false)
    expect(existsSync(checkout.dir)).toBe(false)
    expect(listed(mirror.path, checkout.name)).toBe(false)
    // The checkout's directory can't be stat'ed (its parent unreadable) once the mirror forgot it: still owed.
    const second = Workspace.of(stateDir, "unreadable-dir")
    expect(made(await Effect.runPromise(Effect.exit(Workspace.create(mirror.path, mirror.base, second))))).toBe("made")
    await Effect.runPromise(Workspace.scheduleRemoval(mirror.path, second))
    const secondRecord = join(stateDir, "removals", `${second.name}.json`)
    const work = join(stateDir, "work")
    chmodSync(work, 0o000)
    try {
      await Effect.runPromise(Workspace.sweep(stateDir))
      expect(existsSync(secondRecord)).toBe(true)
    } finally {
      chmodSync(work, 0o755)
    }
    expect(existsSync(second.dir)).toBe(true)
    await Effect.runPromise(Workspace.sweep(stateDir))
    expect(existsSync(secondRecord)).toBe(false)
    expect(existsSync(second.dir)).toBe(false)
  },
  120_000
)

// Astra's review of f7b3de5f and 281a40d4: the sweep read and unlinked its records unguarded, so a removals directory it
// couldn't read, or a record it couldn't unlink, failed it as a defect, which ended the serve loop's sweep fiber for good.
test("a sweep that can't read or unlink its records fails nothing, and a later sweep does what is owed", async () => {
  const mirror = Host.mirror(root)
  const stateDir = join(root, "state")
  const checkout = Workspace.of(stateDir, "sweep-errors")
  expect(made(await Effect.runPromise(Effect.exit(Workspace.create(mirror.path, mirror.base, checkout))))).toBe("made")
  await Effect.runPromise(Workspace.scheduleRemoval(mirror.path, checkout))
  const removals = join(stateDir, "removals")
  const record = join(removals, `${checkout.name}.json`)
  // The records can't be listed.
  chmodSync(removals, 0o000)
  try {
    expect(Exit.isSuccess(await Effect.runPromise(Effect.exit(Workspace.sweep(stateDir))))).toBe(true)
  } finally {
    chmodSync(removals, 0o755)
  }
  expect(existsSync(checkout.dir)).toBe(true)
  // The removal is done, but its record can't be unlinked.
  chmodSync(removals, 0o500)
  try {
    expect(Exit.isSuccess(await Effect.runPromise(Effect.exit(Workspace.sweep(stateDir))))).toBe(true)
  } finally {
    chmodSync(removals, 0o755)
  }
  expect(existsSync(checkout.dir)).toBe(false)
  expect(existsSync(record)).toBe(true)
  // Recovered: the next sweep finds the removal done and drops the record.
  expect(Exit.isSuccess(await Effect.runPromise(Effect.exit(Workspace.sweep(stateDir))))).toBe(true)
  expect(existsSync(record)).toBe(false)
}, 120_000)

// A state directory two runners share, or a process id reused since a crash: a group is ended only when the runner that
// recorded it is gone, and its leader is still the process recorded.
test("reaping ends only a dead runner's group, led by the process it recorded", async () => {
  const stateDir = join(root, "state")
  const groups = join(stateDir, "groups")
  mkdirSync(groups, { recursive: true })
  const leader = () => {
    const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })
    children.push(child)
    return child
  }
  const record = (pid: number, owner: number, command = "sleep") =>
    writeFileSync(join(groups, `${pid}.json`), JSON.stringify({ pid, owner, command, startedAt: Date.now() }))
  const ownerAlive = spawn("sleep", ["300"], { stdio: "ignore" })
  children.push(ownerAlive)
  const ownerDead = spawn("true", [], { stdio: "ignore" })
  await new Promise((done) => ownerDead.once("exit", done))
  const liveRunners = leader()
  const reused = leader()
  const orphan = leader()
  record(liveRunners.pid!, ownerAlive.pid!)
  record(reused.pid!, ownerDead.pid!, "jj")
  record(orphan.pid!, ownerDead.pid!)
  await Effect.runPromise(Workspace.reapGroups(stateDir))
  await until(() => !alive(orphan.pid!), 10_000)
  expect(alive(liveRunners.pid!)).toBe(true)
  expect(alive(reused.pid!)).toBe(true)
  // A live runner's record stays; the others are settled.
  expect(readdirSync(groups)).toEqual([`${liveRunners.pid!}.json`])
}, 60_000)

// Astra's review of the route-on stack: the record of a finished command was unlinked unguarded in the child's event
// callback, so an error under groups/ escaped and could end the runner; and a record that couldn't be read, or a process
// that couldn't be inspected, was dropped, losing the only way to reap a group still running.
test(
  "a record under groups/ that can't be removed, read or checked is kept and reported, and the runner goes on",
  async () => {
    const stateDir = join(root, "state")
    await Effect.runPromise(Workspace.watchGroups(stateDir))
    const groups = join(stateDir, "groups")
    const started = join(root, "started")
    const go = join(root, "go")
    const fake = join(root, "fake-jj")
    writeFileSync(fake, `#!/bin/sh\ntouch "${started}"\nwhile [ ! -f "${go}" ]; do sleep 0.05; done\n`)
    chmodSync(fake, 0o755)
    await withEnv({ SMITHERS_JJ_PATH: fake }, async () => {
      const running = Effect.runPromise(Workspace.jj(["version"], 30_000, undefined, true))
      await until(() => existsSync(started), 10_000)
      expect(readdirSync(groups)).toHaveLength(1)
      // Its record can't be removed when it exits: the command still answers.
      chmodSync(groups, 0o500)
      try {
        writeFileSync(go, "")
        expect((await running).code).toBe(0)
      } finally {
        chmodSync(groups, 0o755)
      }
      expect(readdirSync(groups)).toHaveLength(1)
    })
    // Its process gone, the next start settles the record it kept.
    await Effect.runPromise(Workspace.reapGroups(stateDir))
    expect(readdirSync(groups)).toEqual([])
    const leader = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })
    children.push(leader)
    const record = join(groups, `${leader.pid!}.json`)
    writeFileSync(record, JSON.stringify({ pid: leader.pid, owner: 1 << 30, command: "sleep", startedAt: Date.now() }))
    // The record can't be read.
    chmodSync(record, 0o000)
    try {
      await Effect.runPromise(Workspace.reapGroups(stateDir))
    } finally {
      chmodSync(record, 0o600)
    }
    expect(existsSync(record)).toBe(true)
    expect(alive(leader.pid!)).toBe(true)
    // The process can't be inspected: no `ps` on the path.
    const empty = join(root, "no-tools")
    mkdirSync(empty)
    await withEnv({ PATH: empty }, () => Effect.runPromise(Workspace.reapGroups(stateDir)))
    expect(existsSync(record)).toBe(true)
    expect(alive(leader.pid!)).toBe(true)
    // Both clear: reaped.
    await Effect.runPromise(Workspace.reapGroups(stateDir))
    await until(() => !alive(leader.pid!), 10_000)
    expect(existsSync(record)).toBe(false)
  },
  60_000
)

const children: Array<ChildProcess> = []
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && alive(child.pid)) child.kill("SIGKILL")
  }
})
