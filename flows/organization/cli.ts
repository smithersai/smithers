/**
 * `node flows/organization/cli.ts <command>`: the organization's commands.
 *
 * Every command is a {@link Command} in {@link registry}: `serve` runs the
 * host, `submit`, `status`, and `answer` talk to a running host over its
 * loopback control RPC, and the setup commands (`init`, `doctor`) come from
 * `setup/index.ts`. A command resolves its exit code; nothing here exits the
 * process but the entry point at the bottom.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import * as Actions from "../../packages/smithers/agent/organization/src/Actions.ts"
import { cliKey, operations, rpc } from "./client.ts"
import { defaultPort, environmentOf, resolve } from "./settings.ts"
import { commands as setupCommands, type Command, type Io, processIo } from "./setup/index.ts"
import { absolute, loadOrganization } from "./setup/settings.ts"

export type { Command, Io }

/** The loopback address of the host a client command talks to. */
const hostOf = (values: { readonly host?: string | undefined; readonly port?: string | undefined }, env: Io["env"]) =>
  `http://${values.host ?? "127.0.0.1"}:${values.port ?? env.SMITHERS_ORG_PORT ?? defaultPort}`

const clientOptions = { host: { type: "string" }, port: { type: "string" } } as const

/** `serve`: the host, standalone, in the foreground. */
export const serve: Command = {
  name: "serve",
  usage:
    "serve [--standalone] [--root <dir containing Org/>] [--state-dir <dir>] [--repo <name=path>]... [--check <name=command>]... [--max-rounds <n>] [--port <port>]",
  run: async (argv, io) => {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        standalone: { type: "boolean", default: false },
        root: { type: "string" },
        "state-dir": { type: "string" },
        repo: { type: "string", multiple: true },
        check: { type: "string", multiple: true },
        "max-rounds": { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        "env-file": { type: "string" }
      }
    })
    const environment = environmentOf(values, io.env, io.cwd)
    const settings = await resolve(values, environment, io.cwd)
    const [{ platform }, { NodeRuntime }, { start }] = await Promise.all([
      import("../../packages/smithers/src/internal/NodeControlHost.ts"),
      import("@effect/platform-node"),
      import("./serve.ts")
    ])
    NodeRuntime.runMain(await start({ settings, environment, platform, log: io.err }))
    return await new Promise<number>(() => {})
  }
}

/** `submit "<task>"`: starts a request and prints its run; `--wait` waits for it to settle. */
export const submit: Command = {
  name: "submit",
  usage: "submit \"<task>\" [--repo <name>] [--key <key>] [--wait [--root <dir containing Org/>]] [--port <port>]",
  run: async (argv, io) => {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        ...clientOptions,
        repo: { type: "string" },
        key: { type: "string" },
        wait: { type: "boolean", default: false },
        root: { type: "string" },
        "state-dir": { type: "string" }
      }
    })
    const text = positionals.join(" ").trim()
    if (text === "") {
      io.err(`usage: ${submit.usage}`)
      return 2
    }
    const ops = operations(rpc(hostOf(values, io.env)))
    const key = cliKey(values.key)
    const started = await ops.submit({
      key,
      text,
      source: "cli",
      ...(values.repo === undefined ? {} : { repository: values.repo })
    })
    io.out(`${started.joined ? "joined" : "started"} ${started.runId}`)
    if (!values.wait) return 0
    const asked = new Set<string>()
    for (;;) {
      const run = (await ops.runs({ runId: started.runId }))[0]
      if (run !== undefined && ["completed", "failed", "cancelled"].includes(run.status)) {
        io.out(`${run.runId} ${run.status}`)
        const root = values.root ?? environmentOf(values, io.env, io.cwd).SMITHERS_ORG_ROOT
        const found = root === undefined ? undefined : await receiptOf(absolute(io.cwd, root), key)
        if (found !== undefined) io.out(`${found.status}: ${found.summary}\nreceipt ${found.path}`)
        return run.status === "completed" ? 0 : 1
      }
      for (const gate of run?.gates ?? []) {
        if (asked.has(gate.subjectDigest)) continue
        asked.add(gate.subjectDigest)
        io.out(`waiting on gate ${gate.gateId}: answer ${gate.gateId} approve|decline`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
}

/** The delivery receipt a request's key names under `root`, when it was written. */
const receiptOf = async (root: string, key: string) => {
  const organization = await loadOrganization(root).catch(() => undefined)
  if (organization === undefined) return undefined
  const path = join(organization.loaded.organization.wiki.generatedDir, Actions.runDirectory(key), "deliver.json")
  const text = await readFile(join(root, path), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const report = (JSON.parse(text) as { readonly report?: { readonly status?: string; readonly summary?: string } }).report
  return { path, status: report?.status ?? "unknown", summary: report?.summary ?? "" }
}

/** Waits until a run settles and resolves its status. */
const settle = async (ops: ReturnType<typeof operations>, runId: string): Promise<string> => {
  for (;;) {
    const run = (await ops.runs({ runId }))[0]
    if (run !== undefined && ["completed", "failed", "cancelled"].includes(run.status)) return run.status
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

/** `status`: every organization run and the gates it waits on; `--write` also rewrites the status page. */
export const status: Command = {
  name: "status",
  usage: "status [--run <id>] [--write] [--port <port>]",
  run: async (argv, io) => {
    const { values } = parseArgs({
      args: [...argv],
      options: { ...clientOptions, run: { type: "string" }, write: { type: "boolean", default: false } }
    })
    const ops = operations(rpc(hostOf(values, io.env)))
    if (values.write) {
      const started = await ops.writeStatus()
      const settled = await settle(ops, started.runId)
      io.out(`status page ${settled === "completed" ? "written" : settled} by ${started.runId}`)
      if (settled !== "completed") return 1
    }
    const runs = await ops.runs(values.run === undefined ? {} : { runId: values.run })
    for (const run of runs) {
      io.out(`${run.runId}  ${run.flowId}  ${run.status}`)
      for (const gate of run.gates) io.out(`  gate ${gate.gateId} ${gate.subjectDigest.slice(0, 16)}: ${gate.prompt.split("\n")[0]}`)
    }
    if (runs.length === 0) io.out("no runs")
    return 0
  }
}

/** `answer <gate> approve|decline`: answers an approval gate a run is parked on. */
export const answer: Command = {
  name: "answer",
  usage: "answer <gate> approve|decline [--run <id>] [--reason <text>] [--port <port>]",
  run: async (argv, io) => {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { ...clientOptions, run: { type: "string" }, reason: { type: "string" } }
    })
    const [gateId, choice] = positionals
    if (gateId === undefined || (choice !== "approve" && choice !== "decline")) {
      io.err(`usage: ${answer.usage}`)
      return 2
    }
    const gate = await operations(rpc(hostOf(values, io.env))).answer({
      gateId,
      approved: choice === "approve",
      runId: values.run,
      reason: values.reason
    })
    io.out(`${choice === "approve" ? "approved" : "declined"} ${gate.gateId} for ${gate.runId}`)
    return 0
  }
}

/** Every command, by name. */
export const registry: ReadonlyMap<string, Command> = new Map(
  [serve, submit, status, answer, ...setupCommands].map((command) => [command.name, command])
)

/** Runs one command line against the registry and resolves its exit code. */
export const main = async (argv: ReadonlyArray<string>, io: Io = processIo()): Promise<number> => {
  const [name, ...rest] = argv
  const command = name === undefined ? undefined : registry.get(name)
  if (command === undefined) {
    for (const candidate of registry.values()) io.err(`usage: ${candidate.usage}`)
    return 2
  }
  try {
    return await command.run(rest, io)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
