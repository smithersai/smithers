/**
 * The workflow `smithers-ci apply` writes, as a runner runs it: `smthrs ci` started with the shared cache's token
 * in its environment, on a repository whose step looks for that token in every process it can read. Real git, the
 * real program, real `smthrs`, a real cache to send the token to, and real bubblewrap where the machine has it.
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { cli } from "../../src/cli/Cli.vibe"
import { layer } from "../../src/cli/Host.vibe"
import { smthrsCommand } from "../../src/cli/Install.ts"
import { parts } from "../../src/cli/parts.vibe"
import { probe } from "../../src/replay/Jail.ts"
import { git, pathWithout, recorder, remove, spawn, temporary } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
const servers: Array<Server> = []
afterAll(() => {
  made.forEach(remove)
  servers.forEach((server) => server.close())
})

/** A token no other process on this machine holds, in two halves. */
const halves = ["smithers-ci-canary-", randomUUID()] as const
const token = halves.join("")

/**
 * The step. It fails when it finds the token: in its own environment, or in the environment or command line of any
 * process it can read. It fails as well when a program it starts could gain a privilege, as `sudo` does. It names
 * what held the token, never the token. The script holds it in halves, so a search for the whole does not find the
 * script, and reads it from descriptor 3, so no command line of its own holds it.
 */
const look = [
  "#!/bin/bash",
  `canary=${halves[0]}`,
  `canary="$canary"${halves[1]}`,
  "case \"$(env)\" in *\"$canary\"*) echo \"the token is in the step's environment\" >&2; exit 1 ;; esac",
  "set -- /proc/[0-9]*/environ /proc/[0-9]*/cmdline",
  "held=$(grep -alF -f /dev/fd/3 -- \"$@\" 3<<<\"$canary\" 2>/dev/null | head -1)",
  "if [ -n \"$held\" ]; then echo \"the token is in $held\" >&2; exit 1; fi",
  "grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status || { echo 'a program here can gain a privilege' >&2; exit 1; }",
  ""
].join("\n")

const home = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }

/** A repository whose CI is the step, with the files `smithers-ci apply` writes for it. */
const applied = async (): Promise<string> => {
  const root = keep(temporary("runner-token"))
  const workflow = [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  look:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: ./look.sh",
    ""
  ].join("\n")
  git(root, "init", "--quiet", "--initial-branch=main")
  mkdirSync(join(root, ".github", "workflows"), { recursive: true })
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), workflow)
  writeFileSync(join(root, "look.sh"), look)
  chmodSync(join(root, "look.sh"), 0o755)
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", "c1")
  const sink = recorder()
  const code = await Effect.runPromise(
    cli(["apply"], root, parts).pipe(
      Effect.provide(layer(home)),
      Effect.provideService(Console.Console, sink.service as never)
    ) as Effect.Effect<number>
  )
  expect(code, sink.stderr()).toBe(0)
  return root
}

/** A shared cache on this machine that holds nothing and takes everything. It keeps the credential of each request. */
const cache = async () => {
  const sent: Array<string> = []
  const server = createServer((request, response) => {
    sent.push(request.headers.authorization ?? "")
    request.resume().on("end", () => {
      response.statusCode = request.method === "PUT" ? 201 : 404
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent }
}

/** The command the workflow runs, with this checkout's `smthrs` where the workflow installs a published one. */
const asTheWorkflowRuns = (root: string, url: string, searchPath: string) => {
  const written = readFileSync(join(root, ".github", "workflows", "smithers-ci.yml"), "utf8")
  // The workflow gives the step the token in its environment, and runs every target.
  const steps = (parseYaml(written) as {
    readonly jobs: { readonly ci: { readonly steps: ReadonlyArray<{ readonly run?: string; readonly env?: object }> } }
  }).jobs.ci.steps
  const ci = steps.find((one) => String(one.run).includes("smthrs ci"))
  expect(ci?.run).toContain("smthrs ci '//...'")
  expect((ci?.env as Record<string, string>)["SMITHERS_CACHE_TOKEN"]).toMatch(/^\$\{\{ /)
  return spawn(smthrsCommand()[1] as string, ["ci", "//...", "--ui", "plain"], root, {
    HOME: home.HOME,
    PATH: searchPath,
    SMITHERS_CACHE_URL: url,
    SMITHERS_CACHE_TOKEN: token
  })
}

const jailable = !("refusal" in probe())

describe.skipIf(process.platform !== "linux")("a step of the generated workflow, run with the cache's token", () => {
  it.skipIf(!jailable)(
    "finds the token in no process, gains no privilege, and the cache is sent the token",
    async () => {
      const root = await applied()
      const shared = await cache()
      const outcome = await asTheWorkflowRuns(root, shared.url, process.env["PATH"] as string)

      expect(outcome.code, `${outcome.stdout}\n${outcome.stderr}`).toBe(0)
      expect(shared.sent).toContain(`Bearer ${token}`)
    },
    900_000
  )

  it("reads the token from the program that started it on a machine without bubblewrap", async () => {
    const root = await applied()
    const shared = await cache()
    const outcome = await asTheWorkflowRuns(root, shared.url, pathWithout("bwrap", keep(temporary("path"))))

    expect(outcome.code).not.toBe(0)
    expect(`${outcome.stdout}\n${outcome.stderr}`).toMatch(/the token is in \/proc\/\d+\/environ/)
  }, 900_000)
})
