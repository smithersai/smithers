// CI jobs in real containers: `ci/job` on the Node host's engine, each job's machine a container of the branch
// sandbox's image (infra/sandbox), checking out one commit of a public GitHub repository by its id with the machine's
// own checkout (worker/branch/Checkout.ts) and running its steps with `docker exec`. Two jobs run on two containers at
// once; one exits 1 and settles failed while its sibling settles passed. Skips only when Docker is absent.
import { spawn, spawnSync } from "node:child_process"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob, type SandboxTools } from "@smthrs/sandbox"
import { Effect, Exit, Layer, Schema } from "effect"
import { sandboxImage } from "../test/sandboxImage.globalSetup.ts"
import { asPerson } from "../test/sandboxPersons.ts"
import { afterAll, describe, expect } from "vitest"
import { WORKSPACE } from "../../src/features/terminal/contract.ts"
import { checkoutArgv } from "../branch/Checkout.ts"
import { noCommands } from "../test/commands.ts"
import { Machines } from "../branch/Machines.ts"
import { CheckoutFailed } from "../branch/Sandboxes.ts"
import { runFlow } from "../test/flowHost.ts"
import * as CiJobMachine from "./CiJobMachine.ts"

const image = sandboxImage
/**
 * Who a job's commands run as in the box: a user of its own in the `workspace` group, as the machine runs the `ci`
 * user's (worker/branch/Users.ts), never root and never the box's own `smithers`, whose idle process keeps it up.
 */
const BOX_USER = "104242:2000"
const docker = (args: ReadonlyArray<string>) => spawnSync("docker", args, { encoding: "utf8" })
const present = docker(["--version"]).status === 0
/** A case whose steps run as `BOX_USER`: broken where Docker can't run that uid (worker/test/sandboxPersons.ts). */
const jobTest = asPerson("docker", BOX_USER, present)

/** A public repository and a commit of it that no branch of it may still point at. */
const REPO = "roninjin10/smithers-github-tests"
const sha = present ? spawnSync("git", ["ls-remote", `https://github.com/${REPO}.git`, "refs/heads/main"], { encoding: "utf8" })
  .stdout.split("\t")[0]! : "0".repeat(40)

const containers = new Map<string, string>()
// Each container announces it reached the concurrent step, then waits on its own stdin. Setup may take
// arbitrarily different amounts of time; only these real running commands release one another.
const ready = new Map<string, () => void>()
const overlaps: Array<ReadonlyArray<string>> = []
afterAll(() => {
  for (const id of containers.values()) docker(["rm", "-f", id])
})

/** `Machines` over one container per branch id: woken by the machine's own checkout, each call a `docker exec`. */
const dockerMachines = Layer.succeed(
  Machines,
  Machines.of({
    commands: () => noCommands,
    tool: (branch, _owner, _callId, call) =>
      Effect.gen(function* () {
        let id = containers.get(branch.branchId)
        if (id === undefined) {
          id = docker(["run", "-d", "--rm", image]).stdout.trim()
          containers.set(branch.branchId, id)
          const cloned = docker(["exec", "--user", BOX_USER, id, ...checkoutArgv(branch.branch, `https://github.com/${branch.owner}/${branch.name}.git`)])
          if (cloned.status !== 0) return yield* Effect.fail(new CheckoutFailed())
        }
        const run = call as typeof SandboxTools.Run.Type
        const ran = yield* Effect.promise(() =>
          new Promise<number>((resolve) => {
            const rendezvous = run.command === "sleep 3" || run.command === "sleep 3; exit 1"
            const command = rendezvous ? `printf 'ci-ready\\n'; read release; ${run.command}` : run.command
            const child = spawn("docker", ["exec", "-i", "--user", BOX_USER, "-w", WORKSPACE, id, "sh", "-c", command])
            let output = ""
            child.stdout.on("data", (chunk: Buffer) => {
              output += chunk.toString()
              if (!rendezvous || !output.includes("ci-ready\n") || ready.has(run.command)) return
              ready.set(run.command, () => child.stdin.end("release\n"))
              if (ready.size === 2) {
                overlaps.push([...ready.keys()])
                for (const release of ready.values()) release()
              }
            })
            child.on("exit", (code) => resolve(code ?? 1))
          })
        )
        return {
          generation: 1,
          result: {
            tool: "run" as const,
            exitCode: ran,
            timedOut: false,
            stdout: "",
            stderr: "",
            stdoutBytes: 0,
            stderrBytes: 0,
            truncated: false,
          },
        }
      }),
    sleepIfIdle: () => Effect.succeed("slept" as const),
  }),
)

const node = CiJob.make("node", {
  steps: [
    { name: "node", run: "node --version" },
    { name: "pnpm", run: "pnpm --version" },
    { name: "wait", run: "sleep 3" },
    // A server a step leaves running: the release stops it.
    { name: "serve", run: "sleep 300 >/dev/null 2>&1 &" },
  ],
})
const broken = CiJob.make("broken", { steps: [{ name: "fail", run: "sleep 3; exit 1" }, { name: "never", run: "true" }] })

const Pipeline = Flow.make("ci/docker-pipeline", {
  payload: { target: CiJob.Target },
  success: Schema.Struct({ node: CiJob.Result, broken: CiJob.Result }),
  body: Node.capture({}, ({ target }: { readonly target: CiJob.Target }) =>
    Node.all({ node: node.call(target), broken: broken.call(target) })),
})

describe.skipIf(!present)("CI jobs in real containers", () => {
  jobTest("two jobs on two machines at once: node and pnpm at the commit pass, a job that exits 1 fails", async () => {
    const target: CiJob.Target = { run: `ci:docker-${Date.now()}`, repo: REPO, sha, ref: "refs/heads/main" }
    const registration = Layer.mergeAll(
      Interpreter.layerWithImplementations(CiJob.CiJob, CiJob.layer),
      Interpreter.layer(Pipeline),
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provide(CiJobMachine.layer),
      Layer.provide(dockerMachines),
    )
    const ran = await runFlow(Pipeline, { target }, registration)
    expect(ran.exit).toEqual(Exit.succeed({
      node: {
        outcome: "passed",
        steps: [
          { name: "checkout", outcome: "passed", exitCode: null },
          { name: "node", outcome: "passed", exitCode: 0 },
          { name: "pnpm", outcome: "passed", exitCode: 0 },
          { name: "wait", outcome: "passed", exitCode: 0 },
          { name: "serve", outcome: "passed", exitCode: 0 },
        ],
      },
      broken: {
        outcome: "failed",
        steps: [
          { name: "checkout", outcome: "passed", exitCode: null },
          { name: "fail", outcome: "failed", exitCode: 1 },
          { name: "never", outcome: "skipped", exitCode: null },
        ],
      },
    }))
    // Both real commands were running, awaiting release, before either could finish.
    expect(overlaps.map((commands) => [...commands].sort())).toEqual([["sleep 3", "sleep 3; exit 1"]])
    // Released: nothing the steps started is left running in either box.
    for (const id of containers.values()) {
      const left = docker(["exec", "--user", "0:0", id, "sh", "-c", "cat /proc/[0-9]*/comm 2>/dev/null"]).stdout
      expect(left.split("\n")).not.toContain("sleep")
    }
    // Two machines, one per job, each at exactly the commit; the image pins Node 26.5 and pnpm 11.25.
    expect(containers.size).toBe(2)
    for (const id of containers.values()) {
      expect(docker(["exec", "-w", WORKSPACE, id, "git", "rev-parse", "HEAD"]).stdout.trim()).toBe(sha)
      expect(docker(["exec", id, "node", "--version"]).stdout.trim()).toBe("v26.5.0")
      expect(docker(["exec", id, "pnpm", "--version"]).stdout.trim()).toBe("11.25.0")
    }
  }, 300_000)
})
